// ACP client, over the OFFICIAL @agentclientprotocol/sdk.
//
// This file used to be ~400 lines of hand-rolled NDJSON JSON-RPC 2.0: framing,
// id correlation, pending-request maps, inbound-request dispatch. That layer
// produced three protocol bug-fix releases in about 24 hours (0.1.49 answers
// arriving empty, 0.1.54 agents losing their tools and their write access), so
// it is now the SDK's job. Zed publishes and maintains it; the protocol is
// theirs.
//
// The EXPORTED SURFACE IS UNCHANGED on purpose — createAcpClient still returns
// { sessionId, initializeResult, pid, closed, initialize, newSession, prompt,
// cancel, dispose, request } — so acp/executor.mjs (session pool, handshake
// budgets, prewarm, direct fallback) did not have to change at all.
//
// NOTE ON NAMING, because two different SDKs are in play and they are easy to
// confuse: this is @agentclientprotocol/sdk, the ACP wire protocol. It is NOT
// @anthropic-ai/claude-agent-sdk, which is the Claude direct lane in
// connectionExecutors.mjs. Nothing here touches that path.
//
// Spec: https://agentclientprotocol.com/protocol/overview

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Readable, Writable } from "node:stream";
import { delimiter, isAbsolute, join, resolve as pathResolve } from "node:path";
import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION as SDK_PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

/** Re-exported from the SDK so the protocol version can never drift from it. */
export const PROTOCOL_VERSION = SDK_PROTOCOL_VERSION;

/** Largest file the agent may pull in through fs/read_text_file. */
const MAX_READ_BYTES = 512 * 1024;

function buildPathEnv() {
  const parts = [];
  if (process.env.PATH) parts.push(...process.env.PATH.split(delimiter).filter(Boolean));
  const home = homedir();
  parts.push(
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".volta", "bin"),
  );
  const seen = new Set();
  return parts.filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(delimiter);
}

export function extractTextFromUpdate(update) {
  if (!update || typeof update !== "object") return "";
  const sessionUpdate = String(update.sessionUpdate || update.session_update || update.type || "");
  const isAgentMessage = sessionUpdate === "agent_message_chunk"
    || sessionUpdate === "agent_message"
    || sessionUpdate === "message";
  if (!isAgentMessage) return "";

  const content = update.content || update.message?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
    }
  }
  if (typeof update.text === "string") return update.text;
  return "";
}

export function extractTextFromResult(result) {
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  if (Array.isArray(result.content)) {
    return result.content.map((c) => c?.text || "").join("");
  }
  return "";
}

/**
 * Choose which permission option to answer a session/request_permission with.
 *
 * Prefers a ONE-SHOT allow over allow_always: a blanket grant is a decision a
 * human makes, not one the daemon makes on their behalf. Exported so the
 * choice is testable without driving a whole session.
 */
export function pickPermissionOption(optionsList) {
  const list = Array.isArray(optionsList) ? optionsList : [];
  return list.find((o) => /^allow(_once)?$/i.test(String(o?.optionId || "")))
    || list.find((o) => /allow|accept|yes|approve/i.test(
      String(o?.optionId || o?.name || o?.kind || ""),
    ))
    || list[0];
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   autoApprove?: boolean,
 *   mcpServers?: Array<object>,
 *   permissionMode?: string,
 *   onUpdate?: (params: object) => void,
 *   onLog?: (line: string) => void,
 *   clientName?: string,
 * }} options
 */
export function createAcpClient(options) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    autoApprove = true,
    mcpServers = [],
    permissionMode = "",
    onUpdate = null,
    onLog = null,
    clientName = "agensis-agent",
  } = options;

  /** @type {Set<(params: object) => void>} */
  const updateHandlers = new Set();
  if (typeof onUpdate === "function") updateHandlers.add(onUpdate);

  let closed = false;
  let sessionId = null;
  let initializeResult = null;

  const log = (line) => {
    if (typeof onLog === "function") onLog(line);
  };

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      PATH: buildPathEnv(),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk || "").split("\n")) {
      if (line.trim()) log(`[stderr] ${line}`);
    }
  });

  child.on("error", (err) => {
    closed = true;
    log(`[acp] process error: ${err?.message || err}`);
  });

  child.on("exit", (code, signal) => {
    closed = true;
    // Keep this wording: acp/executor.mjs's looksLikeUnavailable() matches
    // "ACP process exited" to decide that a harness is structurally broken
    // rather than merely slow.
    const message = `ACP process exited (code=${code}, signal=${signal || "none"})`;
    log(`[acp] ${message}`);
    try { connection?.close(new Error(message)); } catch { /* already closing */ }
  });

  function emitUpdate(params) {
    for (const handler of updateHandlers) {
      try {
        handler(params);
      } catch {
        // never break the pipe
      }
    }
  }

  const app = createClientApp({ name: clientName })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const option = pickPermissionOption(params?.options);
      // RequestPermissionResponse NESTS the outcome. Sending it flat is silently
      // fatal: the harness reads response.outcome.outcome, gets undefined, and
      // answers the model with a refusal the human never made — which is how
      // agents that plainly had permission could not write files (0.1.54).
      // The SDK validates this shape now, so it cannot silently regress again.
      return autoApprove
        ? { outcome: { outcome: "selected", optionId: option?.optionId || option?.id || "allow" } }
        : { outcome: { outcome: "cancelled" } };
    })
    .onRequest(methods.client.fs.readTextFile, ({ params }) => {
      const filePath = String(params?.path || "");
      if (!isAbsolute(filePath)) {
        throw new Error("path must be absolute");
      }
      let content = readFileSync(filePath, "utf8");
      if (content.length > MAX_READ_BYTES) content = content.slice(0, MAX_READ_BYTES);
      return { content };
    })
    .onRequest(methods.client.fs.writeTextFile, () => {
      // Writes go through the agent's own tools, not through the client.
      throw new Error("fs/write_text_file not enabled in agensis-agent ACP v1");
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      emitUpdate(params || {});
    });

  // Web streams over the child's stdio; the SDK owns framing and correlation.
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = app.connect(stream);
  connection.closed?.then?.(() => { closed = true; }, () => { closed = true; });

  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error("ACP process is closed"));
    return connection.agent.request(method, params);
  }

  async function initialize() {
    initializeResult = await request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: clientName,
        title: "agensis-agent",
        version: process.env.npm_package_version || "0.1.0",
      },
    });
    return initializeResult;
  }

  async function newSession(sessionCwd = cwd) {
    // mcpServers is how an ACP agent is given tools. Sending [] — which an
    // earlier version did, hardcoded — is why agents over ACP had no agensis
    // tools at all: no read_doc, no list_docs, no post_message, no whoami.
    const result = await request(methods.agent.session.new, {
      cwd: pathResolve(sessionCwd),
      mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
    });
    sessionId = result?.sessionId || result?.session_id || result?.id || null;
    if (!sessionId) throw new Error("session/new did not return a sessionId");
    // The agent's configured permission mode has to be ASSERTED — a harness
    // starts every session at "default" and session/new has no field for it.
    // Without this a yolo agent is still interrogated on every tool call.
    if (permissionMode) {
      try {
        await request(methods.agent.session.setMode, { sessionId, modeId: permissionMode });
      } catch (error) {
        // Older or simpler harnesses may not implement modes. Auto-approve
        // still covers us, so this is a degradation, not a failure.
        log(`[acp] session/set_mode ${permissionMode} not accepted: ${error?.message || error}`);
      }
    }
    return result;
  }

  /**
   * @param {string} text
   * @param {{ onChunk?: (text: string) => void }} [opts]
   */
  async function prompt(text, opts = {}) {
    if (!sessionId) throw new Error("No ACP session — call newSession first");
    const chunks = [];
    const handler = (params) => {
      const update = params?.update || params;
      const bit = extractTextFromUpdate(update);
      if (bit) {
        chunks.push(bit);
        if (typeof opts.onChunk === "function") opts.onChunk(bit);
      }
    };
    updateHandlers.add(handler);
    try {
      const result = await request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: String(text || "") }],
      });
      const reply = chunks.join("") || extractTextFromResult(result) || "";
      return {
        stopReason: result?.stopReason || result?.stop_reason || "end_turn",
        text: reply,
        result,
      };
    } finally {
      updateHandlers.delete(handler);
    }
  }

  function cancel() {
    if (!sessionId || closed) return;
    try {
      const sent = connection.agent.notify(methods.agent.session.cancel, { sessionId });
      if (sent && typeof sent.catch === "function") {
        sent.catch(() => { /* a cancel that cannot be delivered is moot */ });
      }
    } catch {
      // ignore
    }
  }

  function dispose() {
    closed = true;
    try { connection.close(); } catch { /* ignore */ }
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    const t = setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch { /* ignore */ }
    }, 2000);
    if (typeof t.unref === "function") t.unref();
  }

  return {
    get sessionId() { return sessionId; },
    get initializeResult() { return initializeResult; },
    get pid() { return child.pid; },
    get closed() { return closed; },
    initialize,
    newSession,
    prompt,
    cancel,
    dispose,
    request,
  };
}
