'use strict';

// permissions.mjs — interactive tool approvals, plus the two places
// connectionExecutors.mjs consumes them (the Claude SDK's canUseTool callback
// and Codex app-server's requestApproval JSON-RPC requests).
//
// The behaviour that matters here is not "does a prompt appear" but the
// direction of every failure: an undeliverable request, an expired one, a
// cancelled job and a dead socket must all DENY, because each of them means
// nobody is going to answer. A bug that parks instead holds the turn open until
// the job's own 30-minute timeout kills it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const loadPermissions = () =>
  import(pathToFileURL(path.resolve(__dirname, '../packages/agensis-cli/src/permissions.mjs')).href);
const loadExecutors = () =>
  import(pathToFileURL(path.resolve(__dirname, '../packages/agensis-cli/src/connectionExecutors.mjs')).href);

// The shape the Claude SDK hands canUseTool as `suggestions` — the rules it
// would write if a human picked "always allow".
const bashCloneSuggestions = [{
  type: 'addRules',
  behavior: 'allow',
  destination: 'localSettings',
  rules: [{ toolName: 'Bash', ruleContent: 'git clone:*' }],
}];

// --- rule identity ----------------------------------------------------------

test('a rule key round-trips through the canonical string the server stores', async () => {
  const { ruleKey, parseRuleKey } = await loadPermissions();
  assert.equal(ruleKey({ toolName: 'Bash', ruleContent: 'git clone:*' }), 'Bash(git clone:*)');
  assert.equal(ruleKey({ toolName: 'WebFetch' }), 'WebFetch');
  assert.equal(ruleKey({ toolName: '' }), '');
  assert.deepEqual(parseRuleKey('Bash(git clone:*)'), { toolName: 'Bash', ruleContent: 'git clone:*' });
  assert.deepEqual(parseRuleKey('WebFetch'), { toolName: 'WebFetch' });
});

test('only allow-rules are harvested from suggestions — never a mode flip or a new directory', async () => {
  const { suggestionRuleKeys } = await loadPermissions();
  const keys = suggestionRuleKeys([
    ...bashCloneSuggestions,
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'addDirectories', directories: ['/'], destination: 'session' },
    { type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }] },
  ]);
  // A setMode suggestion would turn "always allow this command" into full yolo,
  // and addDirectories would widen the filesystem allowlist that host_folders
  // deliberately gates behind the manage role.
  assert.deepEqual(keys, ['Bash(git clone:*)']);
});

// --- rule synthesis ---------------------------------------------------------
//
// The CLI frequently sends NO `permission_suggestions` at all. Since those
// suggestions were the only input to both the "always allow" button and to rule
// matching, permanent grants were inert end-to-end: no way to make one, and no
// way for one to ever match. These synthesize the rule ourselves.

test('a simple command gets a prefix rule, and a redirect does not disqualify it', async () => {
  const { requestRuleKeys } = await loadPermissions();
  const rules = (command) => requestRuleKeys({ toolName: 'Bash', input: { command } });

  assert.deepEqual(rules('git clone https://github.com/x/y'), ['Bash(git clone:*)']);
  // `2>&1` contains an `&` but runs no second command. Treating it as chaining
  // refused a rule for the most ordinary command there is — and was exactly the
  // case that exposed this.
  assert.deepEqual(rules('git clone https://github.com/x/y 2>&1'), ['Bash(git clone:*)']);
  assert.deepEqual(rules('npm test > out.log 2>&1'), ['Bash(npm test:*)']);
  assert.deepEqual(rules('ls -la'), ['Bash(ls:*)']);
  // A flag is not a subcommand, so the rule narrows to the bare program rather
  // than inventing `git -C` as a thing to grant.
  assert.deepEqual(rules('git -C /tmp status'), ['Bash(git:*)']);
});

test('a chained command gets NO rule, because a prefix over one grants what follows', async () => {
  const { requestRuleKeys } = await loadPermissions();
  const rules = (command) => requestRuleKeys({ toolName: 'Bash', input: { command } });

  // `Bash(cd foo:*)` reads as "let it cd into foo" and matches
  // `cd foo && rm -rf /`. Offering no rule means the request falls back to
  // once/session, which is the truthful set.
  assert.deepEqual(rules('cd agensis-agent && echo x && ls -la'), []);
  assert.deepEqual(rules('echo hi | grep h'), []);
  assert.deepEqual(rules('rm -rf /tmp/x; echo done'), []);
  assert.deepEqual(rules('sleep 5 &'), []);
  assert.deepEqual(rules('cat $(cat /etc/passwd)'), []);
  assert.deepEqual(rules('echo `whoami`'), []);
  assert.deepEqual(rules(''), []);
});

test('no tool other than Bash gets a synthesized rule', async () => {
  const { requestRuleKeys } = await loadPermissions();
  // A whole-tool `Write` rule means "write any file, forever", which is not what
  // an "always allow" click sitting next to one path means.
  assert.deepEqual(requestRuleKeys({ toolName: 'Write', input: { file_path: '/root/x' } }), []);
  assert.deepEqual(requestRuleKeys({ toolName: 'WebFetch', input: { url: 'https://x' } }), []);
});

test('a rule the CLI offered always wins over one we would synthesize', async () => {
  const { requestRuleKeys } = await loadPermissions();
  // Its own suggestion is authoritative about its own matching semantics; ours
  // is only the fallback for when it sends nothing.
  assert.deepEqual(
    requestRuleKeys({ toolName: 'Bash', input: { command: 'git clone https://x/y' }, suggestions: bashCloneSuggestions }),
    ['Bash(git clone:*)'],
  );
  assert.deepEqual(
    requestRuleKeys({
      toolName: 'Bash',
      input: { command: 'ls -la' },
      suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'ls -la' }] }],
    }),
    ['Bash(ls -la)'],
  );
});

test('a synthesized grant matches the next call, which is what makes "always" real', async () => {
  const { isAllowedByStoredRules, requestRuleKeys } = await loadPermissions();
  // The key stored on the agent and the key compared later both come from
  // requestRuleKeys, so they cannot disagree. Without this the button could be
  // clicked and the rule would still never match.
  const stored = requestRuleKeys({ toolName: 'Bash', input: { command: 'git clone https://x/y' } });
  assert.deepEqual(stored, ['Bash(git clone:*)']);

  assert.equal(
    isAllowedByStoredRules(stored, { toolName: 'Bash', input: { command: 'git clone https://other/repo 2>&1' } }),
    true,
  );
  // A different command is a different permission and must still be asked.
  assert.equal(isAllowedByStoredRules(stored, { toolName: 'Bash', input: { command: 'git push origin main' } }), false);
  // And the grant must not leak onto a chained command that merely starts the same.
  assert.equal(isAllowedByStoredRules(stored, { toolName: 'Bash', input: { command: 'git clone https://x/y && rm -rf /' } }), false);
});

test('stored rules are read from either the canonical strings or raw rule objects', async () => {
  const { normalizeStoredRules, jobPermissionRules } = await loadPermissions();
  assert.deepEqual(normalizeStoredRules(['Bash(git clone:*)', 'Bash(git clone:*)']), ['Bash(git clone:*)']);
  assert.deepEqual(normalizeStoredRules([{ toolName: 'Bash', ruleContent: 'git push:*' }]), ['Bash(git push:*)']);
  assert.deepEqual(normalizeStoredRules(null), []);
  assert.deepEqual(
    jobPermissionRules({ agent: { metadata: { permission_rules: ['WebFetch'] } } }),
    ['WebFetch'],
  );
});

test('a stored rule matches the identical suggestion, a different one, or a whole tool', async () => {
  const { isAllowedByStoredRules } = await loadPermissions();
  const stored = ['Bash(git clone:*)', 'WebFetch'];

  assert.equal(isAllowedByStoredRules(stored, { toolName: 'Bash', suggestions: bashCloneSuggestions }), true);
  // A whole-tool rule carries no content, so it covers any call to that tool.
  assert.equal(isAllowedByStoredRules(stored, { toolName: 'WebFetch', suggestions: [] }), true);
  // Claude considers `git push` a different permission and suggests a different
  // rule for it — so it must be asked, not silently swept in by the clone grant.
  assert.equal(isAllowedByStoredRules(stored, {
    toolName: 'Bash',
    suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }] }],
  }), false);
  // Same tool, no matching suggestion: a bare tool name in the input must NOT
  // satisfy a content-scoped stored rule.
  assert.equal(isAllowedByStoredRules(['Bash(git clone:*)'], { toolName: 'Bash', suggestions: [] }), false);
  assert.equal(isAllowedByStoredRules([], { toolName: 'Bash', suggestions: bashCloneSuggestions }), false);
});

// --- the broker -------------------------------------------------------------

test('a request rides the socket and resolves with the decision that comes back', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const sent = [];
  const broker = createPermissionBroker({ send: (frame) => { sent.push(frame); return true; } });

  const pending = broker.request({
    jobId: 'job-1',
    toolName: 'Bash',
    detail: 'git clone https://github.com/x/y',
    suggestions: bashCloneSuggestions,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'agent_permission_request');
  assert.equal(sent[0].jobId, 'job-1');
  assert.equal(sent[0].toolName, 'Bash');
  assert.deepEqual(sent[0].rules, ['Bash(git clone:*)']);
  // "always" is only offered when there is a concrete rule to make permanent.
  assert.deepEqual(sent[0].scopes, ['once', 'session', 'always']);

  broker.decide({ requestId: sent[0].requestId, behavior: 'allow', scope: 'always', decidedBy: 'Jason' });
  assert.deepEqual(await pending, { behavior: 'allow', scope: 'always', decidedBy: 'Jason' });
  assert.equal(broker.pendingCount(), 0);
});

test('a request with no rule to store offers only once and session', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const sent = [];
  const broker = createPermissionBroker({ send: (frame) => { sent.push(frame); return true; } });
  const pending = broker.request({ jobId: 'job-1', toolName: 'Codex command' });
  assert.deepEqual(sent[0].scopes, ['once', 'session']);
  broker.decide({ requestId: sent[0].requestId, behavior: 'deny' });
  assert.equal((await pending).behavior, 'deny');
});

test('an undeliverable request denies immediately instead of parking on a dead socket', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => false });
  const outcome = await broker.request({ jobId: 'job-1', toolName: 'Bash' });
  assert.equal(outcome.behavior, 'deny');
  assert.match(outcome.message, /unreachable/i);
  assert.equal(broker.pendingCount(), 0);
});

test('an unanswered request expires as a denial the model can explain', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => true, timeoutMs: 5 });
  const outcome = await broker.request({ jobId: 'job-1', toolName: 'Bash' });
  assert.equal(outcome.behavior, 'deny');
  assert.match(outcome.message, /Nobody approved this/);
});

test('cancelling a job denies every request parked for it and leaves other jobs alone', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => true });
  const mine = broker.request({ jobId: 'job-1', toolName: 'Bash' });
  const other = broker.request({ jobId: 'job-2', toolName: 'Bash' });

  assert.equal(broker.cancelJob('job-1'), 1);
  assert.equal((await mine).behavior, 'deny');
  assert.equal(broker.pendingCount(), 1);

  broker.shutdown();
  assert.equal((await other).behavior, 'deny');
});

// --- surviving a reconnect ---------------------------------------------------
//
// A dropped socket used to deny every parked request on the spot, on the theory
// that "the reconnect gets a fresh socket the server has no request ids for".
// That was true only because nobody told it: the turn is still executing inside
// the CLI subprocess, and 2026-07-29 an Edit approval raised 90 seconds earlier,
// with eight minutes of its ten-minute TTL left, died because the socket blipped.
//
// So the park now survives, and the register frame re-asserts the ids — which is
// also the ONLY way the server can tell a blip from a restart, since the frame
// carries no process identity. resume() then reconciles: the server names what
// it kept, and everything else is denied here rather than left hanging.

test('the ids a reconnect re-asserts are exactly the ones still parked', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => true, idFactory: (() => { let n = 0; return () => `req-${n += 1}`; })() });

  const first = broker.request({ jobId: 'job-1', toolName: 'Bash' });
  broker.request({ jobId: 'job-2', toolName: 'Edit' });
  assert.deepEqual(broker.parkedRequestIds(), ['req-1', 'req-2']);

  broker.decide({ requestId: 'req-1', behavior: 'allow', scope: 'once' });
  await first;
  assert.deepEqual(broker.parkedRequestIds(), ['req-2'], 'a settled request is not re-asserted');
});

test('a request the server re-homed keeps waiting for its human', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => true, idFactory: () => 'req-1' });
  const parked = broker.request({ jobId: 'job-1', toolName: 'Edit' });

  // The socket dropped and came back; the server confirms this park survived.
  assert.deepEqual(broker.resume(['req-1']), { kept: 1, denied: 0 });
  assert.equal(broker.pendingCount(), 1, 'still parked — the human has minutes of TTL left to answer');

  // And the decision that eventually arrives still settles it.
  assert.equal(broker.decide({ requestId: 'req-1', behavior: 'allow', scope: 'once' }), true);
  assert.equal((await parked).behavior, 'allow');
});

test('a request the server did not re-home is denied at once, not left hanging', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => true, idFactory: () => 'req-1' });
  const parked = broker.request({ jobId: 'job-1', toolName: 'Edit' });

  // The server expired it — its card is gone, so no decision can ever arrive.
  // Parking on regardless would hold the turn to the full 10-minute TTL.
  assert.deepEqual(broker.resume(['some-other-id']), { kept: 1, denied: 1 });
  assert.equal((await parked).behavior, 'deny');
  assert.equal(broker.pendingCount(), 0);
});

test('an older server that says nothing about parks denies them, rather than hanging the turn', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => true, idFactory: () => 'req-1' });
  const parked = broker.request({ jobId: 'job-1', toolName: 'Edit' });

  // No `resumedPermissionRequests` field at all. Absent must read as "none kept"
  // — the fail-closed direction, and exactly the pre-existing deny-on-drop
  // behaviour. Reading it as "keep everything" would hang against every server
  // that has not shipped the re-home yet.
  assert.deepEqual(broker.resume(undefined), { kept: 0, denied: 1 });
  assert.equal((await parked).behavior, 'deny');
});

test('a decision for an unknown request id is ignored rather than crashing the socket handler', async () => {
  const { createPermissionBroker } = await loadPermissions();
  const broker = createPermissionBroker({ send: () => true });
  assert.equal(broker.decide({ requestId: 'nope', behavior: 'allow' }), false);
  assert.equal(broker.decide({}), false);
});

// --- Claude SDK lane --------------------------------------------------------

/** A fake SDK query that calls canUseTool once, then answers with the verdict it got. */
function permissionProbeQuery({ toolName = 'Bash', input = { command: 'git clone x' }, suggestions = bashCloneSuggestions } = {}) {
  let seen = null;
  let verdict = null;
  const queryFn = ({ prompt, options }) => {
    seen = options;
    const gen = (async function* () {
      for await (const _input of prompt) {
        verdict = await options.canUseTool(toolName, input, { suggestions, signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' });
        yield { type: 'result', subtype: 'success', result: 'done', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  return { queryFn, options: () => seen, verdict: () => verdict };
}

test('claude sdk executor: a tool needing approval asks the human and allows on yes', async () => {
  const { createClaudeSdkExecutor } = await loadExecutors();
  const probe = permissionProbeQuery();
  const asked = [];
  const ex = createClaudeSdkExecutor({
    queryFn: probe.queryFn,
    requestPermission: async (payload) => { asked.push(payload); return { behavior: 'allow', scope: 'once' }; },
  });

  const result = await ex.run({ cwd: '/tmp', prompt: 'clone it', sessionKey: 'silo-1', job: { id: 'job-9' }, onData: () => {} });

  assert.equal(result.status, 0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].jobId, 'job-9');
  assert.equal(asked[0].toolName, 'Bash');
  assert.equal(asked[0].detail, 'git clone x');
  // 'once' grants exactly this call: handing the SDK its suggestions back would
  // silently upgrade it to "for the rest of the session".
  assert.deepEqual(probe.verdict(), { behavior: 'allow' });
});

test('claude sdk executor: allowing for the session hands the SDK its own suggestions back', async () => {
  const { createClaudeSdkExecutor } = await loadExecutors();
  const probe = permissionProbeQuery();
  const ex = createClaudeSdkExecutor({
    queryFn: probe.queryFn,
    requestPermission: async () => ({ behavior: 'allow', scope: 'session' }),
  });

  await ex.run({ cwd: '/tmp', prompt: 'clone it', sessionKey: 'silo-1', job: { id: 'job-9' }, onData: () => {} });
  assert.deepEqual(probe.verdict(), { behavior: 'allow', updatedPermissions: bashCloneSuggestions });
});

test('claude sdk executor: a denial reaches the model as a message, not an opaque tool error', async () => {
  const { createClaudeSdkExecutor } = await loadExecutors();
  const probe = permissionProbeQuery();
  const ex = createClaudeSdkExecutor({
    queryFn: probe.queryFn,
    requestPermission: async () => ({ behavior: 'deny', message: 'Jason denied this tool call.' }),
  });

  await ex.run({ cwd: '/tmp', prompt: 'clone it', sessionKey: 'silo-1', job: { id: 'job-9' }, onData: () => {} });
  assert.deepEqual(probe.verdict(), { behavior: 'deny', message: 'Jason denied this tool call.' });
});

test('claude sdk executor: a rule the workspace already granted permanently is not re-asked', async () => {
  const { createClaudeSdkExecutor } = await loadExecutors();
  const probe = permissionProbeQuery();
  let asked = 0;
  const ex = createClaudeSdkExecutor({
    queryFn: probe.queryFn,
    requestPermission: async () => { asked += 1; return { behavior: 'deny' }; },
  });

  await ex.run({
    cwd: '/tmp',
    prompt: 'clone it',
    sessionKey: 'silo-1',
    job: { id: 'job-9', agent: { metadata: { permission_rules: ['Bash(git clone:*)'] } } },
    onData: () => {},
  });

  // Otherwise "always allow" would mean "ask me again on every new job".
  assert.equal(asked, 0);
  assert.deepEqual(probe.verdict(), { behavior: 'allow' });
});

test('claude sdk executor: with no broker at all, canUseTool is left unset as before', async () => {
  const { createClaudeSdkExecutor } = await loadExecutors();
  const probe = permissionProbeQuery();
  const ex = createClaudeSdkExecutor({ queryFn: probe.queryFn });
  // The fake would throw calling an undefined canUseTool; swallow that and
  // assert on the option the SDK was handed instead.
  await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', job: { id: 'j' }, onData: () => {} }).catch(() => {});
  assert.equal(probe.options().canUseTool, undefined);
});

// 'bypassPermissions' auto-approves every tool call BEFORE the callback is
// consulted, so a canUseTool passed alongside it can never run. The SDK spots
// the contradiction and emits CLAUDE_SDK_CAN_USE_TOOL_SHADOWED on stderr for
// every session the daemon opens — noise on a promise the broker cannot keep.
// yolo IS "don't ask me", so the broker is dropped rather than attached inert.
test('claude sdk executor: yolo drops canUseTool instead of attaching one the SDK will never call', async () => {
  const { createClaudeSdkExecutor } = await loadExecutors();
  const probe = permissionProbeQuery();
  let asked = 0;
  const ex = createClaudeSdkExecutor({
    queryFn: probe.queryFn,
    requestPermission: async () => { asked += 1; return { behavior: 'allow', scope: 'once' }; },
  });

  await ex.run({
    cwd: '/tmp', prompt: 'x', sessionKey: 'silo-yolo', permissionMode: 'yolo',
    job: { id: 'j' }, onData: () => {},
  }).catch(() => {});

  assert.equal(probe.options().permissionMode, 'bypassPermissions');
  assert.equal(probe.options().canUseTool, undefined);
  assert.equal(asked, 0, 'yolo must not route tool calls through the human broker');
});

// The other two modes DO consult the callback, so it must still be attached —
// otherwise the fix above would silently kill interactive approvals everywhere.
for (const mode of ['default', 'accept_edits']) {
  test(`claude sdk executor: ${mode} still attaches canUseTool`, async () => {
    const { createClaudeSdkExecutor } = await loadExecutors();
    const probe = permissionProbeQuery();
    const ex = createClaudeSdkExecutor({
      queryFn: probe.queryFn,
      requestPermission: async () => ({ behavior: 'allow', scope: 'once' }),
    });

    await ex.run({
      cwd: '/tmp', prompt: 'x', sessionKey: `silo-${mode}`, permissionMode: mode,
      job: { id: 'j' }, onData: () => {},
    });

    assert.notEqual(probe.options().permissionMode, 'bypassPermissions');
    assert.equal(typeof probe.options().canUseTool, 'function');
    assert.deepEqual(probe.verdict(), { behavior: 'allow' });
  });
}

// --- Codex lane -------------------------------------------------------------

function fakeCodexChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  const writes = [];
  child.stdin = { write: (chunk) => writes.push(chunk) };
  child.kill = () => child.emit('exit', 0, null);
  child.writes = writes;
  child.send = (obj) => child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  return child;
}

/** Drives one command-approval request through a codex turn and reports the answer. */
function codexApprovalServer(child, { availableDecisions } = {}) {
  let approvalResponse = null;
  const threadId = 'thread-1';
  const turnId = 'turn-1';
  const emitTurn = () => {
    child.send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'i1', text: 'ok' } } });
    child.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  };
  const original = child.stdin.write;
  child.stdin.write = (chunk) => {
    original(chunk);
    const { id, method } = JSON.parse(chunk);
    if (id === 'approval-1' && !method) {
      approvalResponse = JSON.parse(chunk);
      queueMicrotask(emitTurn);
      return;
    }
    if (method === 'initialize') queueMicrotask(() => child.send({ id, result: { codexHome: '/tmp' } }));
    else if (method === 'thread/start') queueMicrotask(() => child.send({ id, result: { thread: { id: threadId } } }));
    else if (method === 'turn/start') {
      queueMicrotask(() => {
        child.send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
        child.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
        child.send({
          id: 'approval-1',
          method: 'item/commandExecution/requestApproval',
          params: { threadId, turnId, itemId: 'item-1', command: ['git', 'clone', 'https://x/y'], reason: 'network access', ...(availableDecisions ? { availableDecisions } : {}) },
        });
      });
    }
  };
  return { approvalResponse: () => approvalResponse };
}

test('codex app-server executor: an approval request asks the human instead of auto-declining', async () => {
  const { createCodexAppServerExecutor } = await loadExecutors();
  const child = fakeCodexChild();
  const server = codexApprovalServer(child);
  const asked = [];
  const ex = createCodexAppServerExecutor({
    spawnFn: () => child,
    requestPermission: async (payload) => { asked.push(payload); return { behavior: 'allow', scope: 'session' }; },
  });

  const result = await ex.run({ cwd: '/tmp', prompt: 'clone it', sessionKey: 'silo-1', job: { id: 'job-3' }, onData: () => {} });

  assert.equal(result.status, 0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].jobId, 'job-3');
  assert.equal(asked[0].toolName, 'Codex command');
  assert.equal(asked[0].detail, 'git clone https://x/y');
  assert.deepEqual(server.approvalResponse(), { id: 'approval-1', result: { decision: 'acceptForSession' } });
});

test('codex app-server executor: approving once picks the narrower decision when codex offers it', async () => {
  const { createCodexAppServerExecutor } = await loadExecutors();
  const child = fakeCodexChild();
  const server = codexApprovalServer(child, { availableDecisions: ['accept', 'acceptForSession', 'decline'] });
  const ex = createCodexAppServerExecutor({
    spawnFn: () => child,
    requestPermission: async () => ({ behavior: 'allow', scope: 'once' }),
  });

  await ex.run({ cwd: '/tmp', prompt: 'clone it', sessionKey: 'silo-1', job: { id: 'job-3' }, onData: () => {} });
  assert.deepEqual(server.approvalResponse(), { id: 'approval-1', result: { decision: 'accept' } });
});

test('codex app-server executor: a denial declines, and so does a broker that throws', async () => {
  const { createCodexAppServerExecutor } = await loadExecutors();

  const denied = fakeCodexChild();
  const deniedServer = codexApprovalServer(denied);
  await createCodexAppServerExecutor({
    spawnFn: () => denied,
    requestPermission: async () => ({ behavior: 'deny', message: 'no' }),
  }).run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-a', job: { id: 'j' }, onData: () => {} });
  assert.deepEqual(deniedServer.approvalResponse(), { id: 'approval-1', result: { decision: 'decline' } });

  const broken = fakeCodexChild();
  const brokenServer = codexApprovalServer(broken);
  await createCodexAppServerExecutor({
    spawnFn: () => broken,
    requestPermission: async () => { throw new Error('broker exploded'); },
  }).run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-b', job: { id: 'j' }, onData: () => {} });
  // A broker that throws must not leave the codex turn hung waiting on a
  // response that will never be written.
  assert.deepEqual(brokenServer.approvalResponse(), { id: 'approval-1', result: { decision: 'decline' } });
});
