// An agent pinned to a non-Claude ACP harness was still told
// "Requested model: claude-opus-5" in its prompt, so it introduced itself as a
// Claude model and listed Claude models as its own. The harness brings its own
// model; the configured model name only describes the Claude/Codex CLI path.

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadAgensis = () => import(pathToFileURL(path.join(root, "packages/agensis-cli/src/agensis.mjs")).href);
const loadExecutor = () => import(pathToFileURL(path.join(root, "packages/agensis-cli/src/acp/executor.mjs")).href);

const baseConfig = (normalizeConfig) => normalizeConfig({
  url: "wss://example.invalid",
  token: "t",
  workspace: "ws-1",
  agent: "agent-1",
  handle: "grok",
  cwd: root,
  model: "claude-opus-5",
});

test("a Claude-runtime agent is still told its requested model", async () => {
  const { __test } = await loadAgensis();
  const config = baseConfig(__test.normalizeConfig);
  const prompt = await __test.buildPrompt(config, {
    id: "j1",
    prompt: "hello",
    workspaceId: "ws-1",
    agent: { handle: "claude", name: "Claude", metadata: { runtime: "claude" } },
  });
  assert.match(prompt, /Requested model: /, "the Claude path must keep announcing its model");
  assert.ok(!/not Claude/.test(prompt), "the Claude path must not be told it is a different harness");
});

test("an agent pinned to a non-Claude ACP harness is not told it is a Claude model", async () => {
  const { __test } = await loadAgensis();
  const { harnessAvailable } = await loadExecutor();
  const config = baseConfig(__test.normalizeConfig);
  const job = {
    id: "j2",
    prompt: "which model are you?",
    workspaceId: "ws-1",
    agent: { handle: "grok", name: "Grok", metadata: { acp_harness: "grok" } },
  };
  const prompt = await __test.buildPrompt(config, job);

  if (!harnessAvailable("grok")) {
    // Host without the harness installed: the job really does fall back to the
    // Claude CLI, so announcing the Claude model is correct. Assert THAT, so the
    // test still discriminates instead of silently passing.
    assert.match(prompt, /Requested model: claude/, "with no grok harness the job is genuinely Claude");
    return;
  }
  assert.match(prompt, /Runtime: grok \(ACP\)/, "the pinned harness must be named as the runtime");
  assert.match(prompt, /you are grok, not Claude/, "the agent must be told which model actually answers");
  assert.ok(
    !/Requested model: claude/.test(prompt),
    "a grok-harness turn must not be told it is running a Claude model",
  );
});
