// ACP harness catalog for the Relay CLI — same spawn recipes as desktop Electron.
// When a harness is available we prefer ACP; otherwise classic subprocess/SDK paths run.

import { resolveCommandPath } from "./resolve.mjs";

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
