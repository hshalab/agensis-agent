// ACP coding executor for the Relay CLI.
// Prefers a local ACP harness when installed; same {status,stdout,stderr,error,stop}
// contract as LocalExecutor / connection executors.

import { createAcpClient } from "./client.mjs";
import { preferredHarnessId, resolveHarness } from "./harnesses.mjs";

const acpUnavailable = new Set();
/** @type {Map<string, { client: ReturnType<typeof createAcpClient>, harnessId: string, cwd: string }>} */
const sessionPool = new Map();

function looksLikeUnavailable(error) {
  const message = String((error && error.message) || error || "");
  return /ENOENT|command not found|not available|not installed|ACP process exited|Cannot find module|timed out|EACCES/i.test(message);
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
  const { job, family, config } = ctx;
  const harnessId = preferredHarnessId({ job, family, config });
  const harness = harnessId ? resolveHarness(harnessId) : null;

  return {
    harnessId: harness?.id || harnessId || null,
    available: Boolean(harness),
    async run(opts = {}) {
      const id = harness?.id || preferredHarnessId({ job: opts.job || job, family, config });
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
      const resolved = resolveHarness(id);
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
      const sessionKey = String(opts.sessionKey || `${id}:${cwd}`);
      const poolKey = `${id}::${sessionKey}`;

      let entry = sessionPool.get(poolKey);
      if (entry?.client?.closed) {
        try { entry.client.dispose(); } catch { /* ignore */ }
        sessionPool.delete(poolKey);
        entry = null;
      }

      const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          if (typeof t.unref === "function") t.unref();
        }),
      ]);

      try {
        if (!entry) {
          const client = createAcpClient({
            command: resolved.command,
            args: resolved.args,
            cwd,
            autoApprove: true,
            clientName: "agensis-agent",
            onLog: () => {},
          });
          if (opts.signal?.aborted) {
            client.dispose();
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          // Fail fast when an adapter is on PATH but broken / hung — classic path takes over.
          await withTimeout(client.initialize(), 12_000, "ACP initialize");
          await withTimeout(client.newSession(cwd), 12_000, "ACP session/new");
          entry = { client, harnessId: id, cwd };
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
        if (looksLikeUnavailable(error)) acpUnavailable.add(id);
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
 */
export function createPreferAcpExecutor({ job, family, config, fallback, log = console } = {}) {
  const classic = fallback;
  return {
    async run(opts) {
      if (!acpPreferred({ config })) return classic.run(opts);
      const harnessId = preferredHarnessId({ job: opts.job || job, family, config });
      if (!harnessId || !harnessAvailable(harnessId)) return classic.run(opts);

      const acp = createAcpExecutor({ job: opts.job || job, family, config });
      const result = await acp.run({ ...opts, job: opts.job || job });
      if (!result.error) {
        log.log?.(`[executor] ACP harness ${result.harnessId || harnessId} completed job`);
        return result;
      }
      if (looksLikeUnavailable(result.error)) {
        log.log?.(`[executor] ACP harness ${harnessId} unavailable (${result.error.message}); falling back to classic CLI path`);
        return classic.run(opts);
      }
      // Real job failure on ACP — do not silently re-run classic (double spend).
      return result;
    },
  };
}

/** Test seam: clear unavailability + pool. */
export function resetAcpExecutorState() {
  acpUnavailable.clear();
  for (const entry of sessionPool.values()) {
    try { entry.client.dispose(); } catch { /* ignore */ }
  }
  sessionPool.clear();
}
