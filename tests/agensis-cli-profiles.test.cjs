const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'packages/agensis-cli/src/connectProfiles.mjs')).href;
const agentModuleUrl = pathToFileURL(path.join(repoRoot, 'packages/agensis-cli/src/agensis.mjs')).href;

async function loadModule() {
  return import(moduleUrl);
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agensis-cli-profiles-'));
}

test('daemon profiles persist a complete main agent connect command securely', async () => {
  const {
    daemonProfilePath,
    readDaemonProfile,
    writeDaemonProfile,
  } = await loadModule();
  const home = await tempHome();
  try {
    const filePath = await writeDaemonProfile('default', {
      url: 'http://localhost:61447',
      token: 'aga_secret_token',
      workspace: 'ws-1',
      agent: 'agent-1',
      handle: 'mac',
      name: 'mac',
      cwd: '/Users/example/projects/sample-app',
      runtime: 'amp',
      model: 'claude-opus-4-8',
      permissionMode: 'accept_edits',
      share: true,
      sharedModelsFile: '/Users/example/models.json',
      noCoding: true,
      exitOnOnce: true,
      onRegistered: () => {},
    }, { homedir: home });

    assert.equal(filePath, daemonProfilePath('default', { homedir: home }));
    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
    const cached = await readDaemonProfile('default', { homedir: home });
    assert.deepEqual(cached, {
      url: 'http://localhost:61447',
      token: 'aga_secret_token',
      workspace: 'ws-1',
      agent: 'agent-1',
      handle: 'mac',
      name: 'mac',
      cwd: '/Users/example/projects/sample-app',
      runtime: 'amp',
      model: 'claude-opus-4-8',
      permissionMode: 'accept_edits',
      share: true,
      sharedModelsFile: '/Users/example/models.json',
      noCoding: true,
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('daemon profile merge lets one-off flags override the cached profile', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'agent-1',
    cwd: '/old',
    model: 'claude-opus-4-8',
  }, {
    cwd: '/new',
    model: 'claude-fable-5',
    once: true,
  });

  assert.equal(merged.command, 'connect');
  assert.equal(merged.url, 'http://localhost:61447');
  assert.equal(merged.token, 'aga_secret_token');
  assert.equal(merged.cwd, '/new');
  assert.equal(merged.model, 'claude-fable-5');
  assert.equal(merged.once, true);
});

test('full CLI context opt-out survives the saved-profile merge path', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const { __test: agentTest } = await import(agentModuleUrl);
  const merged = mergeDaemonProfile({
    url: 'https://agensis.test', token: 'aga_secret', workspace: 'workspace-1', agent: 'agent-1', leanCli: true,
  }, { fullCliContext: true });
  const normalized = agentTest.normalizeConfig(merged);
  assert.equal(normalized.leanCli, false);
});

test('runtime selection is bounded and legacy profiles infer it from their coding command', async () => {
  const { __test: agentTest } = await import(agentModuleUrl);
  const base = { url: 'https://agensis.test', token: 'aga_secret', workspace: 'workspace-1', agent: 'agent-1' };

  assert.equal(agentTest.normalizeConfig({ ...base, runtime: 'amp' }).runtime, 'amp');
  assert.equal(agentTest.normalizeConfig({ ...base, runtime: 'amp' }).codingCmd, '', 'Amp profiles have no Claude/Codex fallback command');
  assert.equal(agentTest.normalizeConfig({ ...base, runtime: 'amp' }).model, '', 'Amp chooses its model inside Amp');
  const codex = agentTest.normalizeConfig({ ...base, runtime: 'codex' });
  assert.equal(codex.runtime, 'codex');
  assert.equal(codex.codingCmd, 'codex exec');
  assert.equal(codex.model, '', 'Codex default must not become a Claude model id');
  assert.equal(agentTest.normalizeConfig({ ...base, codingCmd: 'codex exec' }).runtime, 'codex');
  assert.equal(agentTest.normalizeConfig({ ...base, runtime: 'codex', model: 'gpt-5.4' }).model, 'gpt-5.4');
  assert.equal(agentTest.normalizeConfig({ ...base, codingCmd: '/opt/bin/claude -p' }).runtime, 'claude');
  assert.equal(agentTest.normalizeConfig({ ...base, ampCmd: '/opt/bin/amp' }).runtime, 'claude', '--amp-cmd configures discovery but does not select Amp');
  assert.equal(agentTest.normalizeConfig({ ...base, runtime: 'claude' }).model, 'claude-opus-4-8');
  assert.equal(agentTest.normalizeConfig({ ...base, codingCmd: './my-runner' }).runtime, 'custom');
  assert.throws(
    () => agentTest.normalizeConfig({ ...base, runtime: 'shell' }),
    /--runtime must be one of: claude, codex, amp/,
  );
});

test('legacy profiles migrate the old persisted concurrency default from eight to two', async () => {
  const { daemonProfilePath, readDaemonProfile } = await loadModule();
  const home = await tempHome();
  try {
    const filePath = daemonProfilePath('legacy', { homedir: home });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      config: {
        url: 'https://agensis.test',
        token: 'aga_secret',
        workspace: 'workspace-1',
        agent: 'agent-1',
        maxConcurrency: 8,
      },
    }));
    const profile = await readDaemonProfile('legacy', { homedir: home });
    assert.equal(profile.maxConcurrency, 2);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('an explicit coding command re-enables a saved no-coding profile', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'https://agensis.test', token: 'aga_secret', workspace: 'workspace-1', agent: 'agent-1', noCoding: true,
  }, { codingCmd: 'codex exec' });
  assert.equal(merged.codingCmd, 'codex exec');
  assert.equal(merged.noCoding, false);
});

test('daemon profile merge disables CursorBuddy bridge for non-primary saved agents', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'coder-agent',
    handle: 'coder',
    name: 'Coder',
    cursorBuddyBridge: true,
  }, {});

  assert.equal(merged.cursorBuddyBridge, false);
});

test('daemon profile merge preserves CursorBuddy bridge for the primary daemon', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'main-agent',
    handle: 'dev-machine-local',
    name: 'dev-machine.local',
    primaryDaemon: true,
    cursorBuddyBridge: true,
  }, {});

  assert.equal(merged.primaryDaemon, true);
  assert.equal(merged.cursorBuddyBridge, true);
});

test('explicit CursorBuddy bridge flag can opt a non-primary daemon back in', async () => {
  const { mergeDaemonProfile } = await loadModule();
  const merged = mergeDaemonProfile({
    url: 'http://localhost:61447',
    token: 'aga_secret_token',
    workspace: 'ws-1',
    agent: 'coder-agent',
    handle: 'coder',
    name: 'Coder',
    cursorBuddyBridge: false,
  }, {
    cursorBuddyBridge: true,
  });

  assert.equal(merged.cursorBuddyBridge, true);
});

test('bare connect setup message points users at Agensis setup first', async () => {
  const { daemonProfileSetupMessage } = await loadModule();
  const message = daemonProfileSetupMessage('default');
  assert.match(message, /No saved Agensis daemon profile/);
  assert.match(message, /Run: agensis setup/);
  assert.match(message, /primary local agent/);
  assert.match(message, /copy a connection command/);
  assert.match(message, /agensis connect/);
});

test('normalized no-coding state survives the real profile write and read path', async () => {
  const { readDaemonProfile, writeDaemonProfile } = await loadModule();
  const { __test: agentTest } = await import(agentModuleUrl);
  const home = await tempHome();
  try {
    const config = agentTest.normalizeConfig({
      url: 'https://agensis.test', token: 'aga_secret', workspace: 'workspace-1', agent: 'agent-1', noCoding: true,
    });
    await writeDaemonProfile('shared-only', config, { homedir: home });
    const stored = await readDaemonProfile('shared-only', { homedir: home });
    assert.equal(stored.noCoding, true);
    assert.equal(stored.codingCmd, undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sessionSlots must survive a profile round-trip.
//
// maxConcurrency was persisted and sessionSlots was not, and the two only work
// as a pair: slots are clamped to [1, maxConcurrency], so a profile that
// remembered 8 concurrency and forgot the slots came back with one connection.
// That is precisely the "--max-concurrency is a no-op" symptom sessionSlots.mjs
// was written to fix — reintroduced silently on every --profile restart.
// ---------------------------------------------------------------------------

test('sessionSlots survives the real profile write and read path', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-slots-'));
  const prev = process.env.AGENSIS_HOME;
  process.env.AGENSIS_HOME = dir;
  try {
    const mod = await import('../packages/agensis-cli/src/connectProfiles.mjs');
    const config = {
      url: 'https://example.invalid',
      token: 'aga_' + 'x'.repeat(32),
      workspace: 'w1',
      agent: 'a1',
      handle: 'coder',
      maxConcurrency: 8,
      sessionSlots: 8,
    };
    await mod.writeDaemonProfile('slots-test', config);
    const back = await mod.readDaemonProfile('slots-test');

    assert.equal(Number(back.sessionSlots), 8,
      'sessionSlots must round-trip; without it a --profile restart silently falls back to one connection');
    assert.equal(Number(back.maxConcurrency), 8,
      'and its ceiling must round-trip too, or the slots get clamped back down');
  } finally {
    if (prev === undefined) delete process.env.AGENSIS_HOME; else process.env.AGENSIS_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
