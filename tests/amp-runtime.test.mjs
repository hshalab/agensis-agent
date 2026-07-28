import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const amp = await import('../packages/agensis-cli/src/ampRuntime.mjs');

test('Amp jobs are selected explicitly from agent metadata', () => {
  assert.equal(amp.isAmpJob({ agent: { metadata: { runtime: 'amp' } } }), true);
  assert.equal(amp.isAmpJob({ agent: { metadata: { runtime: 'claude' } } }), false);
  assert.equal(amp.isAmpJob({ agent: { run_mode: 'daemon' } }), false);
});

// `-o` MUST stay bundled as `-ox`. Amp's parser rejects it as its own argv
// element (`unknown option '-o'`), which failed every orb turn at parse time.
test('a new Amp lane starts an execute-mode thread in a fresh orb', () => {
  assert.deepEqual(
    amp.buildAmpCommand({ prompt: 'fix the tests' }),
    { cmd: 'amp', args: ['-ox', 'fix the tests', '--stream-json', '--no-archive-after-execute'] },
  );
});

test('the orb flag is never passed as a standalone argv element', () => {
  const { args } = amp.buildAmpCommand({ prompt: 'anything' });
  assert.equal(args.includes('-o'), false, "amp rejects a bare '-o' with unknown option");
  assert.equal(args[0], '-ox');
});

test('a dropped or renamed Amp flag reads as a version problem, not a crash', () => {
  assert.equal(
    amp.classifyAmpFailure({ status: 1, stderr: "Error: error: unknown option '-o'" }).code,
    'amp_version_unsupported',
  );
});

test('a GitHub repo Amp cannot read is its own actionable failure', () => {
  const failure = amp.classifyAmpFailure({
    status: 1,
    stderr: 'Error: Amp could not access this GitHub repository. Check that the URL is correct and that your GitHub connection has access to it, then try again.',
  });
  assert.equal(failure.code, 'amp_repo_access_denied');
  assert.match(failure.message, /GitHub connection/i);
});

test('a missing Amp project names the command that creates one', () => {
  assert.match(amp.ampFailureMessage('amp_project_not_found'), /amp projects create .* --workspace/);
  assert.match(amp.ampFailureMessage('amp_project_unmatched'), /amp projects create .* --workspace/);
});

test('an existing Amp lane continues the exact thread without requesting a new orb', () => {
  assert.deepEqual(
    amp.buildAmpCommand({ prompt: 'now ship it', threadId: 'T-019fa798-10c0-76f8-9844-d848ba21c6d4' }),
    {
      cmd: 'amp',
      args: ['threads', 'continue', 'T-019fa798-10c0-76f8-9844-d848ba21c6d4', '-x', 'now ship it', '--stream-json'],
    },
  );
});

test('Amp stream metadata extracts only a valid stable thread id', () => {
  const tracker = amp.createAmpStreamTracker();
  tracker.feed('not json\n{"type":"system","subtype":"init","session_');
  tracker.feed('id":"T-019fa798-10c0-76f8-9844-d848ba21c6d4"}\n');
  tracker.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n');
  tracker.end();
  assert.equal(tracker.threadId, 'T-019fa798-10c0-76f8-9844-d848ba21c6d4');
  assert.equal(tracker.threadUrl, 'https://ampcode.com/threads/T-019fa798-10c0-76f8-9844-d848ba21c6d4');

  const invalid = amp.createAmpStreamTracker();
  invalid.feed('{"type":"system","subtype":"init","session_id":"../../settings"}\n');
  invalid.end();
  assert.equal(invalid.threadId, '');
});

test('Amp errors map to stable codes and never imply another runtime fallback', () => {
  assert.equal(amp.classifyAmpFailure({ error: Object.assign(new Error('spawn amp ENOENT'), { code: 'ENOENT' }) }).code, 'amp_not_installed');
  assert.equal(amp.classifyAmpFailure({ stderr: 'Please login to Amp to continue', status: 1 }).code, 'amp_not_authenticated');
  assert.equal(amp.classifyAmpFailure({ stderr: 'You are not authenticated', status: 1 }).code, 'amp_not_authenticated');
  assert.equal(amp.classifyAmpFailure({ stderr: 'Your authentication token has expired', status: 1 }).code, 'amp_auth_expired');
  assert.equal(amp.classifyAmpFailure({ stderr: 'Insufficient credit balance', status: 1 }).code, 'amp_insufficient_credit');
  assert.equal(amp.classifyAmpFailure({ stderr: 'You have run out of credits', status: 1 }).code, 'amp_insufficient_credit');
  assert.equal(amp.classifyAmpFailure({ stderr: 'Your usage limit has been reached', status: 1 }).code, 'amp_insufficient_credit');
  assert.equal(amp.classifyAmpFailure({ stderr: 'Thread T-missing was not found', status: 1 }).code, 'amp_thread_not_found');
  assert.equal(amp.classifyAmpFailure({ error: new Error('timed out after 30m') }).code, 'amp_turn_timed_out');
  assert.equal(amp.classifyAmpFailure({ stderr: 'unexpected crash', status: 1 }).code, 'amp_cli_crashed');
  assert.equal('fallback' in amp.classifyAmpFailure({ stderr: 'unexpected crash', status: 1 }), false);
});

test('Amp preflight reports a missing executable without probing another coding CLI', async () => {
  const calls = [];
  const runtime = await amp.probeAmpRuntime({
    cwd: process.cwd(),
    run: async (options) => {
      calls.push(options);
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn amp ENOENT'), { code: 'ENOENT' }) };
    },
  });
  assert.deepEqual(runtime, { id: 'amp', available: false, version: '', reason: 'amp_not_installed', project: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'amp');
});

test('Amp preflight distinguishes unsupported CLI capabilities, auth, and project matching', async () => {
  const responses = [
    { status: 0, stdout: '0.0.test', stderr: '', error: null },
    { status: 0, stdout: 'Usage: amp --execute', stderr: '', error: null },
  ];
  const unsupported = await amp.probeAmpRuntime({
    cwd: process.cwd(),
    run: async () => responses.shift(),
  });
  assert.equal(unsupported.reason, 'amp_version_unsupported');

  const authenticated = [
    { status: 0, stdout: '0.0.test', stderr: '', error: null },
    { status: 0, stdout: 'threads continue --stream-json -o orb', stderr: '', error: null },
    { status: 1, stdout: '', stderr: 'Please login to Amp', error: null },
  ];
  const auth = await amp.probeAmpRuntime({ cwd: process.cwd(), run: async () => authenticated.shift() });
  assert.equal(auth.reason, 'amp_not_authenticated');

  const unavailable = [
    { status: 0, stdout: '0.0.test', stderr: '', error: null },
    { status: 0, stdout: 'threads continue --stream-json -o orb', stderr: '', error: null },
    { status: 1, stdout: '', stderr: 'network unavailable', error: null },
  ];
  const accountNetworkFailure = await amp.probeAmpRuntime({ cwd: process.cwd(), run: async () => unavailable.shift() });
  assert.equal(accountNetworkFailure.reason, 'amp_cli_crashed', 'an unrelated account probe failure is not mislabeled as a login problem');

  const unmatched = [
    { status: 0, stdout: '0.0.test', stderr: '', error: null },
    { status: 0, stdout: 'threads continue --stream-json -o orb', stderr: '', error: null },
    { status: 0, stdout: '[]', stderr: '', error: null },
    { status: 0, stdout: JSON.stringify({ status: 'unmatched', project: null }), stderr: '', error: null },
  ];
  const project = await amp.probeAmpRuntime({ cwd: process.cwd(), run: async () => unmatched.shift() });
  assert.equal(project.reason, 'amp_project_unmatched');

  const forbidden = [
    { status: 0, stdout: '0.0.test', stderr: '', error: null },
    { status: 0, stdout: 'threads continue --stream-json -o orb', stderr: '', error: null },
    { status: 0, stdout: 'usage ok', stderr: '', error: null },
    { status: 0, stdout: JSON.stringify({ status: 'forbidden', project: null }), stderr: '', error: null },
  ];
  const denied = await amp.probeAmpRuntime({ cwd: process.cwd(), run: async () => forbidden.shift() });
  assert.equal(denied.reason, 'amp_project_forbidden');
});

test('Amp cwd must be an operator-allowed git repo and setup must be executable', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-amp-repo-'));
  try {
    await fs.mkdir(path.join(temp, '.git'));
    await fs.mkdir(path.join(temp, '.agents'));
    await fs.writeFile(path.join(temp, '.agents', 'setup'), '#!/bin/sh\n', { mode: 0o600 });
    await assert.rejects(
      () => amp.assertAmpRepo({ cwd: temp, allowedRoots: [temp] }),
      error => error?.code === 'amp_setup_failed',
    );
    await fs.chmod(path.join(temp, '.agents', 'setup'), 0o700);
    await assert.doesNotReject(() => amp.assertAmpRepo({ cwd: temp, allowedRoots: [temp] }));
    await assert.rejects(
      () => amp.assertAmpRepo({ cwd: temp, allowedRoots: [path.dirname(temp)] }),
      error => error?.code === 'amp_repo_not_allowed',
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('daemon streams new and continued Amp turns and never launches its configured coding fallback', async () => {
  const { __test: daemon } = await import('../packages/agensis-cli/src/agensis.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-amp-turn-'));
  const fakeAmp = path.join(temp, 'amp.mjs');
  const fallback = path.join(temp, 'fallback.mjs');
  const callsFile = path.join(temp, 'calls.jsonl');
  const fallbackMarker = path.join(temp, 'fallback-ran');
  const threadId = 'T-019fa798-10c0-76f8-9844-d848ba21c6d4';
  try {
    await fs.mkdir(path.join(temp, '.git'));
    await fs.writeFile(fakeAmp, [
      '#!/usr/bin/env node',
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      'const a = process.argv.slice(2);',
      'if (a[0] === "version") process.stdout.write("0.0.fake\\n");',
      'else if (a[0] === "--help") process.stdout.write("orb threads continue --stream-json\\n");',
      'else if (a[0] === "usage") process.stdout.write("usage ok\\n");',
      'else if (a[0] === "projects" && a[1] === "status") process.stdout.write(JSON.stringify({ status: "matched", project: { id: "p1", name: "Fake", repository: "example/repo" } }) + "\\n");',
      'else if (a.includes("--stream-json") && (a.includes("prompt cancel") || a.includes("prompt timeout"))) setInterval(() => {}, 1000);',
      'else if (a.includes("--stream-json") && a.includes("prompt invalid")) process.stdout.write(JSON.stringify({ type: "result", result: "No thread id." }) + "\\n");',
      'else if (a.includes("--stream-json") && a.includes("prompt missing")) { process.stderr.write("Thread was not found\\n"); process.exitCode = 1; }',
      `else if (a.includes("--stream-json")) process.stdout.write([JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(threadId)} }), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Amp finished." }] } }), JSON.stringify({ type: "result", result: "Amp finished." })].join("\\n") + "\\n");`,
      'else process.exitCode = 2;',
    ].join('\n'), { mode: 0o700 });
    await fs.writeFile(fallback, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(fallbackMarker)}, 'bad');\n`, { mode: 0o700 });

    const config = daemon.normalizeConfig({
      url: 'https://agents.example.test',
      token: 'aga_test',
      workspace: 'workspace-1',
      agent: 'agent-1',
      cwd: temp,
      codingCmd: fallback,
      ampCmd: fakeAmp,
      runtime: 'amp',
      heartbeatMs: 0,
    });
    const capabilities = await daemon.computeCapabilities(config);
    assert.deepEqual(capabilities.runtimes.claude, {
      id: 'claude',
      label: 'Claude',
      available: capabilities.clis.includes('claude'),
    });
    assert.deepEqual(capabilities.runtimes.codex, {
      id: 'codex',
      label: 'Codex',
      available: capabilities.clis.includes('codex'),
    });
    assert.deepEqual(capabilities.runtimes.amp, {
      id: 'amp',
      label: 'Amp',
      available: true,
      version: '0.0.fake',
      reason: null,
      project: { id: 'p1', name: 'Fake', repository: 'example/repo' },
    });
    const run = async (id, runtime = undefined, options = {}) => {
      const sent = [];
      await daemon.runAgentJob(options.config || config, {
        id,
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        prompt: `prompt ${id}`,
        runtime,
        agent: { run_mode: 'daemon', metadata: { runtime: 'amp' } },
        ws: { readyState: 1, send: payload => sent.push(JSON.parse(payload)) },
      }, { signal: options.signal || new AbortController().signal });
      return sent;
    };

    const first = await run('new');
    const firstResult = first.find(frame => frame.action === 'agent_job_result');
    assert.equal(firstResult.response, 'Amp finished.');
    assert.equal(firstResult.error, '');
    assert.equal(firstResult.metadata.ampThreadId, threadId);
    assert.equal(firstResult.metadata.ampThreadUrl, `https://ampcode.com/threads/${threadId}`);

    const second = await run('continue', { id: 'amp', threadId });
    assert.equal(second.find(frame => frame.action === 'agent_job_result').response, 'Amp finished.');

    const invalid = await run('invalid');
    assert.equal(invalid.find(frame => frame.action === 'agent_job_result').metadata.ampErrorCode, 'amp_stream_invalid');

    const missing = await run('missing', { id: 'amp', threadId });
    const missingResult = missing.find(frame => frame.action === 'agent_job_result');
    assert.equal(missingResult.metadata.ampErrorCode, 'amp_thread_not_found');
    assert.equal(missingResult.metadata.ampThreadId, threadId);

    const invalidBinding = await run('continue', { id: 'amp', threadId: '../invalid' });
    assert.equal(invalidBinding.find(frame => frame.action === 'agent_job_result').metadata.ampErrorCode, 'amp_thread_not_found');

    const missingBinding = await run('continue-required', { id: 'amp', continuationRequired: true });
    assert.equal(missingBinding.find(frame => frame.action === 'agent_job_result').metadata.ampErrorCode, 'amp_thread_not_found');

    const cancelController = new AbortController();
    const cancelledPromise = run('cancel', undefined, { signal: cancelController.signal });
    setTimeout(() => cancelController.abort(), 25);
    const cancelled = await cancelledPromise;
    assert.equal(cancelled.find(frame => frame.action === 'agent_job_result').metadata.ampErrorCode, 'amp_turn_cancelled');

    const timeoutConfig = { ...config, timeoutMs: 100 };
    const timedOut = await run('timeout', undefined, { config: timeoutConfig });
    assert.equal(timedOut.find(frame => frame.action === 'agent_job_result').metadata.ampErrorCode, 'amp_turn_timed_out');

    const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.some(args => args[0] === '-ox' && args.includes('--stream-json') && args.includes('--no-archive-after-execute')));
    assert.ok(calls.some(args => args[0] === 'threads' && args[1] === 'continue' && args[2] === threadId));
    const missingCall = calls.find(args => args.includes('prompt missing'));
    assert.deepEqual(missingCall.slice(0, 3), ['threads', 'continue', threadId], 'a missing continuation never falls back to a fresh orb');
    assert.equal(calls.some(args => args.includes('../invalid')), false, 'an invalid continuation never launches Amp');
    assert.equal(calls.some(args => args.includes('prompt continue-required')), false, 'a missing required binding never launches a fresh orb');
    await assert.rejects(() => fs.access(fallbackMarker), error => error?.code === 'ENOENT');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('runtime-locked profiles refuse mismatched jobs before command or executor fallback', async () => {
  const { __test: daemon } = await import('../packages/agensis-cli/src/agensis.mjs');
  const sent = [];
  const ws = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
  const base = { url: 'https://agents.example.test', token: 'aga_test', workspace: 'workspace-1', agent: 'agent-1' };

  const ampConfig = daemon.normalizeConfig({ ...base, runtime: 'amp', codingCmd: 'this-fallback-must-not-run' });
  assert.equal(ampConfig.codingCmd, '', 'an Amp-locked profile cannot initialize a fallback coding executor');
  await daemon.runAgentJob(ampConfig, { id: 'normal', prompt: 'normal', agent: { metadata: {} }, ws }, { signal: new AbortController().signal });
  assert.match(sent.at(-1).error, /runtime amp cannot accept job runtime custom/);

  sent.length = 0;
  const claudeConfig = daemon.normalizeConfig({ ...base, runtime: 'claude', codingCmd: 'claude -p' });
  await daemon.runAgentJob(claudeConfig, { id: 'amp', prompt: 'amp', agent: { metadata: { runtime: 'amp' } }, ws }, { signal: new AbortController().signal });
  assert.match(sent.at(-1).error, /runtime claude cannot accept job runtime amp/);
});
