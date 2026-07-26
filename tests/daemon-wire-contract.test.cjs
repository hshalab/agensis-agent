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

  // Operator-owned identity.json in the agent's state dir (HOME=tempDir below):
  // the daemon must read it and send it as `identity` on agent_register, with
  // unknown keys dropped client-side. The server normalizes the rest.
  const stateDir = path.join(tempDir, '.agensis', 'workspace-wire', 'agent-wire');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'identity.json'), JSON.stringify({
    avatar: 'FX',
    description: 'Wire contract test agent',
    voice: { cartesia_voice_id: 'voice-wire-0001', speed: 1.1, emotion: 'calm' },
    unknown_key: 'dropped',
  }));

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
            assert.deepEqual(frame.identity, {
              avatar: 'FX',
              description: 'Wire contract test agent',
              voice: { cartesia_voice_id: 'voice-wire-0001', speed: 1.1, emotion: 'calm' },
            });
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
            // No identity.json on disk for this agent -> the frame must carry no
            // identity key at all (not an empty object), same as before the feature.
            assert.ok(!('identity' in frame));
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

// The segment frame is what breaks a turn into readable steps. Before it, every
// text block of a turn was appended to ONE placeholder message, so five separate
// thoughts arrived as a single run-on bubble the human could not steer between.
// This pins the exact object the server parses — field names included.
test('daemon emits an agent_job_segment frame per completed text block', { timeout: 20_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-segment-'));
  const fakeCli = path.join(tempDir, 'claude.mjs');
  // A real two-block turn: text, the tool that text announced, then more text.
  const stream = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading it.' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/App.tsx' } }] } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Read it.' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Read it.' }] } },
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
            socket.send(JSON.stringify({ type: 'agent_registered', connection: { name: 'segment-agent', host: 'test-host' } }));
            socket.send(JSON.stringify({
              type: 'agent_job',
              job: {
                id: 'job-segment',
                workspaceId: 'workspace-segment',
                sessionId: 'session-segment',
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
      '--token', 'aga_segment_token',
      '--workspace', 'workspace-segment',
      '--agent', 'agent-segment',
      '--handle', 'segment-agent',
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

    await resultFrame;
    const segments = frames.filter((frame) => frame.action === 'agent_job_segment');
    assert.deepEqual(
      segments.map((frame) => frame.text),
      ['Reading it.', 'Read it.'],
      `expected one segment per text block, got ${JSON.stringify(segments)}`,
    );
    const [first] = segments;
    assert.equal(first.jobId, 'job-segment');
    assert.equal(typeof first.elapsedMs, 'number');
    // Text before the tools it announced, or the transcript reads backwards.
    assert.ok(
      frames.indexOf(first) < frames.findIndex((frame) => frame.action === 'agent_job_step'),
      'the segment closing a block must be sent before that block’s step frames',
    );
    await childExit;
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// Skill BODIES. `capabilities.skills` is a list of NAMES, so until this frame existed a
// skill was unusable unless an agent happened to run on the machine that had it. This
// pins the exact contract the server's handleAgentSkillSync + normalizeSkillDocument
// read: the action name, the `hash`, and the four document fields — plus the rule that
// makes it cheap, which is that the BODIES ride this frame while the heartbeat carries
// only the hash.
test('daemon pushes skill bodies on connect and re-pushes on agent_skills_refresh', { timeout: 20_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-skills-'));
  const fakeCli = path.join(tempDir, 'fake-cli.mjs');
  await fs.writeFile(fakeCli, '#!/usr/bin/env node\nprocess.stdout.write("ok");\n', { mode: 0o700 });

  // HOME and cwd both point here, so ~/.claude/skills is this directory's.
  const skillDir = path.join(tempDir, '.claude', 'skills', 'wire-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: wire-skill\ndescription: A skill the wire test can read back.\n---\n\nThe body the workspace should end up storing.\n',
  );
  // A skill NAME with no SKILL.md: advertised, but never sent as an empty document.
  await fs.mkdir(path.join(tempDir, '.claude', 'skills', 'nameless'), { recursive: true });

  const server = new WebSocket.Server({ host: '::1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const frames = [];
  let child;

  try {
    const done = new Promise((resolve, reject) => {
      server.once('connection', (socket) => {
        let syncs = 0;
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw));
          frames.push(frame);
          if (frame.action === 'agent_register') {
            socket.send(JSON.stringify({ type: 'agent_registered', connection: { name: 'skills-agent', host: 'test-host' } }));
          }
          if (frame.action === 'agent_skill_sync') {
            syncs += 1;
            // The nudge the server sends when the heartbeat hash drifts from what it
            // stored. The daemon must answer it with a full re-push.
            if (syncs === 1) socket.send(JSON.stringify({ type: 'agent_skills_refresh' }));
          }
          // Both halves have to land before the assertions can compare them: the
          // bodies on their own frame, and the hash on a heartbeat.
          if (syncs >= 2 && frame.action === 'agent_heartbeat' && frame.skillsHash) resolve(frames);
        });
        socket.once('error', reject);
      });
    });

    child = spawn(process.execPath, [
      'packages/agensis-cli/bin/agensis.mjs',
      'connect',
      '--url', `http://[::1]:${port}`,
      '--token', 'aga_skills_token',
      '--workspace', 'workspace-skills',
      '--agent', 'agent-skills',
      '--handle', 'skills-agent',
      '--cwd', tempDir,
      '--coding-cmd', fakeCli,
      '--heartbeat-ms', '300',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: tempDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', (error) => { throw error; });

    await done;
    const syncs = frames.filter((frame) => frame.action === 'agent_skill_sync');
    assert.equal(syncs.length, 2, 'connect push + one answered refresh');
    const [sync] = syncs;
    assert.equal(sync.workspaceId, 'workspace-skills');
    assert.equal(sync.agentId, 'agent-skills');
    assert.equal(typeof sync.hash, 'string');
    assert.ok(sync.hash.length > 0);

    const doc = sync.skills.find((skill) => skill.skill === 'wire-skill');
    assert.ok(doc, `expected a wire-skill document, got ${JSON.stringify(sync.skills)}`);
    // Exactly the keys normalizeSkillDocument keeps — no credentials, no env, no extras.
    assert.deepEqual(Object.keys(doc).sort(), ['content', 'path', 'skill', 'summary', 'truncated']);
    assert.match(doc.content, /The body the workspace should end up storing\./);
    assert.equal(doc.summary, 'A skill the wire test can read back.');
    assert.equal(doc.truncated, false);
    assert.equal(doc.path, path.join(skillDir, 'SKILL.md'));
    // A name with no SKILL.md is never sent as an empty body — the server reports
    // 'not-synced' for it, which is the truth.
    assert.ok(!sync.skills.some((skill) => skill.skill === 'nameless'));

    // The heartbeat carries the hash and NOTHING else about skills — a body on every
    // beat is what this design exists to avoid.
    const beat = frames.find((frame) => frame.action === 'agent_heartbeat' && frame.skillsHash);
    assert.ok(beat, 'heartbeat must carry skillsHash');
    assert.equal(beat.skillsHash, sync.hash, 'heartbeat hash must match the pushed hash, or drift never resolves');
    assert.ok(!('skills' in beat), 'heartbeat must not carry skill bodies');

    // The capability snapshot stores the same hash as the drift reference.
    const caps = frames.find((frame) => frame.action === 'agent_capabilities_sync');
    assert.ok(caps.skills.includes('wire-skill'));
    assert.ok(caps.skills.includes('nameless'));
    assert.equal(caps.skillsHash, sync.hash);
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// The connection is worth more than any skill body. A skills root that is a FILE (so
// every read of it fails), an unreadable SKILL.md, a name with nothing behind it: the
// daemon must register, heartbeat and take jobs exactly as if none of that were there.
test('an unreadable skills tree never costs the daemon its connection', { timeout: 20_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-skills-broken-'));
  const fakeCli = path.join(tempDir, 'fake-cli.mjs');
  await fs.writeFile(fakeCli, '#!/usr/bin/env node\nprocess.stdout.write("still-here");\n', { mode: 0o700 });

  // ~/.claude/skills is a FILE, not a directory — every enumeration of it errors.
  await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(tempDir, '.claude', 'skills'), 'not a directory');

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
            socket.send(JSON.stringify({ type: 'agent_registered', connection: { name: 'broken-agent', host: 'test-host' } }));
            socket.send(JSON.stringify({
              type: 'agent_job',
              job: {
                id: 'job-broken',
                workspaceId: 'workspace-broken',
                sessionId: 'session-broken',
                prompt: 'Still working?',
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
      '--token', 'aga_broken_token',
      '--workspace', 'workspace-broken',
      '--agent', 'agent-broken',
      '--handle', 'broken-agent',
      '--cwd', tempDir,
      '--coding-cmd', fakeCli,
      '--heartbeat-ms', '300',
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
    assert.equal(result.response, 'still-here');
    // An empty push, not a missing one: the workspace learns this agent has no bodies
    // rather than being left with whatever it stored last time.
    const sync = frames.find((frame) => frame.action === 'agent_skill_sync');
    assert.deepEqual(sync.skills, []);
    assert.equal(typeof sync.hash, 'string');
    assert.equal(await childExit, 0);
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// The opt-out has to be invisible to the server, not merely quiet: a daemon that sends
// no skillsHash is never nudged for bodies and never blocked for not having them (see
// capabilitiesDriftNudges — every nudge is guarded on a hash the daemon actually sent).
test('--no-sync-skills sends no bodies and no skillsHash at all', { timeout: 20_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-skills-off-'));
  const fakeCli = path.join(tempDir, 'fake-cli.mjs');
  await fs.writeFile(fakeCli, '#!/usr/bin/env node\nprocess.stdout.write("ok");\n', { mode: 0o700 });
  const skillDir = path.join(tempDir, '.claude', 'skills', 'private-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Text that must never leave this machine.\n');

  const server = new WebSocket.Server({ host: '::1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const frames = [];
  let child;

  try {
    const beats = new Promise((resolve, reject) => {
      server.once('connection', (socket) => {
        let seen = 0;
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw));
          frames.push(frame);
          if (frame.action === 'agent_register') {
            socket.send(JSON.stringify({ type: 'agent_registered', connection: { name: 'off-agent', host: 'test-host' } }));
          }
          if (frame.action === 'agent_heartbeat') {
            seen += 1;
            if (seen >= 2) resolve(frames);
          }
        });
        socket.once('error', reject);
      });
    });

    child = spawn(process.execPath, [
      'packages/agensis-cli/bin/agensis.mjs',
      'connect',
      '--url', `http://[::1]:${port}`,
      '--token', 'aga_off_token',
      '--workspace', 'workspace-off',
      '--agent', 'agent-off',
      '--handle', 'off-agent',
      '--cwd', tempDir,
      '--coding-cmd', fakeCli,
      '--heartbeat-ms', '250',
      '--no-sync-skills',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: tempDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', (error) => { throw error; });

    await beats;
    assert.ok(!frames.some((frame) => frame.action === 'agent_skill_sync'), 'no bodies may leave an opted-out daemon');
    assert.ok(!frames.some((frame) => frame.action === 'agent_heartbeat' && frame.skillsHash));
    // The NAME is still advertised — the opt-out is about text, not existence.
    const caps = frames.find((frame) => frame.action === 'agent_capabilities_sync');
    assert.ok(caps.skills.includes('private-skill'));
    assert.equal(caps.skillsHash, null);
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
