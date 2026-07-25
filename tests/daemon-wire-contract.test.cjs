'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

test('daemon honors the hub auth, register, job, delta, and result contract', { timeout: 20_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-wire-'));
  const fakeCli = path.join(tempDir, 'fake-cli.mjs');
  await fs.writeFile(fakeCli, '#!/usr/bin/env node\nprocess.stdout.write("wire-ok");\n', { mode: 0o700 });

  const server = new WebSocket.Server({ host: '::1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const frames = [];
  let child;

  try {
    const resultFrame = new Promise((resolve, reject) => {
      server.once('connection', (socket, request) => {
        assert.match(request.url, /^\/backend\/ws\?workspaceId=workspace-wire&agentId=agent-wire$/);
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw));
          frames.push(frame);
          if (frames.length === 1) {
            assert.deepEqual(frame, { type: 'auth', token: 'aga_wire_token' });
          }
          if (frame.action === 'agent_register') {
            assert.equal(frames[0].type, 'auth');
            assert.equal(frame.workspaceId, 'workspace-wire');
            assert.equal(frame.agentId, 'agent-wire');
            assert.equal(frame.metadata.runtime, 'agensis');
            socket.send(JSON.stringify({
              type: 'agent_registered',
              connection: { name: 'wire-agent', host: 'test-host' },
              agent: { model: 'claude-opus-4-8', permission_mode: 'default' },
            }));
            socket.send(JSON.stringify({
              type: 'agent_job',
              job: {
                id: 'job-wire',
                workspaceId: 'workspace-wire',
                sessionId: 'session-wire',
                prompt: 'Reply through the wire contract.',
                agent: { model: 'claude-opus-4-8', permission_mode: 'default', run_mode: 'daemon' },
              },
            }));
          }
          if (frame.action === 'agent_job_result') resolve(frame);
        });
        socket.once('error', reject);
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
      '--once',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: tempDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExit = new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });

    const result = await resultFrame;
    assert.equal(result.jobId, 'job-wire');
    assert.equal(result.response, 'wire-ok');
    assert.equal(result.error, '');
    assert.ok(frames.some((frame) => frame.action === 'agent_job_delta' && frame.jobId === 'job-wire'));
    const exitCode = await childExit;
    assert.equal(exitCode, 0);
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// The step frame is what makes a working agent visible. Before it, a turn that
// only read files / ran commands produced no text, so no agent_job_delta, and
// the chat sat on "Thinking …" until the whole job finished. This pins the exact
// object the server parses — field names included.
test('daemon emits an agent_job_step frame per tool round trip', { timeout: 20_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-step-'));
  // Named claude.* so the daemon treats it as Claude and adds --output-format
  // stream-json; the script replays the NDJSON a real tool-using turn produces.
  const fakeCli = path.join(tempDir, 'claude.mjs');
  const stream = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/App.tsx' } }] } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Read it.' } } },
    { type: 'result', subtype: 'success', result: 'Read it.' },
  ].map((o) => JSON.stringify(o)).join('\n');
  await fs.writeFile(fakeCli, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${stream}\n`)});\n`, { mode: 0o700 });

  const server = new WebSocket.Server({ host: '::1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const frames = [];
  let child;

  try {
    const resultFrame = new Promise((resolve, reject) => {
      server.once('connection', (socket) => {
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw));
          frames.push(frame);
          if (frame.action === 'agent_register') {
            socket.send(JSON.stringify({ type: 'agent_registered', connection: { name: 'step-agent', host: 'test-host' } }));
            socket.send(JSON.stringify({
              type: 'agent_job',
              job: {
                id: 'job-step',
                workspaceId: 'workspace-step',
                sessionId: 'session-step',
                prompt: 'Read the file.',
                agent: { model: 'claude-opus-4-8', permission_mode: 'default', run_mode: 'daemon' },
              },
            }));
          }
          if (frame.action === 'agent_job_result') resolve(frame);
        });
        socket.once('error', reject);
      });
    });

    child = spawn(process.execPath, [
      'packages/agensis-cli/bin/agensis.mjs',
      'connect',
      '--url', `http://[::1]:${port}`,
      '--token', 'aga_step_token',
      '--workspace', 'workspace-step',
      '--agent', 'agent-step',
      '--handle', 'step-agent',
      '--cwd', tempDir,
      '--coding-cmd', `${fakeCli} -p`,
      '--heartbeat-ms', '1000',
      '--once',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: tempDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExit = new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });

    const result = await resultFrame;
    assert.equal(result.response, 'Read it.');
    const steps = frames.filter((frame) => frame.action === 'agent_job_step');
    assert.equal(steps.length, 1, `expected exactly one step frame, got ${JSON.stringify(steps)}`);
    const [step] = steps;
    assert.equal(step.jobId, 'job-step');
    assert.equal(step.kind, 'tool');
    assert.equal(step.name, 'Read');
    assert.equal(step.detail, 'src/App.tsx');
    assert.equal(typeof step.elapsedMs, 'number');
    await childExit;
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
