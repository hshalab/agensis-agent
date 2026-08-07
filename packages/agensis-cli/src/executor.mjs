// packages/agensis-cli/src/executor.mjs
// The single seam where an agent's coding CLI runs. LocalExecutor keeps today's
// behavior (spawn a fresh `claude`/`codex` process per job) as the fallback
// path. PrimaryExecutor prefers a warm, reused connection (the Claude Agent
// SDK / codex app-server, see connectionExecutors.mjs) and falls back to
// LocalExecutor the first time that connection proves unavailable on this
// host. SandboxExecutor runs the same {cmd,args} in a remote sandbox via an
// injected provider. createExecutor picks one by run_mode + coding-CLI family.
//
// Claude and Codex go straight to PrimaryExecutor. ACP is only for the
// harnesses with no native lane here — see createExecutor below.
import { runCli } from "./cli.mjs";
import { createClaudeSdkExecutor, createCodexAppServerExecutor } from "./connectionExecutors.mjs";
import { createPreferAcpExecutor } from "./acp/executor.mjs";
import { preferredHarnessId, usesNativeRuntime } from "./acp/harnesses.mjs";
import { createDirectExecutor, directRunnerFor } from "./acp/direct.mjs";

export function createLocalExecutor({ run = runCli } = {}) {
  return { run: (opts) => run(opts) };
}

// Lazy singletons: one warm connection pool per family, shared across every
// job for the life of the daemon process (that reuse IS the "fast connection"
// win — see connectionExecutors.mjs for what each pool keeps alive).
let claudeSdkExecutorSingleton = null;
let codexAppServerExecutorSingleton = null;

// A family that has failed once (SDK not installed, `codex app-server`
// missing/erroring) is remembered so every subsequent job goes straight to
// LocalExecutor instead of re-probing and eating the failure's latency again.
const confirmedUnavailable = new Set();

function looksLikeUnavailable(error) {
  const message = String((error && error.message) || error || "");
  return /Cannot find module|ERR_MODULE_NOT_FOUND|ENOENT|command not found/i.test(message);
}

/**
 * Prefers a warm connection for `family` ('claude' | 'codex'); falls back to
 * LocalExecutor (today's subprocess-per-job behavior, unchanged) the first
 * time that connection's own error looks like "not installed on this host"
 * rather than a normal job failure.
 */
export function createPrimaryExecutor(family, { local, pooled, log = console } = {}) {
  const localExecutor = local || createLocalExecutor();
  const pooledExecutor = pooled || (
    family === "claude" ? (claudeSdkExecutorSingleton ||= createClaudeSdkExecutor())
      : family === "codex" ? (codexAppServerExecutorSingleton ||= createCodexAppServerExecutor())
        : null
  );
  if (!pooledExecutor) return localExecutor;
  return {
    async run(opts) {
      if (confirmedUnavailable.has(family)) return localExecutor.run(opts);
      const result = await pooledExecutor.run(opts);
      if (result.error && looksLikeUnavailable(result.error)) {
        confirmedUnavailable.add(family);
        log.log?.(`[executor] ${family} fast connection unavailable (${result.error.message}); falling back to subprocess mode for this and future jobs.`);
        return localExecutor.run(opts);
      }
      return result;
    },
  };
}

// Orchestrates one sandbox run through a provider: ensureEnv -> putRepo -> exec
// -> getResult -> destroy. Streams onData through exec, folds the resulting patch
// into stdout as a fenced diff, ALWAYS destroys (even on throw), and returns the
// runCli-shaped { status, stdout, stderr, error }.
export function createSandboxExecutor(provider) {
  return {
    async run({ cmd, args = [], env = {}, onData, signal, job }) {
      let handle = null;
      try {
        handle = await provider.ensureEnv({ job, signal });
        await provider.putRepo(handle, { job, signal });
        const exec = await provider.exec(handle, { cmd, args, env, onData, signal });
        const result = await provider.getResult(handle, { job }).catch(() => ({}));
        const patch = result && result.patch ? String(result.patch).trim() : "";
        const stdout = patch
          ? `${exec.stdout || ""}\n\n\`\`\`diff\n${patch}\n\`\`\``
          : exec.stdout || "";
        // `stop` rides through unchanged. This object is REBUILT rather than
        // spread, so any new field the inner executor reports has to be named
        // here or it is silently dropped — which is exactly how the SDK's
        // stop_reason/usage/cost went missing for so long.
        return { status: exec.status, stdout, stderr: exec.stderr || "", error: exec.error || null, stop: exec.stop || null };
      } catch (error) {
        return { status: null, stdout: "", stderr: "", error, stop: null };
      } finally {
        if (handle) { try { await provider.destroy(handle); } catch { /* teardown must never throw */ } }
      }
    },
  };
}

/**
 * Pick how a coding job runs on this host.
 *
 * Order of preference:
 *   1. Native runtime — the Claude Agent SDK for `claude`, `codex app-server`
 *      for `codex`. These are the fast lane AND the rich one: one warm session
 *      per silo, plus typed tool steps, text segments, stop reasons and token
 *      usage. They are chosen outright, never put behind ACP.
 *   2. ACP — for the harnesses that have no native lane here (hermes, grok,
 *      goose, kimi, cursor, opencode, openclaw), so the Relay CLI can use the
 *      same local adapters as desktop.
 *   3. Classic subprocess (`claude -p` / `codex exec` / custom coding-cmd), or
 *      the harness's own headless mode, when neither of the above applies.
 *
 * 0.1.48 wrapped EVERY job in createPreferAcpExecutor, and preferredHarnessId
 * answers "claude"/"codex" for those families — so merely having
 * claude-code-acp on PATH silently demoted Claude jobs from the SDK to a
 * plain-text adapter, losing the step strip, segments, stop reasons and usage
 * counts with nothing in the logs to say why. Native runtimes are now chosen
 * before ACP is considered at all.
 *
 * Disable ACP entirely with --no-acp or AGENSIS_ACP=0.
 */
export function createExecutor(job, { makeProvider, family, config } = {}) {
  const runMode = job && job.agent && job.agent.run_mode;
  if (runMode === "sandbox") {
    const factory = makeProvider || defaultSandboxProviderFactory;
    return createSandboxExecutor(factory(job));
  }
  // A resolved family IS the statement that this host can drive the tool
  // natively: agensis.mjs only sets it when fast connections are enabled and the
  // command is the bare `claude`/`codex` binary. Nothing else may pre-empt it.
  if (family === "claude" || family === "codex") return createPrimaryExecutor(family);
  return createPreferAcpExecutor({ job, family, config, fallback: directFallbackFor({ job, family, config }) || createLocalExecutor() });
}

/**
 * The right fallback for a harness agent when ACP cannot run.
 *
 * Without this, a Grok/Kimi/Goose agent that loses ACP drops to LocalExecutor,
 * which runs the generic coding command — `claude -p` by default. That is not
 * merely slower, it answers as the WRONG MODEL: the agent silently becomes
 * Claude. Falling back to the tool's own headless mode keeps identity intact.
 *
 * Returns null (keep the existing fallback) for claude / codex / amp, which
 * have native runtimes and must not be routed through a direct spawn.
 */
function directFallbackFor({ job, family, config }) {
  if (family === "claude" || family === "codex") return null;
  const id = preferredHarnessId({ job, family, config });
  if (!id || usesNativeRuntime(id)) return null;
  if (!directRunnerFor(id)) return null;
  return createDirectExecutor({ harnessId: id, config });
}

// Default factory: builds a provider from job.agent.sandbox_provider + env secrets.
// Kept out of the hot path so tests inject their own via makeProvider.
function defaultSandboxProviderFactory(job) {
  const providerName = (job.agent && job.agent.sandbox_provider) || "e2b";
  const config = (job.agent && job.agent.sandbox_config) || {};
  if (providerName !== "e2b") {
    throw new Error(`Sandbox provider "${providerName}" is not available yet (only e2b is wired).`);
  }
  return createE2bProviderLazy({
    apiKey: process.env.E2B_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    gitToken: process.env.GIT_TOKEN || "",
    repoUrl: job.repoUrl || (job.agent && job.agent.repo_url) || config.repoUrl || "",
    template: config.template || "",
  });
}

// Defer the e2b import so `import('./executor.mjs')` in unit tests never pulls the
// e2b SDK — it loads only when a sandbox job actually runs.
// e2b's engine floor is Node >=20.18.1. Compare the running version numerically
// so a sandbox run on an unsupported Node fails with a clear message up front.
// `version` is injectable for tests; defaults to the running Node version.
export function nodeSupportsE2b(version = process.versions.node) {
  // e2b engine: >=20.18.1 <21 || >=22 (Node 21 is explicitly excluded).
  const [maj, min, patch] = String(version).split(".").map((n) => Number(n) || 0);
  if (maj === 21) return false;
  if (maj >= 22) return true;
  if (maj !== 20) return false;
  if (min > 18) return true;
  if (min < 18) return false;
  return patch >= 1;
}

function createE2bProviderLazy(opts) {
  let real = null;
  const ensureReal = async () => {
    if (!real) {
      // e2b is an OPTIONAL dependency (it requires Node >=20.18.1, while the
      // daemon core supports Node >=18). Give a clear, actionable error instead
      // of a raw MODULE_NOT_FOUND when a sandbox job runs without it installed.
      // Sandbox mode needs Node >=20.18.1 (e2b's engine floor). npm engine checks
      // are only warnings, so e2b can install on Node 18 and then fail cryptically
      // at import — check the runtime version FIRST and fail with a clear message.
      if (!nodeSupportsE2b()) {
        throw new Error(`Sandbox execution requires Node >=20.18.1 (you have ${process.versions.node}). Upgrade Node to use Sandbox agents; Direct and Relay modes still work on Node 18.`);
      }
      // The Node-version check above fails fast on an unsupported runtime. The
      // adapter module itself has no top-level e2b import (e2b loads lazily inside
      // its ensureEnv, which throws a clear 'optional package not installed'
      // message), so importing the adapter here is always safe.
      const mod = await import("./sandbox/e2b.mjs");
      real = mod.createE2bProvider(opts);
    }
    return real;
  };
  return {
    ensureEnv: async (a) => (await ensureReal()).ensureEnv(a),
    putRepo: async (h, a) => (await ensureReal()).putRepo(h, a),
    exec: async (h, a) => (await ensureReal()).exec(h, a),
    getResult: async (h, a) => (await ensureReal()).getResult(h, a),
    destroy: async (h) => (await ensureReal()).destroy(h),
  };
}
