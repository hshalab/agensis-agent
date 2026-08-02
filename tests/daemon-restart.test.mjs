// `agent_restart` — the server can tell a host to replace itself.
//
// Until this existed, adopting a newly published CLI meant finding the terminal
// the daemon was launched in and restarting it by hand. A running process has its
// module graph already loaded, so installing a new version changes nothing on its
// own; only a new process picks it up.
//
// The two properties that matter: in-flight turns are drained first (killing
// mid-turn is the "agent stopped responding" failure the reconnect work removed),
// and a failed spawn must NOT exit — an out-of-date daemon beats no daemon.

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadAgensis = () => import(pathToFileURL(path.join(root, "packages/agensis-cli/src/agensis.mjs")).href);

function fakeWs() {
  return { closed: null, close(code, reason) { this.closed = { code, reason }; } };
}

test("restartSelf spawns a replacement with this process's own argv, then exits", async () => {
  const { restartSelf } = await loadAgensis();
  const spawns = [];
  const exits = [];
  const ws = fakeWs();

  const ok = await restartSelf({
    ws,
    queue: null,
    spawnFn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { unref() { } }; },
    exit: (code) => exits.push(code),
  });

  assert.equal(ok, true);
  assert.equal(spawns.length, 1, "exactly one replacement");
  assert.equal(spawns[0].cmd, process.execPath, "the replacement is this same node binary");
  assert.deepEqual(spawns[0].args, process.argv.slice(1), "same argv — same agent, token and profile");
  assert.equal(spawns[0].opts.detached, true, "must outlive the process that spawned it");
  assert.equal(spawns[0].opts.stdio, "inherit", "keeps the terminal a human launched it in");
  assert.deepEqual(exits, [0], "the old process exits cleanly");
  assert.equal(ws.closed?.code, 1012, "1012 is service-restart; 1008 would stop the fleet");
});

test("an in-flight turn is drained before the process is replaced", async () => {
  const { restartSelf } = await loadAgensis();
  const order = [];
  let releaseIdle;
  const idle = new Promise((resolve) => { releaseIdle = resolve; });

  const restarting = restartSelf({
    ws: fakeWs(),
    queue: { active: () => 1, idle: () => idle.then(() => order.push("drained")) },
    drainMs: 5_000,
    spawnFn: () => { order.push("spawned"); return { unref() { } }; },
    exit: () => order.push("exited"),
  });

  // Nothing may happen while a turn is still running.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, [], "the daemon must not be replaced mid-turn");

  releaseIdle();
  await restarting;
  assert.deepEqual(order, ["drained", "spawned", "exited"], "drain, then replace");
});

test("a drain that never finishes still restarts, bounded", async () => {
  const { restartSelf } = await loadAgensis();
  const order = [];
  const ok = await restartSelf({
    ws: fakeWs(),
    // A turn that never settles: the timeout is what stops this hanging forever.
    queue: { active: () => 1, idle: () => new Promise(() => { }) },
    drainMs: 30,
    spawnFn: () => { order.push("spawned"); return { unref() { } }; },
    exit: () => order.push("exited"),
  });
  assert.equal(ok, true);
  assert.deepEqual(order, ["spawned", "exited"]);
});

test("a failed spawn does NOT exit — an out-of-date daemon beats no daemon", async () => {
  const { restartSelf } = await loadAgensis();
  const exits = [];
  const logs = [];

  const ok = await restartSelf({
    ws: fakeWs(),
    queue: null,
    log: (line) => logs.push(String(line)),
    spawnFn: () => { throw new Error("EACCES"); },
    exit: (code) => exits.push(code),
  });

  assert.equal(ok, false);
  assert.deepEqual(exits, [], "never exit when there is no replacement to take over");
  assert.ok(logs.some((line) => /Restart aborted/.test(line)), "and say so");
});
