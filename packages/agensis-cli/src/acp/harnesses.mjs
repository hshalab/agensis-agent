// ACP harness catalog for the Relay CLI — same spawn recipes as desktop Electron.
// ACP is for the harnesses that have no other lane here (grok, hermes, goose,
// kimi, cursor, opencode, openclaw). claude / codex / amp are NOT among them —
// see NATIVE_RUNTIME_HARNESSES below.

import { resolveCommandPath } from "./resolve.mjs";

/**
 * Runtimes this daemon drives directly, and which therefore must never be
 * routed through an ACP adapter.
 *
 * - claude -> @anthropic-ai/claude-agent-sdk query() (connectionExecutors.mjs)
 * - codex  -> `codex app-server` over stdio JSON-RPC (connectionExecutors.mjs)
 * - amp    -> the Amp CLI thread runtime (ampRuntime.mjs)
 *
 * Each keeps ONE warm session per silo across jobs and reports typed events —
 * tool steps, text segments, stop reasons, token usage. An ACP adapter for the
 * same tool returns plain text and none of that, so preferring it is a
 * downgrade, not a fast lane. This was already the rule for prewarming and for
 * the direct-spawn fallback; it is stated once here so the job path cannot
 * drift from it again.
 */
export const NATIVE_RUNTIME_HARNESSES = Object.freeze(["claude", "codex", "amp"]);

/** Does `harnessId` name a runtime this daemon drives natively? */
export function usesNativeRuntime(harnessId) {
  return NATIVE_RUNTIME_HARNESSES.includes(String(harnessId || "").trim().toLowerCase());
}

/**
 * @typedef {{ id: string, label: string, resolve: (opts?: object) => { command: string, args: string[], path: string } | null, installHint?: string }} AcpHarness
 */

/** @type {AcpHarness[]} */
export const ACP_HARNESSES = [
  {
    id: "grok",
    label: "Grok Build",
    installHint: "https://build.x.ai/docs",
    resolve(opts = {}) {
      const path = resolveCommandPath("grok", opts);
      if (!path) return null;
      // Model is a top-level `grok agent -m` option, BEFORE the stdio subcommand.
      // Without this, ACP always used ~/.grok/config.toml default and the
      // agent's selected model (and connect --model) was silently ignored —
      // which is how a host that could not use grok-4.5 looked "stuck" on it.
      const model = String(opts.model || "").trim();
      const args = ["agent"];
      if (model && model !== "auto") args.push("-m", model);
      args.push("--always-approve", "stdio");
      return { command: path, args, path };
    },
  },
  {
    id: "claude",
    label: "Claude Code",
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
    resolve(opts = {}) {
      for (const name of ["claude-agent-acp", "claude-code-acp"]) {
        const path = resolveCommandPath(name, opts);
        if (path) return { command: path, args: [], path };
      }
      return null;
    },
  },
  {
    id: "codex",
    label: "Codex",
    installHint: "npm install -g @agentclientprotocol/codex-acp",
    resolve(opts = {}) {
      const path = resolveCommandPath("codex-acp", opts);
      if (!path) return null;
      return { command: path, args: [], path };
    },
  },
  {
    id: "amp",
    label: "Amp",
    installHint: "https://github.com/tao12345666333/amp-acp",
    resolve(opts = {}) {
      const path = resolveCommandPath("amp-acp", opts);
      if (!path) return null;
      return { command: path, args: [], path };
    },
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    installHint: "https://hermes-agent.nousresearch.com",
    resolve(opts = {}) {
      const path = resolveCommandPath("hermes-acp", opts) || resolveCommandPath("hermes", opts);
      if (!path) return null;
      if (path.endsWith("hermes-acp") || path.includes("hermes-acp")) {
        return { command: path, args: [], path };
      }
      return { command: path, args: ["acp"], path };
    },
  },
  {
    id: "goose",
    label: "Goose",
    installHint: "https://goose-docs.ai/docs/getting-started/installation/",
    resolve(opts = {}) {
      const path = resolveCommandPath("goose", opts);
      if (!path) return null;
      return { command: path, args: ["acp"], path };
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    installHint: "https://cursor.com/downloads",
    resolve(opts = {}) {
      const path = resolveCommandPath("cursor-agent", opts);
      if (!path) return null;
      return { command: path, args: ["acp"], path };
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    installHint: "https://opencode.ai/docs",
    resolve(opts = {}) {
      const path = resolveCommandPath("opencode", opts);
      if (!path) return null;
      return { command: path, args: ["acp"], path };
    },
  },
  {
    id: "kimi",
    label: "Kimi Code",
    installHint: "https://kimi.ai/download",
    resolve(opts = {}) {
      const path = resolveCommandPath("kimi", opts);
      if (!path) return null;
      return { command: path, args: ["acp"], path };
    },
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    installHint: "https://docs.openclaw.ai/start/getting-started",
    resolve(opts = {}) {
      const path = resolveCommandPath("openclaw", opts);
      if (!path) return null;
      return { command: path, args: ["acp"], path };
    },
  },
];

/**
 * Every catalogued adapter and whether it is installed here.
 *
 * `available` answers "is this adapter on PATH", NOT "will this run over ACP" —
 * claude / codex / amp can report true here and still, correctly, run on their
 * native runtimes. Ask harnessAvailable() in acp/executor.mjs for the routing
 * question.
 */
export function listHarnesses(opts = {}) {
  return ACP_HARNESSES.map((h) => {
    const resolved = h.resolve(opts);
    return {
      id: h.id,
      label: h.label,
      available: Boolean(resolved),
      path: resolved?.path || null,
      command: resolved ? [resolved.command, ...resolved.args].join(" ") : null,
      installHint: h.installHint || null,
    };
  });
}

export function resolveHarness(harnessId, opts = {}) {
  const h = ACP_HARNESSES.find((x) => x.id === String(harnessId || "").trim());
  if (!h) return null;
  const resolved = h.resolve(opts);
  if (!resolved) return null;
  return { id: h.id, label: h.label, ...resolved };
}

/** Pick harness id from agent metadata, runtime pin, or coding-cli family. */
export function preferredHarnessId({ job, family, config } = {}) {
  const meta = job?.agent?.metadata && typeof job.agent.metadata === "object"
    ? job.agent.metadata
    : {};
  const fromMeta = String(meta.acp_harness || meta.acpHarness || "").trim().toLowerCase();
  if (fromMeta) return fromMeta;

  const fromConfig = String(config?.acpHarness || "").trim().toLowerCase();
  if (fromConfig) return fromConfig;

  const runtime = String(
    meta.executionRuntime || meta.runtime || config?.runtime || family || "",
  ).trim().toLowerCase();
  if (runtime === "claude" || runtime === "codex" || runtime === "amp") return runtime;
  if (family === "claude" || family === "codex") return family;
  return "";
}
