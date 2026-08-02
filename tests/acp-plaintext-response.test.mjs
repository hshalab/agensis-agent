// THE REGRESSION (0.1.48): an ACP run's answer arrived as response:"".
//
// createExecutor started wrapping every job in createPreferAcpExecutor, so when
// an ACP harness is installed the job runs over ACP — which streams and returns
// PLAIN TEXT. But runAgentJob still fed that text to createStreamJsonParser (a
// reader for the NDJSON `claude -p --output-format stream-json` emits) and then
// took the response from parser.result, discarding result.stdout entirely.
// Plain text through that parser yields "", so a perfectly good answer reached
// the server as response:"" and rendered as "@handle finished without output."
//
// The whole suite runs with AGENSIS_ACP=0, which is exactly why no existing test
// caught this — so these assertions key off what the executor REPORTS having
// done (result.acp), never off the ambient env.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executorPath = path.join(root, "packages/agensis-cli/src/executor.mjs");
const agensisPath = path.join(root, "packages/agensis-cli/src/agensis.mjs");

const ACP_ANSWER = "COUNT=64 — this is the real answer the agent produced.";

/** A socket that just banks every frame the daemon sends. */
function fakeWs() {
  const frames = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (raw) => { frames.push(JSON.parse(raw)); },
    frames,
  };
}

// ONE module mock for the file (node refuses to mock the same specifier twice),
// with a swappable impl so each test picks the executor behaviour it needs.
let currentRun = async () => ({ status: 0, stdout: "", stderr: "", error: null });
const stub = { run: (opts) => currentRun(opts) };
mock.module(pathToFileURL(executorPath).href, {
  namedExports: {
    createExecutor: () => stub,
    createLocalExecutor: () => stub,
    createPrimaryExecutor: () => stub,
    createSandboxExecutor: () => stub,
  },
});

/** Drive runAgentJob with an executor that behaves exactly like the ACP path. */
async function runWithExecutor(runImpl) {
  currentRun = runImpl;
  // Import AFTER the mock so agensis.mjs binds the stubbed createExecutor.
  const mod = await import(pathToFileURL(agensisPath).href);
  const { runAgentJob, normalizeConfig } = mod.__test;

  const config = normalizeConfig({
    url: "wss://example.invalid",
    token: "t",
    workspace: "ws-1",
    agent: "agent-1",
    handle: "claude",
    cwd: root,
    // `claude -p` is the default coding command, and it is what makes
    // command.streamJson true — the precondition for this whole bug.
    codingCmd: "claude -p",
  });

  const ws = fakeWs();
  const job = { id: "job-1", ws, prompt: "count the files", agent: {}, workspaceId: "ws-1" };
  await runAgentJob(config, job, { signal: new AbortController().signal });
  return ws.frames;
}

test("an ACP run's plain-text answer reaches the result frame, not response:\"\"", async () => {
  const frames = await runWithExecutor(async (opts) => {
    // The ACP executor streams plain text and returns it on stdout, flagging acp:true.
    opts.onData?.(ACP_ANSWER);
    return {
      status: 0,
      stdout: ACP_ANSWER,
      stderr: "",
      error: null,
      stop: "end_turn",
      acp: true,
      harnessId: "claude",
    };
  });

  const result = frames.find((f) => f.action === "agent_job_result");
  assert.ok(result, "the job never sent a result frame");
  assert.equal(
    result.response,
    ACP_ANSWER,
    'an ACP answer must survive to the result frame — an empty response is what the server renders as "finished without output"',
  );
  assert.equal(result.error, "", "a successful ACP turn must not carry an error");
});

test("a classic stream-json run still has its NDJSON parsed, not shipped raw", async () => {
  // The other direction: ACP is NOT what ran, so the NDJSON must still be parsed.
  // Without this, "skip the parser for ACP" would regress every classic turn.
  const ndjson = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "classic answer" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "classic answer" }),
  ].join("\n");

  const frames = await runWithExecutor(async (opts) => {
    opts.onData?.(`${ndjson}\n`);
    return { status: 0, stdout: ndjson, stderr: "", error: null, stop: "end_turn", acp: false };
  });

  const result = frames.find((f) => f.action === "agent_job_result");
  assert.ok(result, "the job never sent a result frame");
  assert.equal(result.response, "classic answer");
  assert.ok(
    !result.response.includes('"type"'),
    "raw NDJSON leaked into the response instead of being parsed",
  );
});

test("a classic turn never streams raw NDJSON into the live view", async () => {
  // THE 0.1.49 REGRESSION. Skipping the parser whenever ACP was *predicted* meant
  // that when ACP declined at runtime and the classic CLI ran instead, every
  // stream-json frame was pushed to the chat verbatim — the user saw
  // {"type":"stream_event","event":{...}} instead of words. The path that runs is
  // not knowable up front, so the parser must always exist for a stream-json
  // command and the raw stream may only surface when it plainly is not NDJSON.
  const frames = await runWithExecutor(async (opts) => {
    // Streamed frame by frame, exactly as the classic CLI emits them.
    opts.onData?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hey" } } })}\n`);
    opts.onData?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " Jason." } } })}\n`);
    opts.onData?.(`${JSON.stringify({ type: "result", subtype: "success", result: "Hey Jason." })}\n`);
    // No `acp` field at all — this is what the classic executor returns.
    return { status: 0, stdout: "", stderr: "", error: null, stop: "end_turn" };
  });

  const leaked = frames.filter(
    (f) => f.action === "agent_job_delta" && /"type"\s*:\s*"(stream_event|result)"/.test(String(f.content || "")),
  );
  assert.equal(
    leaked.length,
    0,
    `raw NDJSON reached the chat in ${leaked.length} delta frame(s): ${JSON.stringify(leaked[0]?.content || "").slice(0, 160)}`,
  );

  const result = frames.find((f) => f.action === "agent_job_result");
  assert.equal(result.response, "Hey Jason.", "the parsed text is what the turn should answer with");
});
