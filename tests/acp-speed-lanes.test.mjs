// ACP speed lanes: handshake budgets, prewarm gating, and the direct fallback.
//
// Context (measured on a real Mac, 2026-08, trivial prompt, grok):
//   warm ACP session ....  5221ms, 2525ms, 2426ms  (handshake 6331ms, paid once)
//   classic re-spawn ... 14191ms, 15394ms, 16956ms (paid EVERY turn)
//
// The old flat 12_000 handshake cap was below hermes' measured 27311ms
// session/new, so hermes timed out, was marked permanently unavailable, and
// every later turn silently took the ~6x slower path.
//
// The load-bearing guarantee in here is NEGATIVE: claude / codex / amp must
// never be prewarmed or routed through a direct spawn. They have native
// runtimes (Claude Agent SDK, Codex app-server) and those must not move.

import test from "node:test";
import assert from "node:assert/strict";

import {
  acpPoolKey,
  handshakeBudget,
  prewarmAcpSession,
  resetAcpExecutorState,
} from "../packages/agensis-cli/src/acp/executor.mjs";
import {
  DIRECT_RUNNERS,
  directRunnerFor,
  parseStreamLine,
  textFromStreamLine,
} from "../packages/agensis-cli/src/acp/direct.mjs";

test("handshake budgets clear the real measured cost", () => {
  // hermes measured 27311ms; the old flat cap was 12000ms, so it could never
  // finish a handshake. Anything at or under that is a regression.
  assert.ok(handshakeBudget("hermes").newSession > 27311, "hermes budget must exceed its measured 27.3s");
  assert.ok(handshakeBudget("grok").newSession > 12_000, "the default must beat the old flat cap");
  assert.ok(handshakeBudget("anything-unknown").newSession >= 45_000, "unknown harnesses get the default budget");
});

test("AGENSIS_ACP_HANDSHAKE_MS overrides the budget for a slow host", () => {
  const prev = process.env.AGENSIS_ACP_HANDSHAKE_MS;
  process.env.AGENSIS_ACP_HANDSHAKE_MS = "120000";
  try {
    assert.equal(handshakeBudget("grok").newSession, 120_000);
    assert.equal(handshakeBudget("hermes").initialize, 120_000);
  } finally {
    if (prev === undefined) delete process.env.AGENSIS_ACP_HANDSHAKE_MS;
    else process.env.AGENSIS_ACP_HANDSHAKE_MS = prev;
  }
});

// --- The Claude guarantee -------------------------------------------------

test("prewarm NEVER spawns anything for claude, codex or amp", async () => {
  resetAcpExecutorState();
  // Deliberately force ACP ON. Otherwise an ambient AGENSIS_ACP=0 (exactly how
  // desktop launches Claude) short-circuits the earlier gate and this test
  // passes without ever exercising the native-runtime guard it exists for.
  const prev = process.env.AGENSIS_ACP;
  process.env.AGENSIS_ACP = "1";
  try {
    for (const runtime of ["claude", "codex", "amp"]) {
      const result = await prewarmAcpSession({
        config: { runtime, cwd: "/tmp", model: "auto" },
        log: { log() {}, warn() {} },
        sessionKey: "ws:agent#0",
      });
      assert.equal(result.prewarmed, false, `${runtime} must not be prewarmed`);
      assert.match(result.reason, /native runtime/, `${runtime} must be refused for the right reason`);
    }
  } finally {
    if (prev === undefined) delete process.env.AGENSIS_ACP;
    else process.env.AGENSIS_ACP = prev;
  }
});

test("prewarm is a no-op when ACP is disabled (--no-acp / AGENSIS_ACP=0)", async () => {
  resetAcpExecutorState();
  // This is exactly how desktop launches Claude and Codex.
  const viaFlag = await prewarmAcpSession({
    config: { noAcp: true, acpHarness: "grok", cwd: "/tmp" },
    log: { log() {}, warn() {} },
  });
  assert.equal(viaFlag.prewarmed, false);
  assert.match(viaFlag.reason, /disabled/);
});

test("prewarm never throws, even on a harness that cannot resolve", async () => {
  resetAcpExecutorState();
  const result = await prewarmAcpSession({
    config: { acpHarness: "definitely-not-installed-xyz", cwd: "/tmp" },
    log: { log() {}, warn() {} },
  });
  assert.equal(result.prewarmed, false);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});

test("there is no direct runner for claude, codex or amp", () => {
  // If one of these ever gains a direct runner it would bypass the SDK /
  // app-server lane, which is the path that currently streams correctly.
  for (const id of ["claude", "codex", "amp"]) {
    assert.equal(DIRECT_RUNNERS[id], undefined, `${id} must not have a direct runner`);
    assert.equal(directRunnerFor(id), null, `${id} must not resolve a direct runner`);
  }
});

// --- Pool key -------------------------------------------------------------

test("prewarm computes the same pool key a job will look up", () => {
  const shape = {
    id: "grok",
    sessionKey: "ws-1:agent-1#0",
    permissionMode: "bypassPermissions",
    model: "grok-4.5",
    mcpServers: [{ url: "https://x/mcp" }],
  };
  // Same inputs must produce the same key, or a "prewarmed" session is really
  // just a stray process nobody ever finds.
  assert.equal(acpPoolKey(shape), acpPoolKey({ ...shape }));
  // Model is part of the identity: changing it must open a new session.
  assert.notEqual(acpPoolKey(shape), acpPoolKey({ ...shape, model: "grok-4" }));
  assert.notEqual(acpPoolKey(shape), acpPoolKey({ ...shape, permissionMode: "default" }));
});

// --- Direct lane parsing --------------------------------------------------

// These fixtures are copied verbatim from real `grok -p --output-format
// streaming-messages-json --include-partial-messages` output. Every Anthropic
// frame is WRAPPED in {type:"stream_event", event:{...}} — a parser that reads
// the outer type matches nothing at all.
test("grok text deltas are extracted from the stream_event wrapper", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
    session_id: "019fc6f1",
  });
  assert.equal(parseStreamLine(line).delta, "OK");
  assert.equal(textFromStreamLine(line), "OK");
});

test("thinking deltas are NEVER surfaced as reply text", () => {
  // grok emits a full paragraph of private reasoning before answering.
  // Forwarding it would leak the model's reasoning straight into a channel.
  const line = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user wants" } },
  });
  assert.equal(parseStreamLine(line).delta, "");
  assert.equal(parseStreamLine(line).final, null);
});

test("the final answer is returned as `final`, not appended as a delta", () => {
  // Regression: streaming "OK" and then appending the result frame produced
  // the reply "OKOK".
  const deltaLine = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } } });
  const resultLine = JSON.stringify({ type: "result", subtype: "success", result: "OK", stop_reason: "end_turn" });
  assert.equal(parseStreamLine(deltaLine).delta, "OK");
  assert.equal(parseStreamLine(resultLine).delta, "", "the result frame must not be a delta");
  assert.equal(parseStreamLine(resultLine).final, "OK");
});

test("the trailing whole-message recap is a final candidate, not a delta", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "OK" }] },
  });
  const { delta, final } = parseStreamLine(line);
  assert.equal(delta, "", "a recap must not double-count against streamed deltas");
  assert.equal(final, "OK", "but it must still yield text for tools that only emit whole messages");
});

test("control frames never leak into a reply", () => {
  // The init frame carries session ids, cwd and apiKeySource.
  for (const frame of [
    { type: "system", subtype: "init", session_id: "abc", model: "grok-4.5", cwd: "/private/tmp" },
    { type: "stream_event", event: { type: "message_start", message: { role: "assistant" } } },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 29 } } },
  ]) {
    const { delta, final } = parseStreamLine(JSON.stringify(frame));
    assert.equal(delta, "", `${frame.event?.type || frame.type} must not stream text`);
    assert.equal(final, null, `${frame.event?.type || frame.type} must not be a final answer`);
  }
  assert.equal(parseStreamLine("").delta, "");
});

test("a plain-text tool's output passes through unchanged", () => {
  assert.equal(parseStreamLine("just text").delta, "just text");
});

test("unparseable JSON-looking output yields nothing rather than garbage", () => {
  assert.equal(parseStreamLine("{not json").delta, "");
});
