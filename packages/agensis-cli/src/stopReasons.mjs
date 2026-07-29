// packages/agensis-cli/src/stopReasons.mjs
//
// One closed vocabulary for "why did this turn stop", shared by every runtime.
//
// The Claude Agent SDK already tells us this on every result — `stop_reason`,
// `terminal_reason`, `permission_denials`, `usage`, `total_cost_usd` — and until
// this module existed connectionExecutors.mjs read only `subtype` and binned the
// rest, so the server, the UI and the human all saw one opaque error string. The
// data was always on the wire; this is the reader for it.
//
// The vocabulary is deliberately OURS rather than the SDK's or ACP's, because it
// has to cover three runtimes (Claude SDK, codex app-server, Amp) plus the two
// deadlines the daemon itself enforces. Every mapper below funnels into this set,
// so one reader downstream handles all of them.
//
// Pure — no I/O, no imports — so it unit-tests without a subprocess, and so the
// server can keep a byte-identical copy of the enum without sharing code across
// two repos.

/** @typedef {'completed'|'cancelled'|'max_tokens'|'max_turns'|'max_budget'|'refused'|'idle_timeout'|'hard_timeout'|'permission_denied'|'agent_error'|'connection_lost'} StopReason */

export const STOP_REASONS = Object.freeze([
  "completed",
  "cancelled",
  "max_tokens",
  "max_turns",
  "max_budget",
  "refused",
  "idle_timeout",
  "hard_timeout",
  "permission_denied",
  "agent_error",
  "connection_lost",
]);

const STOP_REASON_SET = new Set(STOP_REASONS);

export function isStopReason(value) {
  return typeof value === "string" && STOP_REASON_SET.has(value);
}

/**
 * The `stop` object every executor result carries. One shape, so a downstream
 * reader never has to ask which runtime produced it or whether a field exists.
 *
 * @param {StopReason} reason
 * @param {string} [detail] runtime-native wording, for diagnosis only
 */
export function stopValue(reason, detail = "") {
  return { reason, detail, numTurns: 0, costUsd: 0, permissionDenials: 0, usage: null };
}

// `subtype` is the field we already read. These are the values
// @anthropic-ai/claude-agent-sdk documents on SDKResultMessage; anything not
// listed is a newer failure mode we have no name for, and lands on agent_error
// rather than being silently reported as a clean finish.
const SUBTYPE_TO_REASON = Object.freeze({
  success: "completed",
  error_max_turns: "max_turns",
  error_max_budget_usd: "max_budget",
  error_during_execution: "agent_error",
});

// `terminal_reason` is typed OPTIONAL on the SDK result and is not populated on
// every path, so it REFINES the subtype rather than replacing it: a value we
// recognise wins, a value we do not is ignored and the subtype's answer stands.
// The alternative — treating an unknown terminal_reason as "no reason" and
// falling through to `completed` — would report a failed turn as a clean finish,
// which is precisely the reporting bug this module exists to fix.
const TERMINAL_REASON_TO_REASON = Object.freeze({
  aborted_streaming: "cancelled",
  aborted_tools: "cancelled",
  max_turns: "max_turns",
  budget_exhausted: "max_budget",
  prompt_too_long: "max_tokens",
  refusal: "refused",
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Map one SDK `result` message onto the vocabulary above.
 *
 * @param {Record<string, unknown>} message
 * @returns {StopReason}
 */
export function stopReasonFromSdkResult(message) {
  const subtype = text(message?.subtype);
  const base = SUBTYPE_TO_REASON[subtype] || (subtype === "" ? "completed" : "agent_error");

  const terminal = text(message?.terminal_reason);
  const refined = TERMINAL_REASON_TO_REASON[terminal];
  if (refined) return refined;

  // Denials only ever upgrade the GENERIC failure bucket. A turn that hit its
  // turn cap and also had a tool denied along the way stopped because of the
  // cap; reporting "permission denied" there would name the wrong cause and
  // send the human to fix a permission that was not the problem.
  if (base === "agent_error" && count(message?.permission_denials) > 0) return "permission_denied";

  return base;
}

/**
 * The extra result fields the daemon used to discard. `usage` and `costUsd` are
 * carried so the server can persist them; see the server's normalizeStopReason
 * for what actually survives into the row.
 *
 * @param {Record<string, unknown>} message
 */
export function stopFromSdkResult(message) {
  const denials = count(message?.permission_denials);
  return {
    reason: stopReasonFromSdkResult(message),
    // The raw SDK words, kept for diagnosis. Untrusted at the far end: the
    // server length-caps and charset-restricts this before it is stored.
    detail: text(message?.terminal_reason) || text(message?.subtype),
    numTurns: Number(message?.num_turns) || 0,
    costUsd: Number(message?.total_cost_usd) || 0,
    permissionDenials: denials,
    usage: message?.usage && typeof message.usage === "object" ? message.usage : null,
  };
}

/**
 * codex app-server `turn/completed`. Its vocabulary is much thinner than the
 * SDK's — a status and an optional error — so most turns land on completed or
 * agent_error, and the point of routing it through here is that ONE downstream
 * reader handles every runtime.
 *
 * @param {Record<string, unknown>} params
 */
export function stopFromCodexTurn(params) {
  const status = text(params?.turn?.status);
  const error = params?.turn?.error;
  const reason = status === "cancelled" ? "cancelled"
    : status === "failed" || error ? "agent_error"
      : "completed";
  return stopValue(reason, status);
}

// Amp reports its own `amp_*` error codes (see runAmpAgentJob). Only the ones
// that mean something OTHER than "it broke" need naming; everything else is an
// agent_error, which is what an unmapped amp code honestly is.
const AMP_ERROR_CODE_TO_REASON = Object.freeze({
  amp_turn_cancelled: "cancelled",
});

/**
 * @param {string} errorCode
 * @param {boolean} failed whether the turn reported an error at all
 */
export function stopFromAmpResult(errorCode, failed) {
  const code = text(errorCode);
  const reason = AMP_ERROR_CODE_TO_REASON[code] || (failed || code ? "agent_error" : "completed");
  return stopValue(reason, code);
}
