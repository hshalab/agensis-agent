// THE REGRESSION (0.1.48 -> 0.1.55): a Claude job ran over ACP instead of the
// Claude Agent SDK, purely because `claude-code-acp` happened to be on PATH.
//
// createExecutor wrapped EVERY job in createPreferAcpExecutor, and
// preferredHarnessId answers "claude" for the claude family — so the ACP branch
// won before the native lane was ever consulted. The cost is not just speed:
// the SDK path is what produces tool steps, text segments, stop reasons and
// token usage, and an ACP adapter returns none of that, so the chat quietly
// lost its step strip and the server lost its usage counts.
//
// The rule these tests pin down is the one already asserted for prewarming
// (acp-speed-lanes.test.mjs) and for the direct-spawn fallback, and which the
// job path was the last place to ignore: claude / codex / amp are driven by
// their NATIVE runtimes and are never routed through ACP.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => pathToFileURL(path.join(root, "packages/agensis-cli/src", rel)).href;

// Record every time createExecutor decides a job should go through the ACP
// branch. Mocking the module is what makes the DECISION observable — asserting
// on the returned object alone cannot tell "chose the SDK" from "chose ACP and
// ACP silently fell back".
const preferAcpCalls = [];
mock.module(src("acp/executor.mjs"), {
  namedExports: {
    createPreferAcpExecutor: (ctx) => {
      preferAcpCalls.push(ctx);
      return { run: async () => ({ status: 0, stdout: "acp", stderr: "", error: null, acp: true }) };
    },
  },
});

// NOTE: the unmocked half of this guarantee — that harnessAvailable and the ACP
// executor themselves refuse a native runtime — lives in acp-speed-lanes.test.mjs.
// It cannot live here: mock.module above replaces this specifier for the whole
// file, so importing the "real" module would just hand back the stub.
const loadExecutor = () => import(src("executor.mjs"));

const daemonJob = (metadata = {}) => ({ agent: { run_mode: "daemon", metadata } });

test("a claude job goes straight to the native lane, never through ACP", async () => {
  const { createExecutor } = await loadExecutor();
  preferAcpCalls.length = 0;
  const ex = createExecutor(daemonJob(), { family: "claude", config: {} });
  assert.equal(typeof ex.run, "function");
  assert.equal(
    preferAcpCalls.length,
    0,
    "the claude family must resolve to the Claude Agent SDK without ACP being consulted",
  );
});

test("a codex job goes straight to the native lane, never through ACP", async () => {
  const { createExecutor } = await loadExecutor();
  preferAcpCalls.length = 0;
  const ex = createExecutor(daemonJob(), { family: "codex", config: {} });
  assert.equal(typeof ex.run, "function");
  assert.equal(preferAcpCalls.length, 0, "the codex family must resolve to codex app-server without ACP");
});

test("an explicit acp_harness pin cannot pull claude or codex off their native runtime", async () => {
  // The pin is how a Hermes/Grok agent selects its adapter. Aimed at a native
  // runtime it must not win, or the reported bug returns through the one door
  // left open.
  const { createExecutor } = await loadExecutor();
  for (const harness of ["claude", "codex"]) {
    preferAcpCalls.length = 0;
    createExecutor(daemonJob({ acp_harness: harness }), { family: harness, config: { acpHarness: harness } });
    assert.equal(preferAcpCalls.length, 0, `acp_harness=${harness} must not route a native runtime through ACP`);
  }
});

test("a harness with no native lane DOES still go through ACP", async () => {
  // The control. Without it every assertion above passes on a mock that was
  // never wired up, and the suite would report success for a broken build.
  const { createExecutor } = await loadExecutor();
  preferAcpCalls.length = 0;
  createExecutor(daemonJob({ acp_harness: "hermes" }), { family: null, config: {} });
  assert.equal(preferAcpCalls.length, 1, "a non-native harness must still reach the ACP branch");
});

test("a sandbox job is unaffected by any of this", async () => {
  const { createExecutor } = await loadExecutor();
  preferAcpCalls.length = 0;
  const provider = {
    ensureEnv: async () => ({ id: "sbx" }),
    putRepo: async () => {},
    exec: async () => ({ status: 0, stdout: "sandboxed", stderr: "", error: null }),
    getResult: async () => ({}),
    destroy: async () => {},
  };
  const ex = createExecutor(
    { agent: { run_mode: "sandbox" } },
    { family: "claude", makeProvider: () => provider },
  );
  const res = await ex.run({ cmd: "claude", args: [] });
  assert.equal(res.stdout, "sandboxed");
  assert.equal(preferAcpCalls.length, 0);
});
