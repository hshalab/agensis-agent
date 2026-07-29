'use strict';

// ============================================================================
// tests/agent-session-slots.test.cjs
// ----------------------------------------------------------------------------
// `--max-concurrency 2` was a NO-OP on the default code path, and this is the
// test that would have caught it.
//
// The lane queue admits two conversations at once, but every job was handed the
// same sessionKey — `${workspaceId}:${agent}` — and connectionExecutors.mjs
// serialises same-key runs behind a keyed mutex. Two lanes in, one connection
// out: effective parallelism 1. Session SLOTS give the mutex more than one
// connection to serialise against.
//
// The allocator's own behaviour is covered by tests/unit/sessionSlots.test.ts.
// What is pinned HERE is the wiring in agensis.mjs, which no unit test of a
// pure module can see: that the slot actually reaches the session key, that it
// is claimed per lane, and that it is released from a `finally`. This is a
// source-level assertion for the same reason the server pins its reaper SQL
// that way — runAgentJob is not exported and driving it needs a live socket,
// a coding CLI and a workspace.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../packages/agensis-cli/src/agensis.mjs'),
  'utf8',
);

test('the session key carries the slot, so two lanes can hold two connections', () => {
  // THE REGRESSION. A silo-only key is what made --max-concurrency a no-op.
  assert.match(source, /sessionKey: `\$\{silo\}#\$\{slot\}`/);
  assert.ok(
    !/sessionKey: `\$\{job\.workspaceId \|\| config\.workspace \|\| ""\}:\$\{config\.agent \|\| config\.handle \|\| ""\}`/.test(source),
    'a silo-only session key funnels every conversation onto one connection',
  );
});

test('a slot is claimed per LANE, not per job or per silo', () => {
  // Per lane is what makes it sticky: a conversation returns to the session
  // holding its own history. Per job would reshuffle every turn.
  assert.match(source, /slots\.claim\(silo, laneKeyForJob\(job\)\)/);
});

test('the slot is released from a finally, on every exit path', () => {
  const claimAt = source.indexOf('slots.claim(silo, laneKeyForJob(job))');
  assert.ok(claimAt > 0, 'the claim site moved');
  const after = source.slice(claimAt, claimAt + 3000);
  const releaseAt = after.indexOf('slots.release(silo, slot)');
  assert.ok(releaseAt > 0, 'the claim has no matching release');
  const finallyAt = after.lastIndexOf('} finally {', releaseAt);
  assert.ok(
    finallyAt > 0 && finallyAt < releaseAt,
    'the release must sit inside a finally — a return-only release leaks the slot on a throw',
  );
});

test('slots default to 1, which is exactly the behaviour that exists today', () => {
  assert.match(source, /const DEFAULT_SESSION_SLOTS = 1;/);
  // Clamped to maxConcurrency: more sessions than the queue will ever use is
  // pure memory, and each one is a live coding-CLI process.
  assert.match(source, /sessionSlots: Math\.min\(/);
  assert.match(source, /AGENSIS_SESSION_SLOTS/);
});

test('the idle deadline is a separate config value from the hard timeout', () => {
  // Item B. One flat timer could not tell "working for 30 minutes" from
  // "produced nothing for 9", and only the daemon can actually stop the work.
  assert.match(source, /const DEFAULT_IDLE_TIMEOUT_MS = 9 \* 60 \* 1000;/);
  assert.match(source, /idleTimeoutMs: config\.idleTimeoutMs,/);
  assert.match(source, /AGENSIS_IDLE_TIMEOUT_MS/);
});

test('the idle deadline can never exceed the hard ceiling', () => {
  // An idle deadline longer than the hard one can never fire, which looks
  // exactly like the flag silently doing nothing.
  const at = source.indexOf('idleTimeoutMs: Math.min(');
  assert.ok(at > 0, 'the idle deadline is no longer clamped');
  assert.match(source.slice(at, at + 400), /AGENSIS_TIMEOUT_MS \|\| DEFAULT_TIMEOUT_MS/);
});
