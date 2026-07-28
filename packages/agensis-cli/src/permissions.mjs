// packages/agensis-cli/src/permissions.mjs
//
// Interactive tool approvals: the daemon asks a HUMAN, in the chat, before a
// coding CLI runs a tool it isn't already cleared for.
//
// Why this exists at all. The daemon runs headless on someone else's machine,
// so the coding CLI's own terminal prompt has nobody in front of it. Worse, the
// usual escape hatch — writing grants into ~/.claude/settings.local.json — is
// inert here: lean mode passes `settingSources: []` to the SDK (see
// connectionExecutors.mjs) and `--safe-mode` to the subprocess CLI, so no
// settings file on the host is ever read. An operator who edits one sees no
// effect, restarts, and still sees no effect, because the file was never in the
// picture. Before this module the only working answer was permission_mode
// 'yolo' — unrestricted shell — to let an agent run one `git clone`.
//
// So the grant list is ours, not a file's: a decision travels back to Agensis,
// a human answers it there, and a permanent answer is stored on the agent
// (workspace_agents.metadata.permission_rules) and replayed into every later
// job.
//
// Rule identity is deliberately NOT a glob matcher we wrote. The SDK hands us
// `suggestions` — the exact rules it would write if the human picked "always
// allow" — on EVERY request. A stored rule matches when it is byte-identical to
// one of the rules the SDK is offering right now. That means we never have to
// reimplement Claude's `Bash(git clone:*)` matching semantics and can never
// drift from them: two `git clone`s produce the same suggestion, so the second
// one matches; anything Claude considers a different permission produces a
// different suggestion and gets asked again. The failure direction is safe —
// a rule we fail to match costs one extra prompt, never an ungranted tool call.

import crypto from "node:crypto";

/**
 * How long a request parks waiting for a human before it auto-denies.
 *
 * Comfortably under DEFAULT_TIMEOUT_MS (30m, agensis.mjs) on purpose: the job's
 * own timeout kills the whole turn with a generic timeout error, which reads to
 * the human as "the agent broke". Expiring first lets the model receive an
 * explicit "nobody approved this" denial and say so in its reply.
 */
export const PERMISSION_REQUEST_TTL_MS = Number(process.env.AGENSIS_PERMISSION_TIMEOUT_MS || 10 * 60 * 1000);

/** Scopes a human can answer with. 'once' grants nothing beyond this one call. */
export const PERMISSION_SCOPES = ["once", "session", "always"];

/**
 * Canonical string for one permission rule — `Bash(git clone:*)`, or bare
 * `WebFetch` for a whole-tool rule. This is the only form stored on the agent
 * and the only form compared, so a rule that round-trips through the server's
 * jsonb column is still the same string it was when the human approved it.
 */
export function ruleKey(rule) {
  const toolName = String(rule?.toolName ?? "").trim();
  if (!toolName) return "";
  const content = String(rule?.ruleContent ?? "").trim();
  return content ? `${toolName}(${content})` : toolName;
}

/** Parse a canonical rule key back into {toolName, ruleContent} for display. */
export function parseRuleKey(key) {
  const raw = String(key || "").trim();
  const open = raw.indexOf("(");
  if (open <= 0 || !raw.endsWith(")")) return raw ? { toolName: raw } : null;
  const toolName = raw.slice(0, open).trim();
  const ruleContent = raw.slice(open + 1, -1).trim();
  if (!toolName) return null;
  return ruleContent ? { toolName, ruleContent } : { toolName };
}

/**
 * The rule keys a set of SDK permission suggestions would GRANT.
 *
 * Only `addRules` with behavior 'allow' is taken. A suggestion carrying
 * `setMode` would flip the whole session's permission mode, and
 * `addDirectories` would widen the filesystem allowlist — both are far larger
 * than the tool call the human is looking at, and directories in particular are
 * host_folders' job (server-gated, manage-only). Storing either under an
 * innocuous "always allow this command" click would grant something nobody
 * agreed to.
 */
export function suggestionRuleKeys(suggestions) {
  const keys = [];
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    if (!suggestion || suggestion.type !== "addRules" || suggestion.behavior !== "allow") continue;
    for (const rule of Array.isArray(suggestion.rules) ? suggestion.rules : []) {
      const key = ruleKey(rule);
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * Stored rules for a job, from `workspace_agents.metadata.permission_rules`.
 *
 * Accepts both the canonical strings this module writes and raw
 * {toolName, ruleContent} objects, because the column is jsonb written by the
 * server and read by a daemon that may be older or newer than it.
 */
export function normalizeStoredRules(raw) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.allow) ? raw.allow : [];
  const keys = [];
  for (const entry of source) {
    const key = typeof entry === "string" ? entry.trim() : ruleKey(entry);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Stored permission rules carried by a job payload, most specific first. */
export function jobPermissionRules(job) {
  return normalizeStoredRules(
    job?.agent?.metadata?.permission_rules
    ?? job?.agent?.permissionRules
    ?? job?.permissionRules
    ?? job?.permission_rules,
  );
}

/**
 * Is this request already covered by a rule the human granted permanently?
 *
 * Whole-tool rules (`WebFetch`, no content) match any request for that tool —
 * that is what a content-free rule means. Everything else must be an exact
 * match against a rule the SDK is offering for THIS call, per the note at the
 * top of the file.
 */
export function isAllowedByStoredRules(storedKeys, { toolName, suggestions } = {}) {
  const stored = Array.isArray(storedKeys) ? storedKeys : [];
  if (stored.length === 0) return false;
  const tool = String(toolName || "").trim();
  if (tool && stored.includes(tool)) return true;
  return suggestionRuleKeys(suggestions).some((key) => stored.includes(key));
}

/** A denial the model can act on, rather than an opaque tool error. */
function denial(message) {
  return { behavior: "deny", message };
}

/**
 * Asks Agensis for a decision and parks until a human answers.
 *
 * `send` returns false when the socket is gone. That is a hard deny rather than
 * a park: nobody will ever see a request that was never delivered, and parking
 * on it would hold the turn open until the job's own 30-minute timeout.
 *
 * @param {{ send: (frame: object) => boolean, timeoutMs?: number, log?: (line: string) => void, idFactory?: () => string }} deps
 */
export function createPermissionBroker({
  send,
  timeoutMs = PERMISSION_REQUEST_TTL_MS,
  log = () => {},
  idFactory = () => crypto.randomUUID(),
} = {}) {
  if (typeof send !== "function") throw new Error("createPermissionBroker requires send()");
  const pending = new Map(); // requestId -> { jobId, settle }

  const settle = (requestId, result) => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  };

  return {
    /**
     * @returns {Promise<{behavior: 'allow'|'deny', scope?: string, message?: string, decidedBy?: string}>}
     */
    request({ jobId, toolName, title, description, detail, input, suggestions, signal } = {}) {
      const requestId = idFactory();
      const ruleKeys = suggestionRuleKeys(suggestions);
      const delivered = send({
        action: "agent_permission_request",
        jobId: jobId || "",
        requestId,
        toolName: String(toolName || "").trim(),
        title: String(title || "").trim(),
        description: String(description || "").trim(),
        detail: String(detail || "").trim(),
        input: input || null,
        // The rules an "always allow" click would grant, so the server can show
        // the human exactly what they are about to make permanent instead of a
        // vague "always allow this tool".
        rules: ruleKeys,
        scopes: ruleKeys.length > 0 ? PERMISSION_SCOPES : ["once", "session"],
        expiresInMs: timeoutMs,
      });
      if (!delivered) {
        return Promise.resolve(denial("Agensis was unreachable, so this tool call could not be approved."));
      }
      log(`permission requested for ${toolName || "a tool"} (${requestId})`);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          settle(requestId, denial(`Nobody approved this within ${Math.round(timeoutMs / 60000)} minutes. Ask again in the chat, or have the workspace grant it on the agent.`));
        }, timeoutMs);
        timer.unref?.();
        const entry = { jobId: jobId || "", timer, resolve };
        pending.set(requestId, entry);
        // A cancelled job must not leave a turn parked on a question whose
        // answer can no longer matter.
        signal?.addEventListener?.("abort", () => {
          settle(requestId, denial("The job was cancelled before this was approved."));
        }, { once: true });
      });
    },

    /** Apply an inbound `agent_permission_decision` frame. */
    decide(message) {
      const requestId = String(message?.requestId || "");
      if (!requestId || !pending.has(requestId)) return false;
      const allowed = message.behavior === "allow";
      const scope = PERMISSION_SCOPES.includes(message.scope) ? message.scope : "once";
      const decidedBy = String(message.decidedBy || "").trim();
      log(`permission ${allowed ? `allowed (${scope})` : "denied"} for ${requestId}${decidedBy ? ` by ${decidedBy}` : ""}`);
      return settle(requestId, allowed
        ? { behavior: "allow", scope, decidedBy }
        : denial(String(message.message || "").trim() || `${decidedBy || "The workspace"} denied this tool call.`));
    },

    /** Deny everything parked for a job that is going away. */
    cancelJob(jobId, reason = "The job ended before this was approved.") {
      const id = String(jobId || "");
      let cancelled = 0;
      for (const [requestId, entry] of [...pending.entries()]) {
        if (entry.jobId !== id) continue;
        if (settle(requestId, denial(reason))) cancelled += 1;
      }
      return cancelled;
    },

    /** Deny everything parked — the daemon is shutting down or lost its socket. */
    shutdown(reason = "The agent daemon disconnected before this was approved.") {
      let cancelled = 0;
      for (const requestId of [...pending.keys()]) {
        if (settle(requestId, denial(reason))) cancelled += 1;
      }
      return cancelled;
    },

    pendingCount() {
      return pending.size;
    },
  };
}
