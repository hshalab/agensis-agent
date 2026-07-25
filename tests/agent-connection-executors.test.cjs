'use strict';

// connectionExecutors.mjs — the "fast connection" executors. Both take an
// injected transport (queryFn / spawnFn) so these tests exercise the real
// session-pooling, NDJSON re-encoding, and streaming/result logic without
// touching a real `claude` process, a real `codex` binary, or the network.
// The codex app-server wire shapes asserted here (NDJSON {id,method,params}
// requests, {method,params} notifications, thread/start + turn/start +
// item/agentMessage/delta + turn/completed) were captured live against the
// installed codex-cli 0.145.0 `codex app-server` subcommand, not guessed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () =>
  import(pathToFileURL(path.resolve(__dirname, '../packages/agensis-cli/src/connectionExecutors.mjs')).href);

// --- Codex app-server fakes -------------------------------------------------

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

// Replays the exact request/notification sequence captured from a live
// `codex app-server` run: initialize -> thread/start -> turn/start ack,
// then item/agentMessage/delta notifications, then turn/completed.
function scriptedCodexServer(child, {
  deltas = ['OK'],
  threadId = 'thread-1',
  turnId = 'turn-1',
  fail = false,
  approvalMethod = '',
} = {}) {
  let turnStarted = false;
  const seen = [];
  let approvalResponse = null;
  const emitTurn = () => {
    for (const delta of deltas) {
      child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item-1', delta } });
    }
    if (fail) {
      child.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message: 'boom' } } } });
    } else {
      child.send({
        method: 'item/completed',
        params: { threadId, turnId, item: { type: 'agentMessage', id: 'item-1', text: deltas.join('') } },
      });
      child.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    }
  };
  const originalWrite = child.stdin.write;
  child.stdin.write = (chunk) => {
    originalWrite(chunk);
    seen.push(chunk);
    const { id, method, params } = JSON.parse(chunk);
    if (id === 'approval-1' && !method) {
      approvalResponse = JSON.parse(chunk);
      queueMicrotask(emitTurn);
      return;
    }
    if (method === 'initialize') {
      queueMicrotask(() => child.send({ id, result: { codexHome: '/tmp' } }));
    } else if (method === 'thread/start') {
      queueMicrotask(() => child.send({ id, result: { thread: { id: threadId } } }));
    } else if (method === 'turn/start') {
      queueMicrotask(() => {
        child.send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
        turnStarted = true;
        child.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
        if (approvalMethod) {
          child.send({ id: 'approval-1', method: approvalMethod, params: { threadId, turnId, itemId: 'item-1' } });
        } else {
          emitTurn();
        }
      });
    } else if (method === 'turn/interrupt') {
      queueMicrotask(() => child.send({ id, result: {} }));
    }
  };
  return { seen, wasTurnStarted: () => turnStarted, approvalResponse: () => approvalResponse };
}

test('codex app-server executor: streams deltas and resolves stdout on turn/completed', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  scriptedCodexServer(child, { deltas: ['O', 'K'] });
  const spawnFn = () => child;
  const ex = createCodexAppServerExecutor({ spawnFn });

  const streamed = [];
  const result = await ex.run({
    cwd: '/tmp',
    prompt: 'say ok',
    sessionKey: 'silo-1',
    onData: (c) => streamed.push(c),
  });

  assert.deepEqual(streamed, ['O', 'K']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'OK');
  assert.equal(result.error, null);
  assert.deepEqual(
    child.writes.slice(0, 3).map((line) => JSON.parse(line).method),
    ['initialize', 'initialized', 'thread/start'],
  );
});

test('codex app-server executor: reuses one spawned process across jobs with the same sessionKey', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  scriptedCodexServer(child);
  let spawnCount = 0;
  const spawnFn = () => { spawnCount += 1; return child; };
  const ex = createCodexAppServerExecutor({ spawnFn });

  await ex.run({ cwd: '/tmp', prompt: 'first', sessionKey: 'silo-1', onData: () => {} });
  await ex.run({ cwd: '/tmp', prompt: 'second', sessionKey: 'silo-1', onData: () => {} });

  assert.equal(spawnCount, 1);
});

test('codex app-server executor: a different sessionKey gets its own process', async () => {
  const { createCodexAppServerExecutor } = await load();
  const spawned = [];
  const spawnFn = () => {
    const child = fakeCodexChild();
    scriptedCodexServer(child);
    spawned.push(child);
    return child;
  };
  const ex = createCodexAppServerExecutor({ spawnFn });

  await ex.run({ cwd: '/tmp', prompt: 'a', sessionKey: 'silo-a', onData: () => {} });
  await ex.run({ cwd: '/tmp', prompt: 'b', sessionKey: 'silo-b', onData: () => {} });

  assert.equal(spawned.length, 2);
});

test('codex app-server executor: turn/completed with a failed status surfaces as a result error', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  scriptedCodexServer(child, { fail: true });
  const ex = createCodexAppServerExecutor({ spawnFn: () => child });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, 1);
  assert.match(result.error.message, /boom/);
});

test('codex app-server executor: answers approval requests instead of leaving a remote job hung', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  const server = scriptedCodexServer(child, { approvalMethod: 'item/fileChange/requestApproval' });
  const ex = createCodexAppServerExecutor({ spawnFn: () => child });

  const result = await ex.run({
    cwd: '/tmp',
    prompt: 'edit it',
    permissionMode: 'accept_edits',
    sessionKey: 'silo-1',
    onData: () => {},
  });

  assert.equal(result.status, 0);
  assert.deepEqual(server.approvalResponse(), { id: 'approval-1', result: { decision: 'acceptForSession' } });
});

test('codex app-server executor: a spawn failure (binary missing) resolves an error instead of throwing', async () => {
  const { createCodexAppServerExecutor } = await load();
  const spawnFn = () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); };
  const ex = createCodexAppServerExecutor({ spawnFn });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, null);
  assert.match(result.error.message, /ENOENT/);
});

// --- Claude Agent SDK fakes -------------------------------------------------

function fakeClaudeQuery({ deltas = ['OK'], finalResult = 'OK', subtype = 'success' } = {}) {
  const pushed = [];
  let calls = 0;
  const queryFn = ({ prompt }) => {
    calls += 1;
    const gen = (async function* () {
      for await (const input of prompt) {
        pushed.push(input);
        const turn = pushed.length;
        const turnDeltas = typeof deltas === 'function' ? deltas(input, turn) : deltas;
        const turnResult = typeof finalResult === 'function' ? finalResult(input, turn) : finalResult;
        for (const text of turnDeltas) {
          yield { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
        }
        yield { type: 'result', subtype, result: subtype === 'success' ? turnResult : 'sdk error', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  return { queryFn, pushed, calls: () => calls };
}

test('claude sdk executor: re-encodes deltas as stream-json NDJSON and resolves the authoritative result', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn } = fakeClaudeQuery({ deltas: ['O', 'K'], finalResult: 'OK' });
  const ex = createClaudeSdkExecutor({ queryFn });

  const lines = [];
  const result = await ex.run({ cwd: '/tmp', prompt: 'say ok', sessionKey: 'silo-1', onData: (c) => lines.push(c) });

  const parsed = lines.map((l) => JSON.parse(l.trim()));
  assert.deepEqual(parsed.filter((m) => m.type === 'stream_event').map((m) => m.event.delta.text), ['O', 'K']);
  assert.deepEqual(parsed.find((m) => m.type === 'result'), { type: 'result', result: 'OK' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'OK');
});

test('claude sdk executor: one query() session is created and reused for multiple jobs on the same sessionKey', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn, pushed, calls } = fakeClaudeQuery({
    deltas: (_input, turn) => [`turn-${turn}`],
    finalResult: (_input, turn) => `result-${turn}`,
  });
  const ex = createClaudeSdkExecutor({ queryFn });

  const first = await ex.run({ cwd: '/tmp', prompt: 'first', sessionKey: 'silo-1', onData: () => {} });
  const second = await ex.run({ cwd: '/tmp', prompt: 'second', sessionKey: 'silo-1', onData: () => {} });

  assert.equal(calls(), 1);
  assert.deepEqual(pushed.map((message) => message.message.content), ['first', 'second']);
  assert.equal(first.stdout, 'result-1');
  assert.equal(second.stdout, 'result-2');
});

test('claude sdk executor: a non-success result subtype surfaces as a result error, not a throw', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn } = fakeClaudeQuery({ subtype: 'rate_limit' });
  const ex = createClaudeSdkExecutor({ queryFn });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, 1);
  assert.ok(result.error);
});

test('claude sdk executor: SDK initialization failure resolves an error instead of throwing', async () => {
  const { createClaudeSdkExecutor } = await load();
  const ex = createClaudeSdkExecutor({ queryFn: () => { throw new Error('SDK initialization failed'); } });
  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, null);
  assert.match(result.error.message, /SDK initialization failed/);
});

test('claude sdk executor: timeout closes the session so late output cannot leak into the next job', async () => {
  const { createClaudeSdkExecutor } = await load();
  let callCount = 0;
  const queryFn = ({ prompt }) => {
    callCount += 1;
    const gen = (async function* () {
      for await (const _input of prompt) await new Promise(() => {});
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });

  const timedOut = await ex.run({
    cwd: '/tmp',
    prompt: 'never finishes',
    sessionKey: 'silo-1',
    timeoutMs: 10,
    onData: () => {},
  });

  assert.equal(timedOut.status, null);
  assert.match(timedOut.error.message, /timed out/);
  assert.equal(callCount, 1);
});

// The workspace's own MCP tools must be auto-approved in EVERY permission mode.
//
// Regression this pins: @scout on a remote VM had the agensis MCP connected and
// its tool schemas loaded, yet every mcp__agensis__create_task call came back
// "you haven't granted it yet". The daemon passed no allowedTools, so in the
// default permission mode the SDK asked for approval — and a headless daemon has
// nobody to ask. It could not be fixed with a settings file either: lean mode
// (the default) passes settingSources: [], so settings.local.json is never read
// and grants written there are silently ignored.
test('claude sdk executor: auto-allows the agensis MCP tools in the default permission mode', async () => {
  const { createClaudeSdkExecutor } = await load();
  let seen = null;
  const { queryFn } = fakeClaudeQuery({});
  const wrapped = (args) => { seen = args.options; return queryFn(args); };
  const ex = createClaudeSdkExecutor({ queryFn: wrapped });
  await ex.run({ cwd: '/tmp', prompt: 'hi', permissionMode: 'default' });

  assert.ok(Array.isArray(seen.allowedTools), 'allowedTools must be passed to the SDK');
  assert.ok(
    seen.allowedTools.includes('mcp__agensis'),
    `expected the agensis MCP server to be auto-allowed, got ${JSON.stringify(seen.allowedTools)}`,
  );
  // It is an exemption, not a restriction — the SDK documents `tools` for that.
  // If this ever becomes the whole tool set, the agent loses Read/Write/Bash.
  assert.equal(seen.tools, undefined, 'must not restrict the available tool set');
  assert.equal(seen.permissionMode, 'default', 'permission mode itself is unchanged');
});

test('claude sdk executor: still auto-allows the agensis MCP tools under yolo', async () => {
  const { createClaudeSdkExecutor } = await load();
  let seen = null;
  const { queryFn } = fakeClaudeQuery({});
  const ex = createClaudeSdkExecutor({ queryFn: (args) => { seen = args.options; return queryFn(args); } });
  await ex.run({ cwd: '/tmp', prompt: 'hi', permissionMode: 'yolo' });
  assert.ok(seen.allowedTools.includes('mcp__agensis'));
  assert.equal(seen.permissionMode, 'bypassPermissions');
});

// Tool-only turns used to be invisible: the pump handled ONLY stream_event text
// deltas and result, so while the agent read files, grepped, ran bash or spawned
// subagents no text existed, no delta was sent, and the chat sat on "Thinking …"
// in silence. tool_use blocks live on assistant messages, which were ignored.
test('claude sdk executor: emits one agensis_step per tool_use block without duplicating reply text', async () => {
  const { createClaudeSdkExecutor } = await load();
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield {
          type: 'assistant',
          session_id: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me look.' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/App.tsx' } },
              { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'npm test\n--watch=false' } },
            ],
          },
        };
        yield { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } };
        yield { type: 'result', subtype: 'success', result: 'Done.', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });

  const lines = [];
  const result = await ex.run({ cwd: '/tmp', prompt: 'check it', sessionKey: 'silo-step', onData: (c) => lines.push(c) });
  const parsed = lines.map((l) => JSON.parse(l.trim()));

  assert.deepEqual(parsed.filter((m) => m.type === 'agensis_step').map((m) => m.step), [
    { kind: 'tool', name: 'Read', detail: 'src/App.tsx' },
    { kind: 'tool', name: 'Bash', detail: 'npm test --watch=false' },
  ]);
  // The assistant message's own text must NOT be re-emitted as a delta — it
  // already arrived via stream_event, and doubling it would double the reply.
  assert.deepEqual(parsed.filter((m) => m.type === 'stream_event').map((m) => m.event.delta.text), ['Done.']);
  assert.equal(result.stdout, 'Done.');
});

test('claude sdk executor: tool_use with no summarizable input still reports the tool name', async () => {
  const { createClaudeSdkExecutor } = await load();
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'TodoWrite' }] } };
        yield { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: 'not an array' } };
        yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });
  const lines = [];
  await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-step-2', onData: (c) => lines.push(c) });
  const steps = lines.map((l) => JSON.parse(l.trim())).filter((m) => m.type === 'agensis_step');
  assert.deepEqual(steps.map((m) => m.step), [{ kind: 'tool', name: 'TodoWrite', detail: '' }]);
});

test('summarizeToolInput: one short line from the first useful key, never the whole input', async () => {
  const { summarizeToolInput } = await load();
  assert.equal(summarizeToolInput({ file_path: 'a/b.ts', old_string: 'secret' }), 'a/b.ts');
  assert.equal(summarizeToolInput({ pattern: 'TODO', path: 'src' }), 'src'); // path outranks pattern
  assert.equal(summarizeToolInput({ prompt: 'line one\nline two' }), 'line one line two');
  assert.equal(summarizeToolInput({}), '');
  assert.equal(summarizeToolInput(undefined), '');
  assert.equal(summarizeToolInput({ command: 'x'.repeat(500) }).length, 121); // 120 chars + ellipsis
});
