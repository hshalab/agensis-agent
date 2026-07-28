'use strict';

// A dropped socket must not destroy a turn.
//
// The hub terminates a daemon socket that misses its liveness pongs — a Wi-Fi
// roam or a starved event loop is enough. The daemon keeps executing the turn
// regardless and reconnects ~2s later. Before these two mechanisms the finished
// answer went to the socket captured at enqueue time and was dropped silently by
// send(), so the daemon logged "Finished job" while the human was told the agent
// stopped responding.
//
// Two paths, one per test:
//   1. the turn ends AFTER the reconnect  -> job.ws must read the LIVE socket
//   2. the turn ends DURING the outage    -> the result must be parked and flushed

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..');

// Drives one daemon against a fake hub that kills the socket mid-job.
// `workMs` decides whether the turn lands after the reconnect or inside the gap.
//
// The socket is killed when the daemon FIRST reports progress on the job, not on
// a timer measured from register. A fixed timer made this flaky: under a loaded
// machine the daemon takes longer to boot and the terminate landed before the
// turn had started, so there was no in-flight work to lose and the assertion
// failed for a reason that had nothing to do with the behaviour under test.
async function runDropMidJob({ workMs, waitMs = 20_000 }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-reconnect-'));
  const fakeCli = path.join(tempDir, 'fake-cli.mjs');
  await fs.writeFile(
    fakeCli,
    `#!/usr/bin/env node\nsetTimeout(() => process.stdout.write("answer-${workMs}"), ${workMs});\n`,
    { mode: 0o700 },
  );

  const server = new WebSocket.Server({ host: '::1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;

  const state = { connections: 0, resultOnSecondSocket: null, resultOnFirstSocket: null, terminated: false };
  let child;

  try {
    server.on('connection', (socket) => {
      state.connections += 1;
      const index = state.connections;

      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw));

        if (frame.action === 'agent_register') {
          socket.send(JSON.stringify({
            type: 'agent_registered',
            connection: { name: 'wire-agent', host: 'test-host' },
            agent: { model: 'claude-opus-4-8', permission_mode: 'default' },
          }));
          if (index !== 1) return;
          socket.send(JSON.stringify({
            type: 'agent_job',
            job: {
              id: 'job-drop',
              workspaceId: 'workspace-wire',
              sessionId: 'session-wire',
              prompt: 'Work through a dropped socket.',
              agent: { model: 'claude-opus-4-8', permission_mode: 'default', run_mode: 'daemon' },
            },
          }));
        }

        // Stand in for the hub's liveness reaper: terminate() the moment the turn
        // is demonstrably in flight, so the drop always lands mid-job.
        if (index === 1 && !state.terminated && frame.jobId === 'job-drop'
          && frame.action !== 'agent_job_result') {
          state.terminated = true;
          socket.terminate();
        }

        if (frame.action === 'agent_job_result') {
          if (index === 1) state.resultOnFirstSocket = frame;
          else state.resultOnSecondSocket = frame;
        }
      });
    });

    child = spawn(process.execPath, [
      'packages/agensis-cli/bin/agensis.mjs',
      'connect',
      '--url', `http://[::1]:${port}`,
      '--token', 'aga_wire_token',
      '--workspace', 'workspace-wire',
      '--agent', 'agent-wire',
      '--handle', 'wire-agent',
      '--cwd', tempDir,
      '--coding-cmd', fakeCli,
      '--heartbeat-ms', '1000',
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: tempDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => { output += String(d); });

    // Poll for the outcome instead of sleeping a fixed span: fast when the daemon
    // is quick, still correct when the machine is busy.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !state.resultOnSecondSocket) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    state.output = output;
    return state;
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('a turn finishing after a reconnect is sent on the live socket', { timeout: 40_000 }, async () => {
  // Terminate at 0.8s, daemon reconnects ~2.8s, turn ends at 3s -> live-ws path.
  const state = await runDropMidJob({ workMs: 3000 });
  assert.ok(state.connections >= 2, 'daemon should have reconnected');
  assert.equal(state.resultOnFirstSocket, null, 'the dead socket cannot have received it');
  assert.ok(state.resultOnSecondSocket, 'result must arrive on the reconnected socket');
  assert.equal(state.resultOnSecondSocket.jobId, 'job-drop');
  assert.equal(state.resultOnSecondSocket.response, 'answer-3000');
  assert.equal(state.resultOnSecondSocket.error, '');
});

test('a turn finishing while disconnected is parked and re-sent', { timeout: 40_000 }, async () => {
  // Terminate at 0.8s, turn ends at ~1.2s with NO socket, reconnect ~2.8s ->
  // only the park/flush path can deliver this one.
  const state = await runDropMidJob({ workMs: 1200 });
  assert.ok(state.connections >= 2, 'daemon should have reconnected');
  assert.equal(state.resultOnFirstSocket, null, 'the dead socket cannot have received it');
  assert.ok(state.resultOnSecondSocket, 'a result completed during the outage must be re-sent');
  assert.equal(state.resultOnSecondSocket.jobId, 'job-drop');
  assert.equal(state.resultOnSecondSocket.response, 'answer-1200');
  assert.match(state.output, /parked the result for job job-drop/);
  assert.match(state.output, /Re-sent the result for job job-drop/);
});
