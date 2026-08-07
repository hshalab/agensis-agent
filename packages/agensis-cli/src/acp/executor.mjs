// ACP coding executor for the Relay CLI.
// Prefers a local ACP harness when installed; same {status,stdout,stderr,error,stop}
// contract as LocalExecutor / connection executors.
//
// ACP covers the harnesses this daemon has no other way to drive — grok, hermes,
// goose, kimi, cursor, opencode, openclaw. It deliberately does NOT cover claude,
// codex or amp: those have native runtimes (Claude Agent SDK, `codex app-server`,
// the Amp CLI) which keep a warm session per silo and report typed tool steps,
// text segments, stop reasons and token usage that a plain-text ACP adapter
// cannot. See NATIVE_RUNTIME_HARNESSES in harnesses.mjs.

import { createAcpClient } from "./client.mjs";
import { preferredHarnessId, resolveHarness, usesNativeRuntime } from "./harnesses.mjs";

const acpUnavailable = new Set();
/** @type {Map<string, { client: ReturnType<typeof createAcpClient>, harnessId: string, cwd: string }>} */
const sessionPool = new Map();

/**
 * The agensis MCP server, in the shape ACP's session/new expects.
 *
 * An HTTP entry carries its headers as a LIST of {name,value} pairs — a harness
 * turns them back into an object with Object.fromEntries, so an object here
 * arrives as garbage. The classic path builds the same server as a keyed map
 * (connectionExecutors.mjs); only the wire shape differs.
 *
 * Returns [] when the daemon has no MCP runtime configured, which is the honest
 * "this agent has no workspace tools" case rather than a broken entry.
 */
export function acpMcpServers(mcp) {
  const url = String(mcp?.url || "").trim();
  if (!url) return [];
  const token = String(mcp?.env?.AGENSIS_MCP_TOKEN || "").trim();
  return [{
    type: "http",
    name: "agensis",
    url,
    ...(token ? { headers: [{ name: "Authorization", value: `Bearer ${token}` }] } : {}),
  }];
}

/**
 * agensis permission modes -> ACP session modes.
 *
 * A harness starts every session in "default" and asks before each tool call, so
 * a yolo agent that never asserts its mode gets interrogated anyway. Mirrors
 * mapClaudePermission in connectionExecutors.mjs so both paths agree.
 */
export function acpPermissionMode(permissionMode) {
  const mode = String(permissionMode || "").trim();
  if (mode === "yolo") return "bypassPermissions";
  if (mode === "accept_edits") return "acceptEdits";
  return "default";
}

function looksLikeUnavailable(error) {
  const message = String((error && error.message) || error || "");
  return /ENOENT|command not found|not available|not installed|ACP process exited|Cannot find module|timed out|EACCES/i.test(message);
}

/**
 * A handshake that ran out of clock is NOT the same as a missing binary.
 *
 * This distinction is the whole ballgame. `looksLikeUnavailable` matches
 * "timed out", so a single slow session/new used to add the harness to
 * `acpUnavailable` — permanently, for the entire daemon lifetime. Every
 * subsequent turn then took the classic path, which re-spawns the CLI cold.
 *
 * Measured on a real Mac (2026-08, trivial prompt, grok):
 *   warm ACP session .... 5221ms, 2525ms, 2426ms   (handshake 6331ms, paid once)
 *   classic re-spawn ... 14191ms, 15394ms, 16956ms (paid EVERY turn)
 *
 * So one unlucky handshake cost ~6x on every turn thereafter. A timeout is
 * transient: retry it, and only give up after repeated failures.
 */
function looksTransient(error) {
  return /timed out/i.test(String((error && error.message) || error || ""));
}

/**
 * Per-harness handshake budgets.
 *
 * The previous flat 12_000 was below what a real harness needs. Measured
 * session/new on this machine: hermes 27311ms, grok 5773ms, goose 5ms,
 * kimi 1063ms. Hermes could therefore NEVER complete a handshake, and grok sat
 * at only a 2x margin — a loaded machine tips it over too.
 *
 * Override with AGENSIS_ACP_HANDSHAKE_MS for a host that is slower still.
 */
const HANDSHAKE_BUDGETS = {
  default: { initialize: 20_000, newSession: 45_000 },
  // Measured 27.3s cold; give real headroom rather than a value that just
  // happens to pass on one machine.
  hermes: { initialize: 30_000, newSession: 90_000 },
};

export function handshakeBudget(harnessId) {
  const override = Number(process.env.AGENSIS_ACP_HANDSHAKE_MS || 0);
  if (override > 0) return { initialize: override, newSession: override };
  return HANDSHAKE_BUDGETS[String(harnessId || "").toLowerCase()] || HANDSHAKE_BUDGETS.default;
}

/**
 * Consecutive handshake timeouts per harness. Cleared on any success.
 * Only after this many in a row do we stop trying ACP for the process.
 */
const HANDSHAKE_STRIKES_BEFORE_GIVING_UP = 3;
const handshakeStrikes = new Map();

/**
 * The pool identity of a session. Tools, permission mode and model are all fixed
 * at process/session start, so any change must open a new session.
 *
 * Exported so prewarm computes the SAME key the first real job will look up —
 * a prewarm under a different key is not a warm session, it is a stray process.
 */
export function acpPoolKey({ id, sessionKey, permissionMode, model, mcpServers = [] }) {
  return `${id}::${sessionKey}::${permissionMode}::${model || "auto"}::${mcpServers.map((s) => s.url).join(",")}`;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

/**
 * Spawn a harness and complete the ACP handshake. Shared by the job path and by
 * prewarm so both use one set of budgets and one definition of "ready".
 */
async function openAcpSession({ resolved, id, cwd, mcpServers, permissionMode, log = console, signal }) {
  const client = createAcpClient({
    command: resolved.command,
    args: resolved.args,
    cwd,
    autoApprove: true,
    // Without these the agent has no workspace tools and is asked to
    // approve every call despite whatever mode it was configured with.
    mcpServers,
    permissionMode,
    clientName: "agensis-agent",
    onLog: () => {},
  });
  if (signal?.aborted) {
    client.dispose();
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
  // Fail when an adapter is on PATH but broken / hung — classic path takes
  // over. Budgets are per-harness because a flat cap silently demoted the
  // slowest (and only the slowest) harnesses to the 6x-slower path.
  const budget = handshakeBudget(id);
  const tHandshake = Date.now();
  try {
    await withTimeout(client.initialize(), budget.initialize, "ACP initialize");
    await withTimeout(client.newSession(cwd), budget.newSession, "ACP session/new");
  } catch (error) {
    try { client.dispose(); } catch { /* ignore */ }
    throw error;
  }
  const handshakeMs = Date.now() - tHandshake;
  // One line per session, not per turn — the handshake is paid once and
  // every later turn on this session reuses it.
  log.log?.(`[acp] ${id} session ready in ${handshakeMs}ms (warm from here)`);
  handshakeStrikes.delete(id);
  return { client, harnessId: id, cwd };
}

/**
 * Whether ACP should be attempted for this job (default on).
 * Disable with --no-acp or AGENSIS_ACP=0.
 */
export function acpPreferred({ config, env = process.env } = {}) {
  if (config?.noAcp === true) return false;
  if (config?.acp === false) return false;
  const flag = env.AGENSIS_ACP;
  if (flag !== undefined && flag !== "" && /^(0|false|off|no)$/i.test(String(flag).trim())) {
    return false;
  }
  return true;
}

export function harnessAvailable(harnessId, opts = {}) {
  if (!harnessId || acpUnavailable.has(harnessId)) return false;
  // A native runtime is never "an available ACP harness", even when its adapter
  // happens to be installed. claude-code-acp being on PATH is not a reason to
  // stop using the Claude Agent SDK.
  if (usesNativeRuntime(harnessId)) return false;
  return Boolean(resolveHarness(harnessId, opts));
}

/**
 * Will this job actually run over ACP on this host? The same gate
 * createPreferAcpExecutor applies, exposed so a caller can set up its output
 * handling BEFORE the run rather than guessing after it.
 *
 * This matters because the two paths speak different formats: ACP streams and
 * returns PLAIN TEXT, while the classic `claude -p` path emits stream-json
 * NDJSON. A caller that parses one as the other silently ends up with nothing.
 */
export function willUseAcp({ job, family, config } = {}) {
  if (!acpPreferred({ config })) return false;
  const harnessId = preferredHarnessId({ job, family, config });
  return Boolean(harnessId && harnessAvailable(harnessId));
}

/**
 * @param {{ job?: object, family?: string|null, config?: object }} ctx
 */
export function createAcpExecutor(ctx = {}) {
  const { job, family, config, log = console } = ctx;
  const harnessId = preferredHarnessId({ job, family, config });
  const harness = harnessId ? resolveHarness(harnessId) : null;

  return {
    harnessId: harness?.id || harnessId || null,
    available: Boolean(harness),
    async run(opts = {}) {
      const id = harness?.id || preferredHarnessId({ job: opts.job || job, family, config });
      // The single place an ACP adapter is ever spawned, so it is also the place
      // the native-runtime rule has to hold no matter which caller got here.
      // claude / codex / amp are driven directly (SDK, app-server, Amp CLI) and
      // must not be demoted to a plain-text adapter just because one is on PATH.
      if (usesNativeRuntime(id)) {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: new Error(`${id} runs on its native runtime, not ACP`),
          stop: null,
          acp: false,
        };
      }
      if (!id || acpUnavailable.has(id)) {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: new Error(`ACP harness "${id || "unknown"}" is not available`),
          stop: null,
          acp: false,
        };
      }
      // Prefer the job's model (agent row) over the connect-command default so a
      // model change in the UI takes effect without restarting the daemon.
      const model = String(
        opts.model
        || opts.job?.agent?.model
        || opts.job?.model
        || job?.agent?.model
        || job?.model
        || config?.model
        || "",
      ).trim();
      const resolved = resolveHarness(id, { model });
      if (!resolved) {
        acpUnavailable.add(id);
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: new Error(`ACP harness "${id}" is not installed on this host`),
          stop: null,
          acp: false,
        };
      }

      const cwd = opts.cwd || config?.cwd || process.cwd();
      const promptText = opts.prompt != null
        ? String(opts.prompt)
        : String(Array.isArray(opts.args) ? opts.args[opts.args.length - 1] : "");
      const mcpServers = acpMcpServers(opts.mcp);
      const permissionMode = acpPermissionMode(opts.permissionMode);
      const sessionKey = String(opts.sessionKey || `${id}:${cwd}`);
      // Tools, permission mode, AND model are fixed at process/session start, so
      // a change to any of them must open a NEW session rather than silently
      // reuse one built with the previous selection.
      const poolKey = acpPoolKey({ id, sessionKey, permissionMode, model, mcpServers });

      let entry = sessionPool.get(poolKey);
      if (entry?.client?.closed) {
        try { entry.client.dispose(); } catch { /* ignore */ }
        sessionPool.delete(poolKey);
        entry = null;
      }

      try {
        if (!entry) {
          entry = await openAcpSession({
            resolved, id, cwd, mcpServers, permissionMode, log, signal: opts.signal,
          });
          sessionPool.set(poolKey, entry);
        }

        const onAbort = () => {
          try { entry.client.cancel(); } catch { /* ignore */ }
        };
        opts.signal?.addEventListener?.("abort", onAbort, { once: true });

        let streamed = "";
        const result = await entry.client.prompt(promptText, {
          onChunk: (bit) => {
            streamed += bit;
            if (typeof opts.onData === "function") opts.onData(bit);
          },
        });
        opts.signal?.removeEventListener?.("abort", onAbort);

        const text = result.text || streamed || "";
        return {
          status: 0,
          stdout: text,
          stderr: "",
          error: null,
          stop: result.stopReason || "end_turn",
          acp: true,
          harnessId: id,
        };
      } catch (error) {
        if (entry) {
          try { entry.client.dispose(); } catch { /* ignore */ }
          sessionPool.delete(poolKey);
        }
        // A timeout is transient — retry it next turn. Anything else (ENOENT,
        // broken adapter) is structural and disables ACP immediately.
        if (looksTransient(error)) {
          const strikes = (handshakeStrikes.get(id) || 0) + 1;
          handshakeStrikes.set(id, strikes);
          log.warn?.(
            `[acp] ${id} handshake timed out (${strikes}/${HANDSHAKE_STRIKES_BEFORE_GIVING_UP}): ${error.message}. `
            + "Falling back to the classic path for THIS turn — it re-spawns the CLI cold and is markedly slower. "
            + "Raise AGENSIS_ACP_HANDSHAKE_MS if this host is just slow.",
          );
          if (strikes >= HANDSHAKE_STRIKES_BEFORE_GIVING_UP) {
            acpUnavailable.add(id);
            log.warn?.(
              `[acp] ${id} disabled for this daemon after ${strikes} consecutive handshake timeouts. `
              + "Every turn now uses the slower classic path until restart.",
            );
          }
        } else if (looksLikeUnavailable(error)) {
          acpUnavailable.add(id);
          log.warn?.(`[acp] ${id} unavailable (${error.message}); using the classic path for this daemon.`);
        }
        return {
          status: null,
          stdout: "",
          stderr: "",
          error,
          stop: null,
          acp: false,
          harnessId: id,
        };
      }
    },
  };
}

/**
 * Prefer ACP when harness is available; otherwise use `fallback` executor.
 * Once a harness is marked unavailable, skips ACP for the process lifetime.
 *
 * Native runtimes (claude / codex / amp) never reach the ACP branch — see
 * harnessAvailable. createExecutor does not even wrap them in this executor;
 * the gate here is the backstop for any other caller.
 */
export function createPreferAcpExecutor({ job, family, config, fallback, log = console } = {}) {
  const classic = fallback;
  return {
    async run(opts) {
      if (!acpPreferred({ config })) return classic.run(opts);
      const harnessId = preferredHarnessId({ job: opts.job || job, family, config });
      if (!harnessId || !harnessAvailable(harnessId)) return classic.run(opts);

      const acp = createAcpExecutor({ job: opts.job || job, family, config, log });
      const result = await acp.run({ ...opts, job: opts.job || job });
      if (!result.error) {
        log.log?.(`[executor] ACP harness ${result.harnessId || harnessId} completed job`);
        return result;
      }
      if (looksLikeUnavailable(result.error)) {
        // Loud, and explicit about the cost. This fallback used to be a quiet
        // log.log at the same level as a success — which is precisely why a
        // permanent 6x slowdown went unnoticed.
        log.warn?.(
          `[executor] ACP harness ${harnessId} did not run this job (${result.error.message}). `
          + "Falling back to the classic CLI path, which starts the tool cold on every turn.",
        );
        return classic.run(opts);
      }
      // Real job failure on ACP — do not silently re-run classic (double spend).
      return result;
    },
  };
}

/**
 * Open the ACP session at connect time instead of on the first job.
 *
 * The handshake is paid once per session either way; prewarming just moves it
 * off the critical path so the first human-visible turn is already warm
 * (measured: 6.3s of handshake that a person would otherwise sit through).
 *
 * Deliberately NEVER prewarms claude / codex / amp. Those have native lanes —
 * the Claude Agent SDK and the Codex app-server — and are the paths that
 * currently stream correctly. This function must not spawn anything for them.
 *
 * Best-effort by contract: it never throws and never blocks connect. A failure
 * here is not a job failure — the first job simply handshakes as it does today.
 *
 * @returns {Promise<{ prewarmed: boolean, harnessId?: string, ms?: number, reason?: string }>}
 */
export async function prewarmAcpSession({ job, family, config, log = console, sessionKey, mcp } = {}) {
  try {
    if (!acpPreferred({ config })) return { prewarmed: false, reason: "acp disabled" };
    const id = preferredHarnessId({ job, family, config });
    if (!id) return { prewarmed: false, reason: "no harness" };
    // Native lanes own these. Never pre-spawn a harness for them.
    if (usesNativeRuntime(id)) {
      return { prewarmed: false, reason: `${id} uses its native runtime, not ACP` };
    }
    if (!harnessAvailable(id)) return { prewarmed: false, reason: `${id} not installed` };

    const model = String(config?.model || "").trim();
    const resolved = resolveHarness(id, { model });
    if (!resolved) return { prewarmed: false, reason: `${id} did not resolve` };

    const cwd = config?.cwd || process.cwd();
    const mcpServers = acpMcpServers(mcp);
    const permissionMode = acpPermissionMode(config?.permissionMode);
    const key = acpPoolKey({
      id,
      sessionKey: String(sessionKey || `${id}:${cwd}`),
      permissionMode,
      model,
      mcpServers,
    });
    if (sessionPool.has(key)) return { prewarmed: false, reason: "already warm" };

    const t0 = Date.now();
    const entry = await openAcpSession({ resolved, id, cwd, mcpServers, permissionMode, log });
    sessionPool.set(key, entry);
    const ms = Date.now() - t0;
    log.log?.(`[acp] prewarmed ${id} in ${ms}ms — the first turn will not pay the handshake`);
    return { prewarmed: true, harnessId: id, ms };
  } catch (error) {
    // Never let a prewarm failure affect connect. The job path retries anyway.
    log.warn?.(`[acp] prewarm skipped: ${error?.message || error}`);
    return { prewarmed: false, reason: String(error?.message || error) };
  }
}

/** Test seam: clear unavailability + pool. */
export function resetAcpExecutorState() {
  acpUnavailable.clear();
  handshakeStrikes.clear();
  for (const entry of sessionPool.values()) {
    try { entry.client.dispose(); } catch { /* ignore */ }
  }
  sessionPool.clear();
}
