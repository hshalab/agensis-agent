// ACP preference for the Relay CLI: use harness when available, else classic.

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadHarnesses = () => import(pathToFileURL(path.join(root, "packages/agensis-cli/src/acp/harnesses.mjs")).href);
const loadExecutor = () => import(pathToFileURL(path.join(root, "packages/agensis-cli/src/acp/executor.mjs")).href);
const loadMainExecutor = () => import(pathToFileURL(path.join(root, "packages/agensis-cli/src/executor.mjs")).href);

test("preferredHarnessId prefers metadata.acp_harness over runtime", async () => {
  const { preferredHarnessId } = await loadHarnesses();
  assert.equal(preferredHarnessId({
    job: { agent: { metadata: { acp_harness: "hermes", runtime: "claude" } } },
    family: "claude",
  }), "hermes");
  assert.equal(preferredHarnessId({
    job: { agent: { metadata: { runtime: "codex" } } },
    family: "claude",
  }), "codex");
  assert.equal(preferredHarnessId({ family: "claude" }), "claude");
});

test("acpPreferred is on by default and off with --no-acp / AGENSIS_ACP=0", async () => {
  const { acpPreferred } = await loadExecutor();
  // Pass env explicitly — the suite may set AGENSIS_ACP=0 so default process.env is not assumed.
  assert.equal(acpPreferred({ config: {}, env: {} }), true);
  assert.equal(acpPreferred({ config: { noAcp: true }, env: {} }), false);
  assert.equal(acpPreferred({ config: {}, env: { AGENSIS_ACP: "0" } }), false);
  assert.equal(acpPreferred({ config: {}, env: { AGENSIS_ACP: "false" } }), false);
});

test("createPreferAcpExecutor falls back to classic when harness is missing", async () => {
  const { createPreferAcpExecutor, resetAcpExecutorState } = await loadExecutor();
  resetAcpExecutorState();
  let classicRuns = 0;
  const classic = {
    run: async (opts) => {
      classicRuns += 1;
      return { status: 0, stdout: `classic:${opts.prompt}`, stderr: "", error: null };
    },
  };
  const ex = createPreferAcpExecutor({
    job: { agent: { metadata: { acp_harness: "definitely-not-installed-xyz" } } },
    family: "claude",
    config: { acp: true },
    fallback: classic,
    log: { log() {} },
  });
  const res = await ex.run({ prompt: "hi" });
  assert.equal(res.stdout, "classic:hi");
  assert.equal(classicRuns, 1);
});

test("createPreferAcpExecutor skips ACP when noAcp is set", async () => {
  const { createPreferAcpExecutor, resetAcpExecutorState } = await loadExecutor();
  resetAcpExecutorState();
  let classicRuns = 0;
  const classic = {
    run: async () => {
      classicRuns += 1;
      return { status: 0, stdout: "classic", stderr: "", error: null };
    },
  };
  const ex = createPreferAcpExecutor({
    job: { agent: { metadata: { acp_harness: "claude" } } },
    family: "claude",
    config: { noAcp: true },
    fallback: classic,
    log: { log() {} },
  });
  const res = await ex.run({ prompt: "x" });
  assert.equal(res.stdout, "classic");
  assert.equal(classicRuns, 1);
});

test("createExecutor still returns a runnable for daemon jobs", async () => {
  const { createExecutor } = await loadMainExecutor();
  const ex = createExecutor({ agent: { run_mode: "daemon" } }, { family: "claude", config: { noAcp: true } });
  assert.equal(typeof ex.run, "function");
});
