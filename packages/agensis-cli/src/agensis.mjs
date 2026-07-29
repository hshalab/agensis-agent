import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import WebSocket from "ws";
import { createExecutor } from "./executor.mjs";
import { runCli } from "./cli.mjs";
import {
  ampFailureError,
  assertAmpRepo,
  buildAmpCommand,
  createAmpError,
  createAmpStreamTracker,
  isAmpJob,
  probeAmpRuntime,
  validAmpThreadId,
} from "./ampRuntime.mjs";
import { summarizeToolInput } from "./connectionExecutors.mjs";
import { createPermissionBroker } from "./permissions.mjs";
import { createQueue } from "./queue.mjs";
import { stopFromAmpResult } from "./stopReasons.mjs";
import { createSessionSlots } from "./sessionSlots.mjs";
import { startCursorBuddyLocalBridge } from "./cursorbuddyLocalBridge.mjs";
import { deriveMemoryRoot, snapshotMemory, memoryFingerprint } from "./memory.mjs";
import { detectCommandEntries, detectSkillNames } from "./slashEnum.mjs";
import { skillsFingerprint, snapshotSkills } from "./skills.mjs";
import { loadSharedModelConfig, runSharedInference, sharedModelAdvertisements } from "./sharedInference.mjs";
import { handleBridgeFrame, stopAllBridges } from "./bridges.mjs";
import {
  writeAgentMirror,
  writeHeartbeatFile,
  writeHeartbeatFileSync,
  readAgentStatus,
  readAgentIdentity,
  identityFilePath,
  statusFilePath,
  ensureHeartbeatMd,
  heartbeatMdPath,
  readHeartbeatMd,
  resolveStateDir,
} from "./state.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// The IDLE deadline: how long a turn may produce nothing at all before the
// daemon stops it. Distinct from DEFAULT_TIMEOUT_MS above, which is the hard
// ceiling on a turn that is working the whole time.
//
// 9 minutes is deliberately just INSIDE the server's 10-minute content-silence
// reaper (AGENT_JOB_IDLE_REAP_MINUTES in server/agent-jobs.cjs). Only the daemon
// can actually stop the work; the server can only rewrite the row. Letting the
// server win first means telling the human "it stopped responding" while a CLI
// keeps running on someone's laptop for another twenty minutes. Letting the
// daemon win first means the turn really is over and we can say WHY.
//
// These two numbers are a pair in two different repos. Moving either one without
// the other silently inverts which side decides — hence the named constant and
// this comment on both sides.
const DEFAULT_IDLE_TIMEOUT_MS = 9 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 15 * 1000;
// How many conversations may run at once. Each DM / channel / thread is its own
// serial lane; this caps how many lanes run in parallel so we never spawn an
// unbounded number of coding-CLI subprocesses. Override with --max-concurrency.
const DEFAULT_MAX_CONCURRENCY = 2;
// How many warm sessions one silo (workspace+agent) may hold at once.
//
// DEFAULT 1 = today's behaviour, exactly: every lane shares one sessionKey and
// one connection, which is what a daemon does now. Raising it is what makes
// --max-concurrency mean anything (see sessionSlots.mjs for why it is currently
// a no-op), and it also stops conversations sharing one runtime history — a
// visible change, so it is opt-in for a release.
const DEFAULT_SESSION_SLOTS = 1;
const LEAN_PROMPT_MAX_BYTES = 10 * 1024;
const DEFAULT_MODEL = "claude-opus-4-8";
export const AGENSIS_CLI_VERSION = "0.1.45";

export async function runAgensisDaemon(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  config.sharedModels = config.share
    ? await loadSharedModelConfig(config.sharedModelsFile)
    : [];
  let stopped = false;
  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let fileHeartbeatTimer = null;
  let acceptedJobCount = 0;
  let resolveWait = null;
  let queue = null;
  let lastSocketErrorCode = '';
  let cursorBuddyBridge = null;
  let socketRegistered = false;
  let registeredConnection = null;
  const activeInference = new Map();

  // Interactive tool approvals. The send closure reads the LIVE `ws` rather than
  // capturing one, because a reconnect swaps the socket underneath every parked
  // request; a request whose delivery fails is denied on the spot rather than
  // parked against a socket nobody is listening on.
  const permissions = createPermissionBroker({
    send: (frame) => send(ws, frame),
    log,
  });

  // How long parked approvals wait for a reconnect before giving up on it.
  //
  // Matched to the hub's own reconnect grace (JOB_RECONNECT_GRACE_MS, 45s): past
  // that point the server has expired the request and failed the job anyway, so
  // holding the turn open for the remaining minutes of the request's TTL just
  // makes the agent look hung. We reconnect every 2s, so this only ever fires
  // when the daemon is genuinely cut off.
  const PERMISSION_RECONNECT_GRACE_MS = 45_000;
  let permissionReconnectTimer = null;

  const cancelPermissionReconnectDeadline = () => {
    if (!permissionReconnectTimer) return;
    clearTimeout(permissionReconnectTimer);
    permissionReconnectTimer = null;
  };

  // Armed on socket close, cancelled by a successful register. Without it, the
  // parks that now survive a drop would survive a permanent outage too.
  const armPermissionReconnectDeadline = () => {
    if (permissionReconnectTimer || permissions.pendingCount() === 0) return;
    permissionReconnectTimer = setTimeout(() => {
      permissionReconnectTimer = null;
      permissions.shutdown("The connection to Agensis stayed down, so this could not be approved. Ask again in the chat.");
    }, PERMISSION_RECONNECT_GRACE_MS);
    permissionReconnectTimer.unref?.();
  };

  // Results that had nowhere to go because the socket was gone when the turn
  // finished. A dropped socket does NOT stop the work: the CLI subprocess runs to
  // completion, and before this its answer went straight into send()'s
  // `readyState !== OPEN` early return and was lost — the daemon logged "Finished
  // job" while the human was told the agent stopped responding. Park the frame and
  // re-send it once we are registered again; the hub matches results on
  // (jobId, agentId, workspaceId), not on the connection they arrive over.
  const parkedResults = [];
  const parkResult = (frame) => {
    // Bounded: a daemon that can never reconnect must not grow this forever.
    if (parkedResults.length >= 32) parkedResults.shift();
    parkedResults.push(frame);
    log(`Socket was gone — parked the result for job ${frame.jobId} to re-send on reconnect`);
  };
  const flushParkedResults = () => {
    if (parkedResults.length === 0) return;
    for (const frame of parkedResults.splice(0, parkedResults.length)) {
      if (send(ws, frame)) {
        log(`Re-sent the result for job ${frame.jobId} after reconnecting`);
      } else {
        parkedResults.push(frame);
      }
    }
  };

  // --- Agent-mesh (F1/F5/F6/F7): opt-in LAN listener + peer ticket/list plumbing for
  // direct daemon-to-daemon job handoff. Every human<->agent turn stays hub-relayed
  // (unchanged above); this is scoped to daemon-initiated agent-to-agent collaboration
  // only. Local (closure) state, not module-level, since it needs `queue` and the live
  // hub `ws` to run a handed-off job and report its result back to the hub.
  let lanServer = null;
  let lanReach = { transport: "ws", listening: false, addrs: [], auth: "hub-pairwise" };
  const peerGrants = new Map(); // ticket -> { fromAgentId, exp } — grants WE were given, as callee
  const peerTicketWaiters = new Map(); // targetAgentId -> [{ resolve, reject }]
  let peerListWaiters = [];
  const currentReach = () => lanReach;
  const cursorBuddyBridgeConnection = () => ({
    connected: socketRegistered && Boolean(config.cursorBuddyRuntime),
    mode: config.cursorBuddyRuntime ? "agensis-cli" : "agensis-cli-unclaimed",
    agentId: registeredConnection?.agentId || registeredConnection?.agent_id || config.agent,
    workspaceId: registeredConnection?.workspaceId || registeredConnection?.workspace_id || config.workspace,
    agensisUrl: config.url,
    handle: registeredConnection?.handle || config.handle,
    name: registeredConnection?.name || config.name,
    cwd: config.cwd,
    updatedAt: new Date().toISOString(),
  });

  const startLanListener = () => {
    if (lanServer || !config.lanListener) return;
    lanServer = new WebSocket.Server({ port: 0 });
    lanServer.on("listening", () => {
      const { port } = lanServer.address();
      lanReach = { transport: "ws", listening: true, addrs: lanAddrs(port), auth: "hub-pairwise" };
      log(`Agent-mesh LAN listener on port ${port}`);
      void pushCapabilitiesSnapshot(ws, config, currentReach());
    });
    lanServer.on("connection", (socket) => {
      let authed = false;
      const authTimer = setTimeout(() => {
        if (!authed) { try { socket.close(1008, "peer auth required"); } catch { /* already closing */ } }
      }, 5000);
      socket.once("message", (raw) => {
        clearTimeout(authTimer);
        const frame = parseMessage(raw);
        const grant = frame?.type === "peer_auth" ? peerGrants.get(frame.ticket) : null;
        if (!grant || grant.fromAgentId !== frame.fromAgentId || Date.now() > grant.exp) {
          try { socket.close(1008, "invalid ticket"); } catch { /* already closing */ }
          return;
        }
        peerGrants.delete(frame.ticket); // single-use
        authed = true;
        socket.on("message", (raw2) => {
          const peerMessage = parseMessage(raw2);
          if (peerMessage?.type === "agent_job" && peerMessage.job?.id) {
            const result = queue.enqueue({ ...peerMessage.job, key: peerMessage.job.id, lane: laneKeyForJob(peerMessage.job), ws });
            if (result.accepted) log(`Queued peer-handoff job ${peerMessage.job.id} from ${frame.fromAgentId}`);
          }
        });
      });
    });
    lanServer.on("error", (error) => log(`LAN listener error: ${error?.message || error}`));
  };

  const stopLanListener = () => {
    if (lanServer) {
      try { lanServer.close(); } catch { /* already closing */ }
      lanServer = null;
    }
    lanReach = { transport: "ws", listening: false, addrs: [], auth: "hub-pairwise" };
  };

  // Ask the hub for a single-use ticket to reach `targetAgentId` directly.
  const requestPeerTicket = (targetAgentId) => new Promise((resolve, reject) => {
    if (!send(ws, { action: "peer_ticket_request", targetAgentId })) {
      reject(new Error("hub socket not open"));
      return;
    }
    const list = peerTicketWaiters.get(targetAgentId) || [];
    list.push({ resolve, reject });
    peerTicketWaiters.set(targetAgentId, list);
    setTimeout(() => {
      const pending = peerTicketWaiters.get(targetAgentId) || [];
      const idx = pending.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) {
        pending.splice(idx, 1);
        reject(new Error("peer ticket request timed out"));
      }
    }, 10_000);
  });

  // Ask the hub for live, direct-reachable peers in this workspace.
  const requestPeerList = () => new Promise((resolve, reject) => {
    if (!send(ws, { action: "peer_list_request" })) {
      reject(new Error("hub socket not open"));
      return;
    }
    peerListWaiters.push(resolve);
    setTimeout(() => {
      const idx = peerListWaiters.indexOf(resolve);
      if (idx >= 0) {
        peerListWaiters.splice(idx, 1);
        resolve([]); // never hang a caller — treat a stalled reply as "no direct peers"
      }
    }, 10_000);
  });

  // Hand a job off directly to a peer daemon (agent-to-agent collaboration only — a
  // human<->agent turn is never routed this way, see the hub dispatch above). Returns
  // true if the job was handed off over the peer's LAN listener; false means the caller
  // should fall back to the existing hub relay (no reach, listening:false, ticket
  // rejected, network unreachable, etc.) — whichever path carries the work, the
  // executing daemon still reports back over the hub via agent_job_result.
  // NOTE: the hub's handleAgentJobResult looks up an existing agent_jobs row by
  // (jobId, agentId, workspaceId) before finalizing — a caller of this function is
  // responsible for having the hub create that row (its normal source-of-truth path)
  // before jobPayload.id is handed to the peer, otherwise the peer's eventual
  // agent_job_result is safely dropped ("Agent job not found") rather than recorded.
  const handoffJobToPeer = async (targetAgentId, jobPayload) => {
    let peerSocket = null;
    try {
      const peers = await requestPeerList();
      const peer = peers.find((p) => p.agentId === targetAgentId && p.reach?.listening && p.reach.addrs?.length);
      if (!peer) return false;
      const grant = await requestPeerTicket(targetAgentId);
      const addr = grant.peer?.addrs?.[0] || peer.reach.addrs[0];
      if (!addr?.host || !addr?.port) return false;
      peerSocket = new WebSocket(`ws://${addr.host}:${addr.port}`);
      await new Promise((resolve, reject) => {
        peerSocket.once("open", resolve);
        peerSocket.once("error", reject);
        setTimeout(() => reject(new Error("peer connect timed out")), 5000);
      });
      send(peerSocket, { type: "peer_auth", ticket: grant.ticket, fromAgentId: config.agent });
      send(peerSocket, { type: "agent_job", job: jobPayload });
      return true;
    } catch (error) {
      log(`Peer handoff to ${targetAgentId} failed, falling back to hub relay: ${error?.message || error}`);
      return false;
    } finally {
      try { peerSocket?.close(); } catch { /* already closing */ }
    }
  };

  const stop = () => {
    stopped = true;
    abortInferenceRequests(activeInference);
    cancelPermissionReconnectDeadline();
    permissions.shutdown("The agent daemon shut down before this was approved.");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (fileHeartbeatTimer) clearInterval(fileHeartbeatTimer);
    if (cursorBuddyBridge) {
      void cursorBuddyBridge.close().catch(() => { });
      cursorBuddyBridge = null;
    }
    stopLanListener();
    // Leave the last-known ts in place, but mark the daemon stopped so a watchdog reading
    // heartbeat.json sees an intentional shutdown rather than inferring death from a stale
    // timestamp. Sync so it lands before any process.exit races us.
    writeHeartbeatFileSync(config, { status: "stopped", connected: false });
    try {
      ws?.close();
    } catch {
      // ignore close races
    }
    if (resolveWait) resolveWait();
  };

  queue = createQueue({
    // --once is a one-shot: keep it strictly serial so we run exactly one job
    // then drain. Otherwise run conversations in parallel up to the cap.
    concurrency: config.once ? 1 : config.maxConcurrency,
    runJob: async (job, ctx) => {
      await runAgentJob(config, job, { ...ctx, requestPermission: permissions.request });
      if (config.once) stop();
    },
  });

  if (config.cursorBuddyBridge) {
    try {
      cursorBuddyBridge = await startCursorBuddyLocalBridge(config, {
        port: config.cursorBuddyPort,
        authSecret: config.cursorBuddyBridgeSecret || undefined,
        log,
        connectionProvider: cursorBuddyBridgeConnection,
      });
      // Keep the secret on config so native control POSTs can authenticate.
      if (cursorBuddyBridge?.secret) {
        config.cursorBuddyBridgeSecret = cursorBuddyBridge.secret;
      }
    } catch (error) {
      if (isAddressInUseError(error)) {
        const existing = await probeExistingCursorBuddyBridge(config.cursorBuddyPort);
        if (existing?.ok) {
          const pid = existing.pid ? ` pid ${existing.pid}` : "";
          log(`CursorBuddy local bridge already running on http://127.0.0.1:${config.cursorBuddyPort}${pid}`);
        } else {
          log(`CursorBuddy local bridge port ${config.cursorBuddyPort} is in use but did not answer health`);
        }
      } else {
        log(`CursorBuddy local bridge unavailable: ${error?.message || error}`);
      }
      cursorBuddyBridge = null;
    }
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const connect = () => {
    if (stopped) return;
    const url = socketUrl(config.url, config.token, config);
    lastSocketErrorCode = '';
    log(`Connecting to ${url.replace(config.token, "redacted")}`);
    ws = new WebSocket(url);

    ws.on("open", async () => {
      socketRegistered = false;
      registeredConnection = null;
      log(`Connected. Registering @${config.handle || "agent"} from ${config.cwd}`);
      // F14: authenticate via a first frame so the aga_ token never rides the WS
      // URL query (proxy/access logs). Server path (2) verifies agent tokens here.
      send(ws, { type: "auth", token: config.token });
      // Self-declared identity from the operator/agent-owned identity.json, read
      // fresh on EVERY connect so edits land on the next reconnect. Missing or
      // malformed file = no identity key at all, exactly the old frame. The server
      // (applyAgentIdentity) is the enforcement point: it caps fields, ignores
      // `name` for existing agents, and lets a human's explicit choice win — so
      // declaring on every connect is safe by design.
      const identity = await readAgentIdentity(config);
      send(ws, {
        action: "agent_register",
        workspaceId: config.workspace,
        agentId: config.agent,
        handle: config.handle,
        name: config.name,
        host: os.hostname(),
        cwd: config.cwd,
        // Tool calls this process is STILL parked on, so a reconnect after a blip
        // keeps them alive instead of losing them. Only this process can name
        // these ids, which is what lets the server tell a reconnecting daemon
        // apart from a restarted one — see permissions.parkedRequestIds().
        permissionRequestIds: permissions.parkedRequestIds(),
        ...(identity ? { identity } : {}),
        metadata: {
          codingCmd: config.codingCmd,
          model: config.model,
          permissionMode: config.permissionMode,
          permissionFlags: permissionFlagsForMode(config.permissionMode),
          once: config.once,
          runtime: "agensis",
          executionRuntime: config.runtime,
          version: AGENSIS_CLI_VERSION,
        },
      });
      heartbeatTimer = setInterval(() => {
        // Carry the current capability/memory drift hashes alongside the liveness
        // beat. They ride as distinct top-level fields (NOT inside metadata, which the
        // server merges into the persisted row) so the server can compare them against
        // the last synced values without persisting an unconfirmed candidate hash. On a
        // mismatch the server nudges a full re-push, keeping the agents list fresh.
        // Also fold in the agent-owned status.json (its self-declared status/note) so a
        // running agent can update how it appears without any extra transport.
        void Promise.all([
          computeCapabilities(config, currentReach()).catch(() => null),
          readAgentStatus(config).catch(() => null),
        ]).then(([caps, agentStatus]) => {
          send(ws, {
            action: "agent_heartbeat",
            // skillsHash is omitted entirely when body sync is off — the server only
            // nudges on a hash it was actually sent, so an opted-out daemon is never
            // asked for bodies and never blocked for not having them.
            ...(caps ? { capabilitiesHash: caps.capabilitiesHash, memoryHash: caps.memoryHash } : {}),
            ...(caps?.skillsHash ? { skillsHash: caps.skillsHash } : {}),
            metadata: heartbeatMetadata(
              config,
              queue,
              agentStatus,
              canHandleCursorBuddyControlJobs(config) ? cursorBuddyBridge?.getContext?.() : null,
              activeInference,
            ),
          });
        });
      }, config.heartbeatMs);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
    });

    ws.on("message", (data) => {
      const message = parseMessage(data);
      if (!message) return;
      if (message.type === "agent_registered") {
        socketRegistered = true;
        registeredConnection = message.connection || message.agent || null;
        applyAgentConfig(config, message.agent);
        // Before anything else on a reconnect: hand back any turn that finished
        // while we had no socket, so the hub can settle it instead of reaping it.
        flushParkedResults();
        // Then settle the tool calls that are still waiting on a human. The server
        // names the ones it re-homed onto this connection; every other parked
        // request is denied on the spot, because its card is gone and no decision
        // can reach us. An older server sends no such field, which reads as "none"
        // and reproduces the pre-existing deny-on-drop behaviour.
        cancelPermissionReconnectDeadline();
        permissions.resume(message.resumedPermissionRequests);
        log(`Registered as ${message.connection?.name || config.name} on ${message.connection?.host || os.hostname()}`);
        if (config.onRegistered) {
          void Promise.resolve(config.onRegistered(config, message)).catch((error) => {
            log(`Profile save failed: ${error?.message || error}`);
          });
        }
        void writeAgentMirror(config, message.agent).catch(() => { });
        // Seed heartbeat.md (what to do on each beat) if it doesn't exist yet; never
        // clobbers an existing file, so human/agent edits persist across restarts.
        void ensureHeartbeatMd(config).catch(() => { });
        void pushMemorySnapshot(ws, config);
        void pushSkillSnapshot(ws, config);
        // The listener persists across reconnects (only the ws reconnects), so this is
        // idempotent — a no-op once it's already running.
        startLanListener();
        void pushCapabilitiesSnapshot(ws, config, currentReach());
        return;
      }
      if (message.type === "agent_config") {
        applyAgentConfig(config, message.agent);
        log(`Updated config for @${config.handle || "agent"}: model=${config.model}, permission=${config.permissionMode}`);
        void writeAgentMirror(config, message.agent).catch(() => { });
        return;
      }
      if (message.type === "agent_memory_refresh") {
        void pushMemorySnapshot(ws, config);
        // Re-push capabilities too so the server's stored memoryHash advances to match
        // the freshly-synced palace; otherwise the heartbeat drift-check would keep
        // nudging a memory refresh every beat.
        void pushCapabilitiesSnapshot(ws, config, currentReach());
        return;
      }
      if (message.type === "agent_capabilities_refresh") {
        void pushCapabilitiesSnapshot(ws, config, currentReach());
        return;
      }
      if (message.type === "agent_skills_refresh") {
        // No capabilities re-push needed here (unlike the memory case above):
        // handleAgentSkillSync advances the stored skillsHash itself, so the drift
        // resolves on this one frame instead of looping on every beat.
        void pushSkillSnapshot(ws, config);
        return;
      }
      if (message.type === "agent_inference_cancel") {
        activeInference.get(String(message.requestId || ""))?.abort();
        return;
      }
      if (message.type === "agent_job_cancel") {
        const jobId = String(message.jobId || "");
        if (jobId) {
          // Deny first: a turn parked on an approval is not watching its abort
          // signal, so cancelling the queue entry alone leaves it waiting on a
          // question whose answer stopped mattering.
          permissions.cancelJob(jobId, message.reason || "Cancelled by Agensis");
          if (queue.cancel(jobId, message.reason || "Cancelled by Agensis")) {
            log(`Cancelled job ${jobId}`);
          }
        }
        return;
      }
      if (message.type === "agent_permission_decision") {
        permissions.decide(message);
        return;
      }
      if (message.type === "agent_inference_request" && message.requestId) {
        const requestId = String(message.requestId);
        const selected = config.sharedModels.find((model) => model.id === message.model);
        const activeForModel = [...activeInference.values()].filter((entry) => entry.model === message.model).length;
        if (!selected) {
          send(ws, { action: "agent_inference_error", requestId, error: `Shared model '${message.model || ""}' is not available.` });
          return;
        }
        if (activeForModel >= selected.maxConcurrency) {
          send(ws, { action: "agent_inference_error", requestId, error: "Shared model is at capacity.", code: "capacity_exhausted" });
          return;
        }
        const controller = new AbortController();
        activeInference.set(requestId, { abort: () => controller.abort(), model: selected.id });
        send(ws, { action: "agent_heartbeat", metadata: heartbeatMetadata(config, queue, null, null, activeInference) });
        void runSharedInference({
          models: config.sharedModels,
          request: message,
          signal: controller.signal,
          send: (event) => send(ws, event),
        }).catch((error) => {
          send(ws, {
            action: "agent_inference_error",
            requestId,
            error: controller.signal.aborted ? "Inference cancelled." : error?.message || String(error),
            code: controller.signal.aborted ? "cancelled" : "inference_failed",
          });
        }).finally(() => {
          activeInference.delete(requestId);
          send(ws, { action: "agent_heartbeat", metadata: heartbeatMetadata(config, queue, null, null, activeInference) });
        });
        return;
      }
      // Channel bridges whose transport cannot run on a server: WhatsApp and
      // Signal link as companion DEVICES holding account keys, and an OpenClaw
      // gateway listens on 127.0.0.1. All three run here; the hub only ever
      // sends bridge_send and receives bridge_inbound / bridge_status.
      //
      // The emit closure reads the LIVE `ws` rather than capturing one, because
      // a reconnect swaps the socket underneath a long-lived bridge — the same
      // reason the permission broker takes a live sender.
      if (message.type === "bridge_start" || message.type === "bridge_send" || message.type === "bridge_stop") {
        void handleBridgeFrame(
          { ...message, action: message.type },
          (frame) => send(ws, frame),
        );
        return;
      }
      // --- Agent-mesh (F5/F6/F7) wire, mirrored from the hub's peer_ticket_request /
      // peer_list_request handlers in server/index.cjs ---
      if (message.type === "peer_ticket") {
        // Response to OUR requestPeerTicket() call — resolve the oldest waiter for
        // this target (requests are FIFO per target, matching hub single-use tickets).
        const targetAgentId = message.peer?.agentId;
        const waiters = peerTicketWaiters.get(targetAgentId) || [];
        const waiter = waiters.shift();
        if (waiters.length) peerTicketWaiters.set(targetAgentId, waiters);
        else peerTicketWaiters.delete(targetAgentId);
        if (waiter) waiter.resolve(message);
        return;
      }
      if (message.type === "peer_ticket_grant") {
        // The hub pushed us a grant because some peer A wants to reach us directly —
        // hold it until A's socket presents the matching ticket as its first frame.
        peerGrants.set(message.ticket, { fromAgentId: message.fromAgentId, exp: message.exp });
        return;
      }
      if (message.type === "peer_list") {
        const resolve = peerListWaiters.shift();
        if (resolve) resolve(Array.isArray(message.peers) ? message.peers : []);
        return;
      }
      if (message.type === "agent_reach_disable") {
        // Hub-side kill switch (F6) — overrides our own --lan opt-in.
        stopLanListener();
        void pushCapabilitiesSnapshot(ws, config, currentReach());
        return;
      }
      if (message.type === "error") {
        log(`Server rejected request: ${message.message || "unknown error"}`);
        return;
      }
      if (message.type === "agent_disabled") {
        socketRegistered = false;
        registeredConnection = null;
        log(`Agent disabled by Agensis: ${message.reason || "deactivated"}`);
        stop();
        return;
      }
      if (message.type === "agent_job" && message.job?.id) {
        const result = queue.enqueue({
          ...message.job,
          key: message.job.id,
          lane: laneKeyForJob(message.job),
          // LIVE socket, not the one captured at enqueue time. A reconnect swaps
          // `ws` underneath a turn that is still executing, and the answer has to
          // go to the socket that exists when the turn ENDS. Same reasoning as the
          // permission broker's send closure above.
          get ws() { return ws; },
          parkResult,
        });
        if (result.accepted) {
          acceptedJobCount += 1;
          log(`Queued job ${message.job.id} at position ${result.position}`);
          if (config.once) {
            void queue.idle().then(() => stop());
          }
        }
      }
    });

    ws.on("close", (code, reason) => {
      abortInferenceRequests(activeInference);
      // Parked permission requests deliberately SURVIVE this, the same way
      // parkedResults does. The turn holding them is still executing inside the
      // CLI subprocess; denying on close refused tool calls that had minutes of
      // TTL left because the socket blipped for two seconds. The register frame
      // below re-asserts their ids and `agent_registered` tells us which ones the
      // server kept — anything it did not keep is denied there, not here. The
      // deadline is the backstop for a reconnect that never lands.
      armPermissionReconnectDeadline();
      socketRegistered = false;
      registeredConnection = null;
      const closeReason = String(reason || "");
      log(`Socket closed (${code || "no-code"}${closeReason ? `: ${closeReason}` : ""})`);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (code === 1008 && /agent deactivated|authentication failed/i.test(closeReason)) {
        log("Stopping daemon because Agensis rejected this agent connection.");
        stop();
        return;
      }
      if (lastSocketErrorCode === "ECONNREFUSED" && isLocalBackendUrl(config.url)) {
        log("Local agent backend is not running on 127.0.0.1:3142.");
        log("Start it in another terminal with: npm run backend");
        log("Then rerun this connect command.");
        stop();
        return;
      }
      if (config.once && acceptedJobCount > 0 && queue.active() === 0 && queue.size() === 0) {
        stop();
      }
      if (stopped || config.once) return;
      reconnectTimer = setTimeout(connect, 2000);
      if (reconnectTimer.unref) reconnectTimer.unref();
    });

    ws.on("error", (error) => {
      lastSocketErrorCode = error?.code || '';
      log(`Socket error: ${error?.message || error}`);
    });
  };

  // Independent liveness file, written for the whole process lifetime — NOT gated on the
  // socket. This lets an external watchdog distinguish a dead daemon (stale `ts`) from a
  // healthy daemon that merely lost the server (fresh `ts`, `connected:false`). The WS
  // heartbeat above is the server's liveness signal; this file is everyone else's.
  const writeFileBeat = async () => {
    const agentStatus = await readAgentStatus(config).catch(() => null);
    await writeHeartbeatFile(config, {
      busy: queue.active() > 0,
      active: queue.active(),
      queueSize: queue.size(),
      connected: ws?.readyState === WebSocket.OPEN,
      agentStatus: agentStatus?.status,
      agentNote: agentStatus?.note,
    }).catch(() => { });
  };
  void writeFileBeat();
  fileHeartbeatTimer = setInterval(() => { void writeFileBeat(); }, config.heartbeatMs);
  if (fileHeartbeatTimer.unref) fileHeartbeatTimer.unref();

  connect();
  await new Promise((resolve) => {
    const poll = setInterval(async () => {
      if (config.once && acceptedJobCount > 0 && queue.active() === 0 && queue.size() === 0) {
        stop();
      }
      if (stopped) {
        stop();
      }
    }, 500);
    resolveWait = () => {
      clearInterval(poll);
      resolve();
    };
  });
  resolveWait = null;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

function normalizeConfig(raw) {
  const cursorBuddyBridge = normalizeCursorBuddyBridgeFlag(raw.cursorBuddyBridge);
  const codingDisabled = raw.noCoding === true || process.env.AGENSIS_NO_CODING === "1";
  const fullCliContext = booleanOption(
    raw.fullCliContext,
    booleanOption(process.env.AGENSIS_FULL_CLI_CONTEXT, false),
  );
  const leanCli = !fullCliContext && booleanOption(raw.leanCli, true);
  const runtimeInput = String(raw.runtime || process.env.AGENSIS_RUNTIME || "").trim().toLowerCase();
  if (runtimeInput && !["claude", "codex", "amp"].includes(runtimeInput)) {
    throw new Error("--runtime must be one of: claude, codex, amp");
  }
  const defaultCodingCmd = runtimeInput === "codex" ? "codex exec" : "claude -p";
  const configuredCodingCmd = codingDisabled || runtimeInput === "amp"
    ? ""
    : String(raw.codingCmd || process.env.AGENSIS_CODING_CMD || process.env.CODING_CMD || defaultCodingCmd).trim();
  const executionRuntime = runtimeInput || inferExecutionRuntime(configuredCodingCmd);
  const config = {
    url: String(raw.url || raw.baseUrl || process.env.AGENSIS_URL || "").trim(),
    token: String(raw.token || process.env.AGENSIS_TOKEN || "").trim(),
    workspace: String(raw.workspace || raw.workspaceId || process.env.AGENSIS_WORKSPACE || process.env.AGENSIS_WORKSPACE_ID || "").trim(),
    agent: String(raw.agent || raw.agentId || process.env.AGENSIS_AGENT || process.env.AGENSIS_AGENT_ID || "").trim(),
    handle: slugHandle(raw.handle || process.env.AGENSIS_HANDLE || raw.name || process.env.AGENSIS_NAME || "agent"),
    name: String(raw.name || process.env.AGENSIS_NAME || raw.handle || process.env.AGENSIS_HANDLE || "agensis Agent").trim(),
    cwd: String(raw.cwd || process.env.AGENSIS_CWD || process.cwd()).trim(),
    codingCmd: configuredCodingCmd,
    runtime: executionRuntime,
    runtimeLocked: Boolean(runtimeInput),
    ampCmd: String(raw.ampCmd || process.env.AGENSIS_AMP_CMD || "amp").trim() || "amp",
    model: resolveExecutionModel(raw.model || process.env.AGENSIS_MODEL || process.env.CLAUDE_MODEL || "", executionRuntime),
    permissionMode: normalizePermissionMode(raw.permissionMode || raw.permission_mode || raw.permission || process.env.AGENSIS_PERMISSION_MODE || "default"),
    timeoutMs: Number(raw.timeoutMs || process.env.AGENSIS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    // Clamped to the hard ceiling: an idle deadline LONGER than the hard one can
    // never fire, which would look like the flag silently doing nothing. 0 (or a
    // negative) disables it and restores the single-flat-timer behaviour.
    idleTimeoutMs: Math.min(
      Number(raw.idleTimeoutMs ?? process.env.AGENSIS_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS) || 0,
      Number(raw.timeoutMs || process.env.AGENSIS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    ),
    heartbeatMs: Number(raw.heartbeatMs || process.env.AGENSIS_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS),
    maxConcurrency: Math.max(1, Number(raw.maxConcurrency || process.env.AGENSIS_MAX_CONCURRENCY || DEFAULT_MAX_CONCURRENCY) || DEFAULT_MAX_CONCURRENCY),
    // Clamped to [1, maxConcurrency]: more slots than the queue will ever use is
    // pure memory, and every slot is a live coding-CLI process on someone's
    // machine.
    sessionSlots: Math.min(
      Math.max(1, Number(raw.sessionSlots || process.env.AGENSIS_SESSION_SLOTS || DEFAULT_SESSION_SLOTS) || DEFAULT_SESSION_SLOTS),
      Math.max(1, Number(raw.maxConcurrency || process.env.AGENSIS_MAX_CONCURRENCY || DEFAULT_MAX_CONCURRENCY) || DEFAULT_MAX_CONCURRENCY),
    ),
    once: Boolean(raw.once || process.env.AGENSIS_ONCE === "1"),
    exitOnOnce: Boolean(raw.exitOnOnce),
    onRegistered: typeof raw.onRegistered === "function" ? raw.onRegistered : null,
    primaryDaemon: Boolean(raw.primaryDaemon || process.env.AGENSIS_PRIMARY_DAEMON === "1"),
    cursorBuddyRuntime: Boolean(raw.cursorBuddyRuntime || process.env.AGENSIS_CURSORBUDDY_RUNTIME === "1"),
    cursorBuddyBridge,
    cursorBuddyPort: Number(raw.cursorBuddyPort || process.env.AGENSIS_CURSORBUDDY_PORT || 8787),
    cursorBuddyBridgeSecret: String(raw.cursorBuddyBridgeSecret || process.env.AGENSIS_CURSORBUDDY_BRIDGE_SECRET || "").trim(),
    cursorBuddyModel: String(raw.cursorBuddyModel || process.env.AGENSIS_CURSORBUDDY_MODEL || "haiku-4.5").trim(),
    // Agent-mesh (F6): opt-in LAN listener for direct daemon-to-daemon job handoff.
    // Default OFF — a daemon never opens a network listener unless asked to.
    lanListener: Boolean(raw.lanListener || raw.lan || process.env.AGENSIS_LAN === "1"),
    share: Boolean(raw.share || process.env.AGENSIS_SHARE === "1"),
    sharedModelsFile: String(raw.sharedModelsFile || process.env.AGENSIS_SHARED_MODELS_FILE || "").trim(),
    noCoding: codingDisabled,
    leanCli,
    // Primary method as of this release: reuse one warm Claude Agent SDK /
    // codex app-server connection per silo instead of spawning a fresh CLI
    // process per job (see connectionExecutors.mjs). Falls back to today's
    // subprocess-per-job behavior automatically if that connection isn't
    // available on this host, or always if the operator opts out here.
    fastConnection: booleanOption(raw.fastConnection, booleanOption(process.env.AGENSIS_FAST_CONNECTION, true)),
    // Local Claude memory can contain private project notes. Never upload it
    // unless the host operator opted in at daemon launch time.
    syncMemory: booleanOption(raw.syncMemory, process.env.AGENSIS_SYNC_MEMORY === "1"),
    // Skill BODIES, unlike memory, are on by default: a skill is instructions for
    // doing a job, its NAME already rides the capability push, and a workspace that
    // can see the name but never the text is the bug this feature exists to fix.
    // `--no-sync-skills` / AGENSIS_SYNC_SKILLS=0 is the opt-out for a host that would
    // rather keep its SKILL.md files local.
    syncSkills: booleanOption(raw.syncSkills, booleanOption(process.env.AGENSIS_SYNC_SKILLS, true)),
    hostFolders: normalizeHostFolders(raw.hostFolders ?? raw.host_folders ?? process.env.AGENSIS_HOST_FOLDERS),
  };
  if (config.sharedModelsFile && !path.isAbsolute(config.sharedModelsFile)) {
    config.sharedModelsFile = path.resolve(config.cwd, config.sharedModelsFile);
  }
  const missing = [];
  if (!config.url) missing.push("--url");
  if (!config.token) missing.push("--token");
  if (!config.workspace) missing.push("--workspace");
  if (!config.agent) missing.push("--agent");
  if (config.share && !config.sharedModelsFile) missing.push("--shared-models-file");
  if (missing.length) throw new Error(`Missing required option(s): ${missing.join(", ")}`);
  return config;
}

function booleanOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function normalizeCursorBuddyBridgeFlag(value) {
  const env = process.env.AGENSIS_CURSORBUDDY_BRIDGE;
  if (env !== undefined && env !== "") {
    return !/^(0|false|off|no)$/i.test(String(env).trim());
  }
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function socketUrl(baseUrl, token, config = {}) {
  const url = agentBackendUrl(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/backend/ws";
  url.search = "";
  if (config.workspace) url.searchParams.set("workspaceId", config.workspace);
  if (config.agent) url.searchParams.set("agentId", config.agent);
  return url.toString();
}

export function agentBackendUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (shouldUseLocalAgentBackend(url)) {
    // Local web app ports serve Vite/Netlify UI and HTTP functions; the agent
    // websocket backend is the local API server on :3142.
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = "3142";
  }
  return url;
}

function shouldUseLocalAgentBackend(url) {
  if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0")) return false;
  if (url.port === "3142") return false;
  if (url.port === "5173" || url.port === "8888") return true;
  const port = Number(url.port || 0);
  return port >= 49152 && port <= 65535;
}

function isLocalBackendUrl(baseUrl) {
  try {
    const url = agentBackendUrl(baseUrl);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0") && url.port === "3142";
  } catch {
    return false;
  }
}

// One lane per conversation. A DM and every channel are distinct chat sessions,
// and a thread within a channel is distinct again — matching the server's own
// per-conversation lock granularity (sessionId::threadParentId). Same lane → runs
// in order; different lanes → run in parallel.
// One allocator for the process, built from the first config it sees. Slots are
// a property of this daemon's configuration, not of any single job.
let sessionSlotsSingleton = null;
function sessionSlotsFor(config) {
  if (!sessionSlotsSingleton) sessionSlotsSingleton = createSessionSlots({ slots: config.sessionSlots });
  return sessionSlotsSingleton;
}

function laneKeyForJob(job) {
  const session = String(job?.sessionId || "");
  const thread = String(job?.threadParentId || "");
  return `${session}::${thread}`;
}

const CURSOR_BUDDY_CONTROL_SUBJECT_RE = /\b(cursorbuddy|cursor buddy|avatar|buddy|pet|character|him|guy)\b/i;
const CURSOR_BUDDY_SAY_RE_LIST = [
  /\b(?:make|have|tell)\s+(?:the\s+)?(?:cursorbuddy|cursor buddy|avatar|buddy|pet|character|him|guy)\s+(?:say|speak)\s+(.+)$/i,
];

function cleanupCursorBuddySpeech(value) {
  return String(value || "")
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’?.!]+$/g, "")
    .trim()
    .slice(0, 1200);
}

function extractCursorBuddySpeech(text) {
  for (const pattern of CURSOR_BUDDY_SAY_RE_LIST) {
    const match = String(text || "").match(pattern);
    const speech = cleanupCursorBuddySpeech(match?.[1] || "");
    if (speech) return speech;
  }
  return "";
}

function extractLatestUserMessage(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const marker = /latest user message\s*:\s*/gi;
  let match = null;
  let found = null;
  while ((match = marker.exec(text))) found = match;
  if (!found) return "";
  const rest = text.slice(found.index + found[0].length).trim();
  const stop = rest.search(/\b(Return a useful response|Conversation context follows|Previous user|Previous assistant|Diagnostic notes|System prompt|Developer message)\b/i);
  const latest = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
  return latest.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}

function compactCursorBuddyControlText(message) {
  const raw = String(message || "").replace(/\s+/g, " ").trim();
  const latest = extractLatestUserMessage(raw);
  const text = latest || raw;
  if (!text) return "";
  if (text.length <= 500) return text;
  const patterns = [
    /\b(?:can you\s+)?(?:make|have|tell)\s+(?:the\s+)?(?:cursorbuddy|cursor buddy|avatar|buddy|pet|character|him|guy)\s+(?:wave|waves|waving|say|speak)\b.{0,160}/i,
    /\b(?:cursorbuddy|cursor buddy|avatar|buddy|pet|character|him|guy)\b.{0,120}\b(?:wave|waves|waving|say|speak|open|show|hide|hush|close|dismiss|clear)\b.{0,160}/i,
    /\b(?:wave|open|show|hide|hush|close|dismiss|clear)\b.{0,120}\b(?:cursorbuddy|cursor buddy|avatar|buddy|pet|character|him|guy|bubble|prompt|dialog|panel|options|menu)\b/i,
    /\b(?:say|speak)\s+[`"'“”‘’]?.{1,180}/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].trim();
  }
  return "";
}

function parseCursorBuddyControlIntent(message) {
  const text = compactCursorBuddyControlText(message);
  if (!text) return null;
  const directCommand = /^(open|show|hide|hush|close|dismiss)\b/i.test(text);
  const mentionsBuddy = CURSOR_BUDDY_CONTROL_SUBJECT_RE.test(text);
  if (!directCommand && !mentionsBuddy) return null;

  const source = "agensis-native-control";
  if (/\b(hide|hush|close|dismiss|clear)\b.*\b(bubble|prompt|dialog|panel|options|menu)\b/i.test(text) || /^hush\b/i.test(text)) {
    return { action: "hush", source };
  }
  if (/\b(open|show|bring up|get back|display)\b.*\b(prompt|bubble|dialog|panel|options|menu)\b/i.test(text) || /^open\b/i.test(text)) {
    return { action: "open", source };
  }

  const speech = extractCursorBuddySpeech(text);
  if (speech && mentionsBuddy) {
    return { action: "say", text: speech, source };
  }

  if (mentionsBuddy && /\b(wave|waves|waving)\b/i.test(text)) {
    return { action: "wave", text: speech, source };
  }

  return null;
}

async function postCursorBuddyControlCommand(config, intent) {
  const port = Number(config.cursorBuddyPort || 8787);
  const url = `http://127.0.0.1:${port}/cursorbuddy/control`;
  const secret = String(config.cursorBuddyBridgeSecret || process.env.AGENSIS_CURSORBUDDY_BRIDGE_SECRET || "").trim();
  const headers = { "content-type": "application/json" };
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
    headers["x-agensis-bridge-secret"] = secret;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(intent),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `CursorBuddy control failed with HTTP ${response.status}`);
  }
  return body;
}

function cursorBuddyControlResultText(intent) {
  if (intent.action === "wave") return "Sent CursorBuddy a wave command.";
  if (intent.action === "say") return `Sent CursorBuddy speech: ${intent.text || ""}`.trim();
  if (intent.action === "open") return "Opened CursorBuddy's prompt.";
  if (intent.action === "hush") return "Dismissed CursorBuddy's bubble.";
  if (intent.action === "choose") return "Sent CursorBuddy options.";
  return "Sent CursorBuddy control command.";
}

function canHandleCursorBuddyControlJobs(config = {}) {
  if (config.cursorBuddyBridge === false) return false;
  return Boolean(config.cursorBuddyRuntime || config.primaryDaemon);
}

async function runCursorBuddyControlJob(config, job, intent, started) {
  const model = "cursorbuddy-control";
  const permissionMode = "native";
  const permissionFlags = [];
  const sendDelta = (content = "") => {
    send(job.ws, {
      action: "agent_job_delta",
      jobId: job.id,
      content,
      elapsedMs: Date.now() - started,
      model,
      permissionMode,
      permissionFlags,
    });
  };

  sendDelta("");
  let response = "";
  let error = "";
  try {
    await postCursorBuddyControlCommand(config, intent);
    response = cursorBuddyControlResultText(intent);
    sendDelta(response);
  } catch (err) {
    error = String(err?.message || err);
    response = `CursorBuddy control failed: ${error}`;
    sendDelta(response);
  }

  sendResult(job, {
    action: "agent_job_result",
    jobId: job.id,
    response,
    error,
    elapsedMs: Date.now() - started,
    model,
    permissionMode,
    permissionFlags,
  });
  log(`Finished native CursorBuddy ${intent.action} job ${job.id} in ${Math.round((Date.now() - started) / 1000)}s`);
}

async function runAgentJob(config, job, { signal, requestPermission = null }) {
  const started = Date.now();
  log(`Starting job ${job.id}`);
  const jobRuntime = executionRuntimeForJob(config, job);
  if (config.runtimeLocked && jobRuntime !== config.runtime) {
    const error = `Executor runtime ${config.runtime} cannot accept job runtime ${jobRuntime}.`;
    send(job.ws, {
      action: "agent_job_result",
      jobId: job.id,
      response: "",
      error,
      errorCode: "runtime_mismatch",
      elapsedMs: Date.now() - started,
      metadata: { executionRuntime: config.runtime },
    });
    log(`Job ${job.id} refused: runtime mismatch (${config.runtime} != ${jobRuntime})`);
    return;
  }
  if (isAmpJob(job)) {
    await runAmpAgentJob(config, job, { signal, started });
    if (config.once) {
      log("One-shot Amp job complete; exiting.");
      setTimeout(() => process.exit(0), 150);
    }
    return;
  }
  const cursorBuddyIntent = parseCursorBuddyControlIntent(job.prompt);
  if (cursorBuddyIntent && canHandleCursorBuddyControlJobs(config)) {
    await runCursorBuddyControlJob(config, job, cursorBuddyIntent, started);
    if (config.once) {
      log("One-shot CursorBuddy control job complete; exiting.");
      setTimeout(() => process.exit(0), 150);
    }
    return;
  }
  const command = buildAgentCommand(config, job);
  const prompt = await buildPrompt(config, job);
  let fullContent = "";
  let latest = "";
  let lastDeltaAt = 0;
  const sendDelta = (content = "") => {
    send(job.ws, {
      action: "agent_job_delta",
      jobId: job.id,
      content,
      elapsedMs: Date.now() - started,
      model: command.model,
      permissionMode: command.permissionMode,
      permissionFlags: command.permissionFlags,
    });
  };

  // One message per tool round trip, so a tool-only turn is visible as it
  // happens instead of silently expanding a single "Thinking …" placeholder.
  const sendStep = (step) => {
    send(job.ws, {
      action: "agent_job_step",
      jobId: job.id,
      kind: step.kind,
      name: step.name,
      detail: step.detail,
      elapsedMs: Date.now() - started,
    });
  };

  // One message per finished text block, so a turn reads as the steps the agent
  // actually took — text, its tools, the next text — instead of one bubble that
  // keeps growing with five thoughts run together and no place to interrupt.
  const sendSegment = (segment) => {
    send(job.ws, {
      action: "agent_job_segment",
      jobId: job.id,
      text: segment.text,
      elapsedMs: Date.now() - started,
    });
  };

  sendDelta("");
  const parser = command.streamJson ? createStreamJsonParser({ onStep: sendStep, onSegment: sendSegment }) : null;
  const progressTimer = setInterval(() => sendDelta(fullContent), 1000);
  if (progressTimer.unref) progressTimer.unref();

  // Only take the pooled/fast path for the literal default binary name
  // ("claude"/"codex" resolved off PATH). Any customization — an absolute
  // path, a wrapper script, `claude.sh` — means the operator wants that
  // exact executable run, so it always gets the unchanged subprocess path.
  const usesBareBinary = !/[\\/]/.test(command.cmd);
  const family = config.fastConnection && usesBareBinary
    ? (isClaudeCommand(command.cmd) ? "claude" : isCodexCommand(command.cmd) ? "codex" : null)
    : null;
  const executor = createExecutor(job, { family });
  // Which warm session this conversation runs on. The SILO (workspace+agent) is
  // what a session is scoped to; the SLOT says which of that silo's sessions.
  // At the default of one slot every lane resolves to slot 0, so the key is
  // stable and the behaviour is identical to before slots existed.
  const silo = `${job.workspaceId || config.workspace || ""}:${config.agent || config.handle || ""}`;
  const slots = sessionSlotsFor(config);
  const slot = slots.claim(silo, laneKeyForJob(job));
  const running = executor.run({
    cmd: command.cmd,
    args: [...command.args, prompt],
    env: command.env,
    cwd: job.cwd || config.cwd,
    timeoutMs: config.timeoutMs,
    // The two deadlines are handed over as a PAIR. timeoutMs caps a turn that is
    // working; idleTimeoutMs catches one that has gone silent. Only the pooled
    // connection executors honour the second — LocalExecutor still has the one
    // flat timer, which is a real gap and is called out in AGENTS.md.
    idleTimeoutMs: config.idleTimeoutMs,
    heartbeatMs: config.heartbeatMs,
    label: "agent job",
    signal,
    job,
    // Fields below are only consumed by the pooled connection executors
    // (connectionExecutors.mjs) — LocalExecutor/SandboxExecutor ignore them.
    // sessionKey scopes a warm connection to this silo: same workspace+agent
    // reuses one live session across jobs instead of reconnecting each time.
    prompt,
    model: command.model,
    permissionMode: command.permissionMode,
    hostFolders: resolveAdditionalDirectories(config, job),
    leanCli: config.leanCli,
    mcp: config.leanCli ? leanMcpRuntime(config) : null,
    sessionKey: `${silo}#${slot}`,
    clientVersion: AGENSIS_CLI_VERSION,
    // Interactive approvals. Absent (peer-relayed jobs, tests) the pooled
    // executors keep their pre-broker behaviour: deny rather than self-approve.
    requestPermission,
    onData: (chunk) => {
      if (parser) {
        parser.feed(chunk);
        fullContent = parser.live;
      } else {
        fullContent += String(chunk || "");
        latest = latestLine(`${latest}\n${chunk}`);
      }
      const now = Date.now();
      if (now - lastDeltaAt > 150) {
        lastDeltaAt = now;
        sendDelta(fullContent);
      }
    },
  });
  let result;
  try {
    result = await running;
  } finally {
    // `finally`, because it is the only place that holds for every exit — a
    // normal return, a rejection, and cancellation alike. (A synchronous throw
    // from executor.run itself would slip past this, which is survivable only
    // because a leaked claim costs slot PREFERENCE and never capacity; see
    // sessionSlots.mjs.)
    slots.release(silo, slot);
  }
  clearInterval(progressTimer);

  if (parser) {
    parser.end();
    fullContent = parser.live;
    sendDelta(fullContent); // flush the final tokens
  }

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const error = result.error
    ? result.error.message
    : result.status === 0
      ? ""
      : stderr || `Command exited with status ${result.status}`;
  const response = parser
    ? parser.result || (error ? "" : stderr)
    : stdout || (error ? "" : stderr) || latest || "";

  // Why the turn ended, in the shared vocabulary (stopReasons.mjs). Absent when
  // the executor could not tell us — LocalExecutor's raw subprocess has no
  // structured result to read — and the server treats absent exactly as it
  // treated every result before this field existed.
  const stop = result.stop && typeof result.stop === "object" ? result.stop : null;
  sendResult(job, {
    action: "agent_job_result",
    jobId: job.id,
    response,
    error,
    ...(stop ? {
      stopReason: stop.reason,
      stopDetail: stop.detail || "",
      numTurns: stop.numTurns || 0,
      // Per-turn spend. Stored server-side, deliberately NOT rendered or
      // broadcast in v1 — agent_jobs.metadata is fanned out to clients.
      costUsd: stop.costUsd || 0,
      permissionDenials: stop.permissionDenials || 0,
    } : {}),
    elapsedMs: Date.now() - started,
    model: command.model,
    permissionMode: command.permissionMode,
    permissionFlags: command.permissionFlags,
  });
  log(`Finished job ${job.id} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (config.once) {
    log("One-shot job complete; exiting.");
    setTimeout(() => process.exit(0), 150);
  }
}

async function runAmpAgentJob(config, job, { signal, started = Date.now() } = {}) {
  const model = "amp-orb";
  const permissionMode = "amp-managed";
  const permissionFlags = [];
  const sendDelta = (content = "") => send(job.ws, {
    action: "agent_job_delta",
    jobId: job.id,
    content,
    elapsedMs: Date.now() - started,
    model,
    permissionMode,
    permissionFlags,
  });
  const sendStep = (step) => send(job.ws, {
    action: "agent_job_step",
    jobId: job.id,
    kind: step.kind,
    name: step.name,
    detail: step.detail,
    elapsedMs: Date.now() - started,
  });
  const sendSegment = (segment) => send(job.ws, {
    action: "agent_job_segment",
    jobId: job.id,
    text: segment.text,
    elapsedMs: Date.now() - started,
  });
  const finish = ({ response = "", error = "", errorCode = "", threadId = "" } = {}) => {
    const ampThreadId = validAmpThreadId(threadId);
    // Amp's own amp_* codes folded onto the shared vocabulary, so ONE reader
    // downstream handles all three runtimes instead of the server special-casing
    // whichever one produced the turn.
    const stop = stopFromAmpResult(errorCode, Boolean(error));
    sendResult(job, {
      action: "agent_job_result",
      jobId: job.id,
      response,
      error,
      errorCode: errorCode || undefined,
      stopReason: stop.reason,
      stopDetail: stop.detail || "",
      elapsedMs: Date.now() - started,
      model,
      permissionMode,
      permissionFlags,
      metadata: {
        runtime: "amp",
        ...(ampThreadId ? {
          ampThreadId,
          ampThreadUrl: `https://ampcode.com/threads/${ampThreadId}`,
        } : {}),
        ...(errorCode ? { ampErrorCode: errorCode } : {}),
      },
    });
  };

  sendDelta("");
  const cwd = path.resolve(String(job.cwd || config.cwd));
  const allowedRoots = [config.cwd, ...(config.hostFolders || [])];
  try {
    await assertAmpRepo({ cwd, allowedRoots });
    const runtime = await probeAmpRuntime({ cwd, executable: config.ampCmd, signal });
    if (!runtime.available) throw createAmpError(runtime.reason || "amp_cli_crashed");
  } catch (error) {
    const code = signal?.aborted
      ? "amp_turn_cancelled"
      : String(error?.code || "amp_cli_crashed");
    finish({ error: error?.message || createAmpError(code).message, errorCode: code });
    log(`Amp job ${job.id} refused: ${code}`);
    return;
  }

  const requestedThreadId = String(
    job?.runtime?.threadId || job?.ampThreadId || job?.metadata?.ampThreadId || "",
  ).trim();
  const existingThreadId = validAmpThreadId(requestedThreadId);
  if ((job?.runtime?.continuationRequired === true && !existingThreadId) || (requestedThreadId && !existingThreadId)) {
    const failure = createAmpError("amp_thread_not_found");
    finish({ error: failure.message, errorCode: failure.code });
    log(`Amp job ${job.id} refused: ${failure.code}`);
    return;
  }
  const command = buildAmpCommand({
    executable: config.ampCmd,
    prompt: String(job.prompt || ""),
    threadId: existingThreadId,
  });
  const parser = createStreamJsonParser({ onStep: sendStep, onSegment: sendSegment });
  const tracker = createAmpStreamTracker();
  let fullContent = "";
  let lastDeltaAt = 0;
  const progressTimer = setInterval(() => sendDelta(fullContent), 1000);
  if (progressTimer.unref) progressTimer.unref();
  const result = await runCli({
    cmd: command.cmd,
    args: command.args,
    cwd,
    timeoutMs: config.timeoutMs,
    heartbeatMs: config.heartbeatMs,
    label: "Amp orb turn",
    signal,
    onData: (chunk) => {
      parser.feed(chunk);
      tracker.feed(chunk);
      fullContent = parser.live;
      const now = Date.now();
      if (now - lastDeltaAt > 150) {
        lastDeltaAt = now;
        sendDelta(fullContent);
      }
    },
  });
  clearInterval(progressTimer);
  parser.end();
  tracker.end();
  fullContent = parser.live;
  sendDelta(fullContent);

  const threadId = tracker.threadId || existingThreadId;
  if (result.status !== 0 || result.error) {
    const failure = ampFailureError(result);
    finish({ error: failure.message, errorCode: failure.code, threadId });
    log(`Amp job ${job.id} failed: ${failure.code}`);
    return;
  }
  if (!threadId) {
    const failure = createAmpError("amp_stream_invalid");
    finish({ error: failure.message, errorCode: failure.code });
    log(`Amp job ${job.id} failed: ${failure.code}`);
    return;
  }
  finish({ response: parser.result || "", threadId });
  log(`Finished Amp job ${job.id} in ${Math.round((Date.now() - started) / 1000)}s (${threadId})`);
}

async function buildPrompt(config, job) {
  const agent = job.agent || {};
  const skills = Array.isArray(agent.skills) ? agent.skills.join(", ") : String(agent.skills || "");
  const tools = Array.isArray(agent.tools) ? agent.tools.join(", ") : String(agent.tools || "");
  const model = resolveJobModel(config, job);
  const permissionMode = resolveJobPermissionMode(config, job);
  // Editable "what to do on each heartbeat" doc. Inlined so the agent sees its recurring
  // instructions without a tool call; the path is given so it can edit them.
  const heartbeatMd = await readHeartbeatMd(config).catch(() => null);
  const heartbeatSection = heartbeatMd
    ? `Heartbeat (recurring instructions — edit at ${heartbeatMdPath(config)}):\n${heartbeatMd}`
    : "";
  const sections = [
    "You are running as a local agensis workspace agent daemon.",
    `Workspace: ${job.workspaceId || config.workspace}`,
    `Channel session: ${job.sessionId || ""}`,
    `Agent: ${agent.name || config.name} (@${agent.handle || config.handle})`,
    `Requested model: ${model}`,
    `Permission mode: ${permissionMode}`,
    agent.description ? `Description:\n${agent.description}` : "",
    agent.soul ? `Soul:\n${agent.soul}` : "",
    agent.system_prompt ? `System instructions:\n${agent.system_prompt}` : "",
    agent.instructions ? `Additional instructions:\n${agent.instructions}` : "",
    tools ? `Enabled tools:\n${tools}` : "",
    skills ? `Enabled skills:\n${skills}` : "",
    'Thread widgets: this chat has a right-side widget rail the human watches. When you work a multi-step task here, surface it: call create_thread_item (kind "todo", "plan", or "blocker") with the Channel session id above to post your plan steps and to-dos, mark them done with update_thread_item as you finish, and raise a "blocker" when you need the human to answer something (read their reply from the item response via list_thread_items). Keep it to a few real items, not every micro-step; skip it for quick one-off replies.',
    `Status file: you can report your own working status by overwriting the JSON file at ${statusFilePath(config)} with e.g. {"status":"working","note":"short summary of what you're doing"}. Your daemon reads it on its next heartbeat (~${Math.round((config.heartbeatMs || 15000) / 1000)}s) and surfaces it on your agent card. Optional and best-effort — overwrite the whole file, keep note under ~200 chars, and there's no need to clear it.`,
    `Identity file: you can declare how you appear — avatar, description, soul, and voice ({"cartesia_voice_id","speed","emotion"}) — by writing JSON to ${identityFilePath(config)}, e.g. {"avatar":"FX","description":"...","voice":{"emotion":"calm"}}. Your daemon sends it the next time it connects; anything a human has set in the app always wins, and "name" only applies to brand-new agents.`,
    heartbeatSection,
    "User message:",
    String(job.prompt || ""),
    "Identity boundary: answer as the workspace agent named above. Do not adopt the identity of any browser, desktop, avatar, pet, widget, or UI surface.",
    "Respond with a clear channel-ready result. Use markdown for structure — bullets, headers, and code blocks where appropriate. If you changed files, summarize the files and verification. If you cannot complete it, say exactly why.",
  ];
  const prompt = sections.filter(Boolean).join("\n\n");
  return config.leanCli ? truncateUtf8Start(prompt, LEAN_PROMPT_MAX_BYTES) : prompt;
}

function truncateUtf8Start(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "[... older or optional Agensis context omitted ...]\n\n";
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const codepoints = [...text];
  let low = 0;
  let high = codepoints.length;
  while (low < high) {
    const keep = Math.ceil((low + high) / 2);
    const candidate = codepoints.slice(codepoints.length - keep).join("");
    if (Buffer.byteLength(candidate, "utf8") <= available) low = keep;
    else high = keep - 1;
  }
  return marker + codepoints.slice(codepoints.length - low).join("");
}

function cursorBuddyControlInstructions(config) {
  if (!canHandleCursorBuddyControlJobs(config)) return "";
  const port = Number(config.cursorBuddyPort || 8787);
  const base = `http://127.0.0.1:${port}`;
  return [
    "CursorBuddy surface control:",
    `- Visible browser/desktop/avatar surfaces poll ${base}/cursorbuddy/control for commands.`,
    `- Clear one-shot requests to make the visible buddy wave, speak, open its prompt, or hide its bubble are handled by this daemon before the coding CLI starts.`,
    `- Supported actions: wave, say, hush, open, choose.`,
    `- If a visible buddy action is part of a larger coding task, mention the desired action in your final response.`,
  ].join("\n");
}

function buildAgentCommand(config, job) {
  const { cmd, args } = splitCommand(config.codingCmd);
  const model = resolveJobModel(config, job);
  const permissionMode = resolveJobPermissionMode(config, job);
  const cleanArgs = stripManagedFlags(args);
  let permissionFlags = permissionFlagsForMode(permissionMode);
  const additionalDirs = resolveAdditionalDirectories(config, job);

  if (isClaudeCommand(cmd)) {
    const nextArgs = [...cleanArgs];
    if (model) nextArgs.push("--model", model);
    let env;
    if (config.leanCli) {
      const mcp = leanMcpRuntime(config);
      nextArgs.push(
        "--no-session-persistence",
        "--safe-mode",
        "--mcp-config", JSON.stringify({
          mcpServers: {
            agensis: {
              type: "http",
              url: mcp.url,
              headers: { Authorization: "Bearer ${AGENSIS_MCP_TOKEN}" },
            },
          },
        }),
        "--strict-mcp-config",
      );
      env = mcp.env;
    }
    if (permissionMode === "accept_edits") nextArgs.push("--permission-mode", "acceptEdits");
    if (permissionMode === "yolo") {
      // Claude Code refuses --dangerously-skip-permissions when the process is
      // root/sudo ("cannot be used with root/sudo privileges"), which hard-fails
      // the whole job. Two cases:
      //  - Sandbox jobs (run_mode 'sandbox') execute inside an ephemeral e2b
      //    microVM where the skip is SAFE and required (the VM runs as root); the
      //    e2b exec sets IS_SANDBOX=1 so Claude accepts it in the VM. Always keep
      //    the flag — the daemon host's own uid is irrelevant to the in-VM run.
      //  - Local jobs on a root daemon: Claude rejects the flag, so drop it by
      //    default (the job runs in normal permission mode instead of erroring),
      //    unless the operator asserts a real sandbox via
      //    AGENSIS_ALLOW_ROOT_SKIP_PERMISSIONS=1. Faking IS_SANDBOX would lie
      //    about sandboxing and defeat a genuine safety guard.
      const isSandboxJob = job && job.agent && job.agent.run_mode === "sandbox";
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      // A containerized/sandboxed daemon host (the common remote-host deployment)
      // is a safe place for the skip, so keep the flag there automatically and let
      // the spawn set IS_SANDBOX=1 (see runCli) — no per-host env setup needed.
      // AGENSIS_ALLOW_ROOT_SKIP_PERMISSIONS=1 remains an explicit override for
      // hosts our heuristics miss.
      const trustedSandbox = isSandboxJob || isTrustedSandboxHost();
      const forceSkip = process.env.AGENSIS_ALLOW_ROOT_SKIP_PERMISSIONS === "1";
      if (trustedSandbox || !isRoot || forceSkip) {
        nextArgs.push("--dangerously-skip-permissions");
      } else {
        // Bare-metal root with no sandbox signal: Claude rejects the flag, so drop
        // it (the job runs in normal permission mode instead of hard-failing) and
        // don't advertise yolo flags the process isn't actually using.
        permissionFlags = [];
        log("running as root with no sandbox detected: dropping --dangerously-skip-permissions (Claude rejects it as root). Set AGENSIS_ALLOW_ROOT_SKIP_PERMISSIONS=1 if this host really is sandboxed.");
      }
    }

    // Stream tokens as they arrive instead of one buffered dump at exit.
    // Plain `claude -p` defaults to --output-format text, which buffers the
    // whole reply and writes it once on close — so the chat sits on "Thinking…"
    // then pops the full answer. stream-json + partial messages emit NDJSON
    // deltas we parse incrementally (see createStreamJsonParser).
    // Only auto-enable when the user hasn't pinned their own --output-format,
    // and only in print mode (the flags require --print / -p).
    const hasOutputFormat = cleanArgs.some(
      (a) => a === "--output-format" || String(a).startsWith("--output-format="),
    );
    const hasPrint = cleanArgs.includes("-p") || cleanArgs.includes("--print");
    let streamJson = false;
    if (!hasOutputFormat && hasPrint) {
      nextArgs.push("--output-format", "stream-json", "--include-partial-messages");
      if (!cleanArgs.includes("--verbose")) nextArgs.push("--verbose");
      streamJson = true;
    } else if (hasOutputFormat) {
      streamJson = cleanArgs.some((a) => /stream-json/.test(String(a)));
    }
    // Grant the coding CLI read/write access to the silo's configured host
    // folders, plus this agent's own state dir (see resolveAdditionalDirectories),
    // beyond its cwd. Claude Code accepts repeated --add-dir <path>.
    for (const dir of additionalDirs) nextArgs.push("--add-dir", dir);
    return { cmd, args: nextArgs, model, permissionMode, permissionFlags, streamJson, env };
  }

  if (isCodexCommand(cmd)) {
    const nextArgs = [...cleanArgs];
    if (model) nextArgs.push("--model", model);
    let env;
    if (config.leanCli && cleanArgs.includes("exec")) {
      const mcp = leanMcpRuntime(config);
      nextArgs.push(
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable", "plugins",
        "--disable", "memories",
        "--disable", "hooks",
        "--disable", "skill_search",
        "-c", "project_doc_max_bytes=0",
        "-c", `mcp_servers.agensis.url=${JSON.stringify(mcp.url)}`,
        "-c", 'mcp_servers.agensis.bearer_token_env_var="AGENSIS_MCP_TOKEN"',
      );
      env = mcp.env;
    }
    if (permissionMode === "yolo") nextArgs.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
    return { cmd, args: nextArgs, model, permissionMode, permissionFlags, env };
  }

  return { cmd, args, model, permissionMode, permissionFlags };
}

function inferExecutionRuntime(codingCmd) {
  if (!String(codingCmd || "").trim()) return "custom";
  let cmd;
  try {
    ({ cmd } = splitCommand(codingCmd));
  } catch {
    return "custom";
  }
  if (isClaudeCommand(cmd)) return "claude";
  if (isCodexCommand(cmd)) return "codex";
  return "custom";
}

function executionRuntimeForJob(config, job) {
  if (isAmpJob(job)) return "amp";
  const declared = String(job?.agent?.metadata?.executionRuntime || job?.agent?.metadata?.runtime || "")
    .trim()
    .toLowerCase();
  if (["claude", "codex", "amp", "custom"].includes(declared)) return declared;
  return config.runtime === "amp" ? "custom" : config.runtime;
}

function leanMcpRuntime(config) {
  const url = agentBackendUrl(config.url);
  url.pathname = "/backend/mcp";
  url.search = "";
  url.hash = "";
  return {
    url: url.toString(),
    env: { AGENSIS_MCP_TOKEN: config.token },
  };
}

// Incrementally parses Claude's `--output-format stream-json` NDJSON stream.
// Each line is a JSON event. We accumulate token-level text_delta events for a
// live, streaming view and pull the authoritative final answer from the
// `result` event. Robust to both the partial-message wrapping (event.delta)
// and bare delta shapes, and falls back to complete `assistant` messages when
// partial messages aren't present.
// Tool activity (`kind: "tool"` steps) is progress metadata, not reply content:
// it is raised through onStep and never contributes to live/result, so a step
// can never leak into what the human reads as the agent's answer.
// Segments are boundaries, not content either: each one carries the finished
// text of one assistant block, closes that block's live view, and never feeds
// the accumulators — the same text already arrived as deltas, so adding it
// would double every answer.
function createStreamJsonParser({ onStep, onSegment } = {}) {
  let buffer = "";
  let streamed = ""; // accumulated text_delta tokens of the OPEN block (live view)
  let sawDelta = false;
  let assistantText = ""; // fallback when no token-level deltas arrive
  let closedText = ""; // text of blocks already closed by a segment
  let finalResult = null; // authoritative text from the `result` event
  let sawAgensisStep = false; // pooled executor already reported this stream's tools
  let sawAgensisSegment = false; // …and this stream's block boundaries
  const seenToolIds = new Set();

  const raiseStep = (step) => {
    if (typeof onStep !== "function" || !step.name) return;
    try {
      onStep(step);
    } catch {
      /* a failed progress send must never break parsing the reply */
    }
  };

  // A block boundary. The live view restarts from empty so the NEXT message
  // begins blank instead of replaying this block (deltas are sent as the whole
  // accumulated string, so without this every message would repeat the ones
  // before it). The text stays in closedText, so the result fallback is still
  // the whole turn. Without a listener nothing is closed — a caller that cannot
  // deliver boundaries keeps the single-message behaviour it had before.
  const raiseSegment = (segment) => {
    if (typeof onSegment !== "function") return;
    closedText += sawDelta ? streamed : assistantText;
    streamed = "";
    assistantText = "";
    try {
      onSegment(segment);
    } catch {
      /* a failed progress send must never break parsing the reply */
    }
  };

  const handleEvent = (evt) => {
    if (!evt || typeof evt !== "object") return;
    // Emitted by the pooled SDK executor (connectionExecutors.mjs), which has no
    // raw NDJSON of its own to forward.
    if (evt.type === "agensis_step") {
      const step = evt.step;
      if (step && typeof step === "object") {
        sawAgensisStep = true;
        raiseStep({ kind: step.kind || "tool", name: String(step.name || ""), detail: String(step.detail || "") });
      }
      return;
    }
    if (evt.type === "agensis_segment") {
      const segment = evt.segment;
      if (segment && typeof segment === "object") {
        sawAgensisSegment = true;
        raiseSegment({ text: String(segment.text || "") });
      }
      return;
    }
    const delta = (evt.event && evt.event.delta) || evt.delta;
    if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
      sawDelta = true;
      streamed += delta.text;
      return;
    }
    if (evt.type === "result" && typeof evt.result === "string") {
      finalResult = evt.result;
      return;
    }
    if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
      const text = evt.message.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (text) assistantText += text;
      // The LocalExecutor path is raw `claude --output-format stream-json`, where
      // a completed text block and the tool calls it announced arrive together on
      // one assistant message — same segments, same steps, same wire, so both
      // executors behave identically. Each is skipped once the pooled executor
      // has sent its own lines, so a block is closed once and a tool reported
      // once. The segment goes first: the model wrote the text before the tools.
      if (text && !sawAgensisSegment) raiseSegment({ text });
      if (!sawAgensisStep) {
        for (const block of evt.message.content) {
          if (!block || block.type !== "tool_use") continue;
          const id = typeof block.id === "string" ? block.id : "";
          if (id) {
            if (seenToolIds.has(id)) continue;
            seenToolIds.add(id);
          }
          raiseStep({ kind: "tool", name: String(block.name || ""), detail: summarizeToolInput(block.input) });
        }
      }
    }
  };

  const parseLine = (line) => {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    try {
      handleEvent(JSON.parse(trimmed));
    } catch {
      /* ignore non-JSON noise on the stream */
    }
  };

  return {
    feed(chunk) {
      buffer += String(chunk || "");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        parseLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    end() {
      if (buffer) {
        parseLine(buffer);
        buffer = "";
      }
    },
    get live() {
      return sawDelta ? streamed : assistantText;
    },
    get result() {
      if (finalResult != null) return finalResult;
      return closedText + (sawDelta ? streamed : assistantText);
    },
  };
}

function resolveJobModel(config, job) {
  return resolveExecutionModel(
    job?.agent?.model || job?.model || config.model,
    executionRuntimeForJob(config, job),
  );
}

function resolveModel(value) {
  const text = String(value || "").trim();
  if (!text || text === "auto" || text === "claude-fable-5") return DEFAULT_MODEL;
  return text;
}

function resolveExecutionModel(value, runtime) {
  const text = String(value || "").trim();
  if (runtime === "codex" || runtime === "amp") {
    return !text || text === "auto" ? "" : text;
  }
  return resolveModel(text);
}

function resolveJobPermissionMode(config, job) {
  return normalizePermissionMode(
    job?.agent?.permissionMode ||
    job?.agent?.permission_mode ||
    job?.permissionMode ||
    job?.permission_mode ||
    config.permissionMode,
  );
}

function normalizePermissionMode(value) {
  const mode = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["yolo", "no_sandbox", "danger", "danger_full_access", "dangerously_skip_permissions"].includes(mode)) return "yolo";
  if (["accept_edits", "acceptedits", "auto_approve", "auto_approve_edits"].includes(mode)) return "accept_edits";
  return "default";
}

function permissionFlagsForMode(permissionMode) {
  return normalizePermissionMode(permissionMode) === "yolo" ? ["--no-sandbox", "--yolo"] : [];
}

// Normalize a host-folder list from a comma/newline-separated string or an array
// into a clean, deduped array of trimmed absolute-ish path strings. These are the
// extra directories a silo (daemon agent) may read/write beyond its cwd.
function normalizeHostFolders(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/[,\n]/);
  const seen = new Set();
  const folders = [];
  for (const entry of raw) {
    const folder = String(entry || "").trim();
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }
  return folders;
}

// Host folders for a job, most specific first: the dispatching server's per-agent
// metadata.host_folders, then an explicit job override, then the daemon's own
// --host-folder config. The server stamps agent.metadata.host_folders onto the
// job payload, so a GUI edit takes effect on the next job without a daemon restart.
function resolveHostFolders(config, job) {
  const fromJob = job?.agent?.metadata?.host_folders
    ?? job?.agent?.hostFolders
    ?? job?.hostFolders
    ?? job?.host_folders;
  const resolved = normalizeHostFolders(fromJob);
  return resolved.length > 0 ? resolved : (config.hostFolders || []);
}

// The coding CLI subprocess needs write access to this agent's own state dir
// (~/.agensis/<workspace>/<agent>/ — see state.mjs) because the daemon asks
// every job to overwrite status.json there and read heartbeat.md back. Absent
// this, Claude Code's working-dir allowlist refuses the write outright ("may
// only list files in the allowed working directories"), even under
// --dangerously-skip-permissions — permissions.allow Write(...) does NOT
// override this gate, only --add-dir (subprocess CLI) / additionalDirectories
// (SDK, see connectionExecutors.mjs) do.
//
// Deliberately NOT folded into resolveHostFolders: that list is server-gated,
// operator-configured, per-job metadata (workspace_agents.metadata.host_folders
// is MANAGE_ONLY on the server specifically so a member with only 'write' can't
// widen an agent's filesystem access — see backend-core.cjs). The state dir
// here is derived ONLY from this daemon's own connection identity
// (config.workspace/config.agent), never from job- or server-supplied
// metadata, so it can't be widened by a misconfigured or malicious
// host_folders value, and a bug in this function can't grant access beyond
// this one agent's own directory (safeSegment in state.mjs sanitizes both
// path segments against traversal).
function resolveAdditionalDirectories(config, job) {
  const dirs = resolveHostFolders(config, job);
  const stateDir = resolveStateDir({ workspace: config.workspace, agent: config.agent });
  return stateDir && !dirs.includes(stateDir) ? [...dirs, stateDir] : dirs;
}

// True when the daemon is running inside a container/sandbox where letting the
// coding CLI skip permission prompts is safe (the common remote-host deploy).
// Detected once (the environment can't change mid-process) from, in order:
//  - explicit opt-in envs (operator asserts a sandbox),
//  - IS_SANDBOX already set (e.g. the parent orchestrator declared it),
//  - Docker/Podman markers (/.dockerenv, /run/.containerenv),
//  - a container hint in /proc/1/cgroup (docker/kubepods/containerd/lxc).
// Deliberately conservative: a bare-metal root host matches none of these, so it
// still drops the skip flag rather than falsely claiming to be sandboxed.
let _trustedSandboxHost;
function isTrustedSandboxHost() {
  if (_trustedSandboxHost !== undefined) return _trustedSandboxHost;
  const env = process.env;
  if (env.AGENSIS_ALLOW_ROOT_SKIP_PERMISSIONS === "1" || env.AGENSIS_SANDBOX_HOST === "1" || env.IS_SANDBOX === "1") {
    return (_trustedSandboxHost = true);
  }
  // Explicit opt-ins above always win. Generic container auto-detection below can
  // be disabled for security-sensitive hosts (e.g. a root Docker daemon with host
  // mounts) that shouldn't be treated as a safe sandbox.
  if (env.AGENSIS_NO_SANDBOX_AUTODETECT === "1") {
    return (_trustedSandboxHost = false);
  }
  try {
    if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) {
      return (_trustedSandboxHost = true);
    }
  } catch { /* fall through */ }
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|kubepods|containerd|lxc|podman/i.test(cgroup)) {
      return (_trustedSandboxHost = true);
    }
  } catch { /* not linux / no procfs */ }
  return (_trustedSandboxHost = false);
}

// Build the heartbeat metadata sent to the server, folding in the agent's self-declared
// status (from status.json) when present. The server merges this object into the stored
// connection row, so agentStatus/agentNote surface on the agent card for free.
function heartbeatMetadata(config, queue, agentStatus, cursorBuddyContext = null, activeInference = null) {
  const metadata = {
    busy: queue.active() > 0,
    queueSize: queue.size(),
    cwd: config.cwd,
    model: config.model,
    permissionMode: config.permissionMode,
    permissionFlags: permissionFlagsForMode(config.permissionMode),
    daemon: {
      runtime: "agensis-cli",
      version: AGENSIS_CLI_VERSION,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      host: os.hostname(),
      cwd: config.cwd,
    },
  };
  if (activeInference instanceof Map) {
    const byModel = {};
    for (const entry of activeInference.values()) {
      const model = String(entry?.model || '');
      if (model) byModel[model] = (byModel[model] || 0) + 1;
    }
    metadata.activeInferenceByModel = byModel;
  }
  if (cursorBuddyContext && typeof cursorBuddyContext === "object") {
    metadata.cursorBuddy = sanitizeCursorBuddyContextForHeartbeat(cursorBuddyContext);
  }
  if (agentStatus?.status) metadata.agentStatus = agentStatus.status;
  if (agentStatus?.note) metadata.agentNote = agentStatus.note;
  if (agentStatus?.status || agentStatus?.note) metadata.agentStatusAt = new Date().toISOString();
  return metadata;
}

function sanitizeCursorBuddyContextForHeartbeat(context = {}) {
  const client = context.client && typeof context.client === "object" ? context.client : {};
  const page = context.page && typeof context.page === "object" ? context.page : {};
  const runtime = context.runtime && typeof context.runtime === "object" ? context.runtime : {};
  const manifest = context.manifest && typeof context.manifest === "object" ? context.manifest : {};
  const project = context.project && typeof context.project === "object" ? context.project : {};
  return {
    surface: String(context.surface || "").slice(0, 80),
    instanceId: String(context.instanceId || "").slice(0, 140),
    url: String(context.url || "").slice(0, 2048),
    title: String(context.title || "").slice(0, 300),
    origin: String(page.origin || "").slice(0, 300),
    hostname: String(page.hostname || "").slice(0, 200),
    pathname: String(page.pathname || "").slice(0, 500),
    visibilityState: String(page.visibilityState || "").slice(0, 40),
    focused: page.focused === true,
    userAgent: String(client.userAgent || "").slice(0, 500),
    platform: String(client.platform || "").slice(0, 120),
    language: String(client.language || "").slice(0, 80),
    viewport: client.viewport && typeof client.viewport === "object" ? {
      width: Number(client.viewport.width) || 0,
      height: Number(client.viewport.height) || 0,
      devicePixelRatio: Number(client.viewport.devicePixelRatio) || 0,
    } : null,
    runtimeMarker: String(runtime.marker || "").slice(0, 120),
    extensionMarker: String(runtime.extensionMarker || "").slice(0, 120),
    manifest: {
      name: String(manifest.name || "").slice(0, 120),
      version: String(manifest.version || "").slice(0, 80),
      source: String(manifest.source || "").slice(0, 500),
    },
    project: {
      name: String(project.name || "").slice(0, 120),
      root: String(project.root || "").slice(0, 500),
      agent: String(project.agent || "").slice(0, 80),
    },
    updatedAt: String(context.updatedAt || "").slice(0, 80),
  };
}

function applyAgentConfig(config, agent) {
  if (!agent || typeof agent !== "object") return;
  if (agent.name) config.name = String(agent.name).trim() || config.name;
  if (agent.handle || agent.name) config.handle = slugHandle(agent.handle || agent.name || config.handle);
  if (agent.model) config.model = resolveExecutionModel(agent.model, config.runtime);
  const permissionMode = agent.permissionMode || agent.permission_mode;
  if (permissionMode) config.permissionMode = normalizePermissionMode(permissionMode);
  if (agent.memory_dir !== undefined || agent.memoryDir !== undefined) {
    config.memoryDir = String(agent.memory_dir ?? agent.memoryDir ?? "").trim();
  }
}

// Detect installed skills from well-known skill directories.
// Check which well-known CLIs are on PATH.
function detectClis() {
  const targets = ["amp", "claude", "codex", "gh", "node", "npm", "python3", "git", "fly", "vercel"];
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return targets.filter(cli =>
    pathDirs.some(dir => {
      try { return fs.existsSync(path.join(dir, cli)); } catch { return false; }
    })
  );
}

// Read MCP server names from ~/.claude.json if present.
function detectMcpServers() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (servers && typeof servers === "object") return Object.keys(servers).sort();
  } catch {
    // file missing or malformed — not fatal
  }
  return [];
}

function sha1Short(str) {
  return crypto.createHash("sha1").update(String(str)).digest("hex").slice(0, 16);
}

// Detect this agent's current runtime capabilities and compute the two daemon-owned
// drift hashes. The daemon is the single authority for these hashes: it emits them on
// both the full snapshot (agent_capabilities_sync) and every heartbeat, so the server
// never has to recompute a canonical form — it just compares the heartbeat hash against
// the last value it stored on a snapshot. `capabilitiesHash` covers skills/CLIs/MCP;
// `memoryHash` covers the palace file list (stat-only, no content reads); `skillsHash`
// covers the BODIES behind the advertised skill names (also stat-only) — a SKILL.md can
// be edited without the name list changing, so it needs its own hash or the edit would
// never reach the workspace. Null when body sync is off, which the server reads as
// "this daemon does not do skill bodies": never nudged, never blocked.
// Reach is passed in (not detected here) since it reflects live LAN-listener state
// owned by runAgensisDaemon's closure, not something derivable from disk/cwd.
async function computeCapabilities(config, reach = null) {
  const skills = detectSkillNames({ cwd: config.cwd });
  const commands = detectCommandEntries({ cwd: config.cwd });
  const clis = detectClis();
  const mcpServers = detectMcpServers();
  const memoryRoot = config.syncMemory
    ? deriveMemoryRoot({ cwd: config.cwd, memoryDir: config.memoryDir }) || null
    : null;
  // Arrays are already sorted/stable at detection, so this canonical form is stable.
  // `commands` is included so the drift-check re-pushes when the user's slash
  // commands change. `reach` (agent-mesh F2/F6) is folded in too, so a listener
  // opening/closing or an address changing re-pushes via the SAME drift nudge —
  // no second sync channel.
  const sharedModels = sharedModelAdvertisements(config.sharedModels);
  const amp = await cachedAmpRuntimeCapability(config);
  const runtimes = {
    claude: { id: "claude", label: "Claude", available: clis.includes("claude") },
    codex: { id: "codex", label: "Codex", available: clis.includes("codex") },
    amp: { ...amp, label: "Amp" },
  };
  const capabilitiesHash = sha1Short(JSON.stringify({ skills, commands, clis, mcpServers, memoryRoot, sharedModels, runtimes, codingRoute: Boolean(config.codingCmd), shared: config.share, reach: reach || null }));
  const memoryHash = sha1Short(await memoryFingerprint(memoryRoot));
  // Deliberately NOT folded into capabilitiesHash: a skill body edit should re-push
  // bodies, not the whole capability snapshot, and the two travel on different frames.
  const skillsHash = config.syncSkills ? sha1Short(await skillsFingerprint({ cwd: config.cwd })) : null;
  return { skills, commands, clis, mcpServers, memoryRoot, sharedModels, runtimes, codingRoute: Boolean(config.codingCmd), shared: config.share, reach: reach || null, capabilitiesHash, memoryHash, skillsHash };
}

let ampCapabilityCache = null;
async function cachedAmpRuntimeCapability(config) {
  const key = `${config.ampCmd}\n${path.resolve(config.cwd)}`;
  if (ampCapabilityCache?.key === key && Date.now() - ampCapabilityCache.at < 60_000) {
    return ampCapabilityCache.value ?? ampCapabilityCache.pending;
  }
  const pending = probeAmpRuntime({ cwd: config.cwd, executable: config.ampCmd });
  ampCapabilityCache = { key, at: Date.now(), pending };
  try {
    const value = await pending;
    ampCapabilityCache = { key, at: Date.now(), value };
    return value;
  } catch (error) {
    if (ampCapabilityCache?.pending === pending) ampCapabilityCache = null;
    throw error;
  }
}

// Push a snapshot of this agent's runtime capabilities (skills, CLIs, MCP servers,
// memory root, direct-reach) to the server, carrying the daemon-owned hashes so the
// server can store them as the reference the heartbeat drift-check compares against.
// Fire-and-forget.
async function pushCapabilitiesSnapshot(ws, config, reach = null) {
  try {
    const caps = await computeCapabilities(config, reach);
    send(ws, {
      action: "agent_capabilities_sync",
      workspaceId: config.workspace,
      agentId: config.agent,
      skills: caps.skills,
      commands: caps.commands,
      clis: caps.clis,
      mcpServers: caps.mcpServers,
      sharedModels: caps.sharedModels,
      runtimes: caps.runtimes,
      codingRoute: caps.codingRoute,
      shared: caps.shared,
      memoryRoot: caps.memoryRoot,
      reach: caps.reach || undefined,
      hash: caps.capabilitiesHash,
      memoryHash: caps.memoryHash,
      skillsHash: caps.skillsHash,
    });
    log(`Capabilities synced — skills:${caps.skills.length} commands:${caps.commands.length} clis:${caps.clis.length} mcp:${caps.mcpServers.length}`);
  } catch (error) {
    log(`Capabilities sync skipped: ${error?.message || error}`);
  }
}

// Direct-reachable LAN IPv4 addresses for the given bound port, capped to 4 (mirrors
// the server-side cap in reachFromMessage). Excludes internal/loopback interfaces —
// those aren't reachable from another machine on the LAN.
function lanAddrs(port) {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addrs.push({ host: entry.address, port, scope: "lan" });
      }
    }
  }
  return addrs.slice(0, 4);
}

// Push a read-only snapshot of this agent's file-memory palace to the server so the
// app can mirror it. Fire-and-forget: failures (no palace, fs errors) are logged, not
// fatal. The root is the explicit memory_dir or the derived Claude palace for cwd.
async function pushMemorySnapshot(ws, config) {
  try {
    if (!config.syncMemory) return;
    const root = deriveMemoryRoot({ cwd: config.cwd, memoryDir: config.memoryDir });
    if (!root) return;
    const files = await snapshotMemory(root);
    send(ws, {
      action: "agent_memory_sync",
      workspaceId: config.workspace,
      agentId: config.agent,
      root,
      files,
    });
    log(`Synced ${files.length} memory file${files.length === 1 ? "" : "s"} from ${root}`);
  } catch (error) {
    log(`Memory sync skipped: ${error?.message || error}`);
  }
}

// Push the BODIES behind the skill names this daemon advertises, so an agent elsewhere
// in the workspace can read one of this machine's skills even while this machine is
// offline. Sent on connect and whenever the server nudges `agent_skills_refresh` after
// spotting the heartbeat's skillsHash drift — never on a heartbeat itself, which
// carries the hash only.
//
// The fingerprint is taken BEFORE the bodies are read, on purpose. If a SKILL.md
// changes mid-snapshot the server ends up storing the older hash against newer content,
// so the next heartbeat sees drift and re-pushes. Hashing afterwards would store the
// NEW hash against content read before the edit, and the stale copy would sit there
// forever with nothing to knock it loose.
//
// Fire-and-forget: no skills directory, an unreadable file, a permission error — all
// logged and dropped. Skill sync must never take the connection down with it.
async function pushSkillSnapshot(ws, config) {
  try {
    // Opted out: send nothing and, like pushMemorySnapshot, leave whatever the
    // workspace already stored alone. Turning the flag off stops new text going up;
    // it is not a delete, and inventing one here would let a mistyped flag silently
    // strip every other agent's access to this machine's skills.
    if (!config.syncSkills) return;
    const hash = sha1Short(await skillsFingerprint({ cwd: config.cwd }));
    const skills = await snapshotSkills({ cwd: config.cwd });
    send(ws, {
      action: "agent_skill_sync",
      workspaceId: config.workspace,
      agentId: config.agent,
      hash,
      skills,
    });
    const truncated = skills.filter((skill) => skill.truncated).length;
    log(`Synced ${skills.length} skill document${skills.length === 1 ? "" : "s"}${truncated ? ` (${truncated} truncated)` : ""}`);
  } catch (error) {
    log(`Skill sync skipped: ${error?.message || error}`);
  }
}

function stripManagedFlags(args) {
  const flagsWithValues = new Set(["--model", "-m", "--permission-mode", "--sandbox", "--ask-for-approval", "--approval-policy"]);
  const flagsWithoutValues = new Set(["--dangerously-skip-permissions", "--no-sandbox", "--yolo", "--accept-edits"]);
  const next = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag] = String(arg).split("=", 1);
    if (flagsWithoutValues.has(arg)) continue;
    if (flagsWithValues.has(flag)) {
      if (!String(arg).includes("=")) i += 1;
      continue;
    }
    next.push(arg);
  }
  return next;
}

function isClaudeCommand(cmd) {
  return /(^|\/)claude(?:$|\.)/.test(String(cmd || ""));
}

function isCodexCommand(cmd) {
  return /(^|\/)codex(?:$|\.)/.test(String(cmd || ""));
}

function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";
  let escape = false;
  for (const ch of command) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  if (!parts.length) throw new Error("coding command is empty");
  return { cmd: parts[0], args: parts.slice(1) };
}

function parseMessage(data) {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function send(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

// A job's FINAL frame, which — unlike a delta — cannot be allowed to evaporate.
// Deltas are cosmetic and the next one supersedes them; the result IS the turn.
// If the socket is down, hand it to the connect scope to re-send on reconnect.
function sendResult(job, frame) {
  if (send(job.ws, frame)) return true;
  job.parkResult?.(frame);
  return false;
}

function latestLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0] || "";
}

function slugHandle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isAddressInUseError(error) {
  return error?.code === "EADDRINUSE" || /\bEADDRINUSE\b/.test(String(error?.message || error));
}

async function probeExistingCursorBuddyBridge(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port || 8787)}/cursorbuddy/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) return null;
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function log(message) {
  process.stderr.write(`[agensis] ${message}\n`);
}

function abortInferenceRequests(activeInference) {
  if (!(activeInference instanceof Map)) return;
  for (const entry of activeInference.values()) {
    try { entry?.abort?.(); } catch { /* request is already settling */ }
  }
}

export const __test = {
  cursorBuddyControlInstructions,
  isAddressInUseError,
  probeExistingCursorBuddyBridge,
  parseCursorBuddyControlIntent,
  runAgentJob,
  runAmpAgentJob,
  normalizeConfig,
  heartbeatMetadata,
  abortInferenceRequests,
  createStreamJsonParser,
  createExecutor,
  buildAgentCommand,
  buildPrompt,
  computeCapabilities,
  LEAN_PROMPT_MAX_BYTES,
};
