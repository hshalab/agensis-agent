'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// STATUS.md open item — streaming was "unverified end-to-end". This proves the
// daemon half: createStreamJsonParser incrementally accumulates Claude's
// `--output-format stream-json --include-partial-messages` NDJSON into a live
// view and pulls the authoritative final answer from the `result` event.

let createStreamJsonParser;
test.before(async () => {
  ({ __test: { createStreamJsonParser } } = await import('../packages/agensis-cli/src/agensis.mjs'));
});

// A realistic stream-json line sequence: system init, partial text_deltas
// (token-by-token), a complete assistant message, then the final result event.
function lines(...objs) {
  return objs.map((o) => JSON.stringify(o) + '\n').join('');
}

test('accumulates token-level text_delta events into the live view', () => {
  const p = createStreamJsonParser();
  p.feed(lines(
    { type: 'system', subtype: 'init' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
  ));
  assert.equal(p.live, 'Hel');
  p.feed(lines(
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo, ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } },
  ));
  assert.equal(p.live, 'Hello, world');
});

test('handles bare delta shape (no event wrapper)', () => {
  const p = createStreamJsonParser();
  p.feed(lines(
    { delta: { type: 'text_delta', text: 'abc' } },
    { delta: { type: 'text_delta', text: 'def' } },
  ));
  assert.equal(p.live, 'abcdef');
});

test('splits NDJSON across arbitrary chunk boundaries', () => {
  const p = createStreamJsonParser();
  // Feed a single logical line in two writes — the parser must buffer until \n.
  const line = JSON.stringify({ delta: { type: 'text_delta', text: 'streamed' } }) + '\n';
  p.feed(line.slice(0, 10));
  assert.equal(p.live, ''); // nothing complete yet
  p.feed(line.slice(10));
  assert.equal(p.live, 'streamed');
});

test('result event is authoritative over accumulated deltas', () => {
  const p = createStreamJsonParser();
  p.feed(lines(
    { delta: { type: 'text_delta', text: 'partial draft' } },
    { type: 'result', subtype: 'success', result: 'Final polished answer.' },
  ));
  p.end();
  // Live reflects the streamed tokens; result prefers the authoritative event.
  assert.equal(p.result, 'Final polished answer.');
});

test('falls back to complete assistant message when no deltas arrive', () => {
  const p = createStreamJsonParser();
  p.feed(lines(
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Buffered reply' }] } },
  ));
  p.end();
  assert.equal(p.live, 'Buffered reply');
  assert.equal(p.result, 'Buffered reply');
});

test('ignores non-JSON noise on the stream', () => {
  const p = createStreamJsonParser();
  p.feed('not json at all\n');
  p.feed(JSON.stringify({ delta: { type: 'text_delta', text: 'ok' } }) + '\n');
  assert.equal(p.live, 'ok');
});

// Steps are progress metadata, not reply content. They must reach onStep and
// must never contribute to live/result — otherwise "Read src/App.tsx" would be
// spoken back to the human as part of the agent's answer.
test('raises an agensis_step line as a step without touching the reply text', () => {
  const steps = [];
  const p = createStreamJsonParser({ onStep: (s) => steps.push(s) });
  p.feed(lines(
    { delta: { type: 'text_delta', text: 'Looking' } },
    { type: 'agensis_step', step: { kind: 'tool', name: 'Read', detail: 'src/App.tsx' } },
    { delta: { type: 'text_delta', text: ' now' } },
    { type: 'result', subtype: 'success', result: 'Looking now' },
  ));
  p.end();
  assert.deepEqual(steps, [{ kind: 'tool', name: 'Read', detail: 'src/App.tsx' }]);
  assert.equal(p.live, 'Looking now');
  assert.equal(p.result, 'Looking now');
});

// The LocalExecutor path is raw `claude --output-format stream-json`, where tool
// calls arrive as tool_use blocks on assistant messages.
test('raises a step per tool_use block on a raw assistant message', () => {
  const steps = [];
  const p = createStreamJsonParser({ onStep: (s) => steps.push(s) });
  p.feed(lines({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 'tu_1', name: 'Grep', input: { pattern: 'TODO' } },
      ],
    },
  }));
  p.end();
  assert.deepEqual(steps, [{ kind: 'tool', name: 'Grep', detail: 'TODO' }]);
  assert.equal(p.result, 'On it.'); // the tool call did not become reply text
});

test('does not report the same tool_use id twice if the assistant message repeats', () => {
  const steps = [];
  const p = createStreamJsonParser({ onStep: (s) => steps.push(s) });
  const message = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } }] } };
  p.feed(lines(message, message));
  assert.equal(steps.length, 1);
});

// Both executors can feed this parser; a tool call must be reported ONCE.
test('ignores raw assistant tool_use once the pooled executor has sent agensis_step lines', () => {
  const steps = [];
  const p = createStreamJsonParser({ onStep: (s) => steps.push(s) });
  p.feed(lines(
    { type: 'agensis_step', step: { kind: 'tool', name: 'Read', detail: 'a.ts' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } }] } },
  ));
  assert.deepEqual(steps, [{ kind: 'tool', name: 'Read', detail: 'a.ts' }]);
});

test('parses normally when no onStep callback is supplied', () => {
  const p = createStreamJsonParser();
  p.feed(lines(
    { type: 'agensis_step', step: { kind: 'tool', name: 'Read', detail: 'a.ts' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: 'hi' }] } },
  ));
  p.end();
  assert.equal(p.result, 'hi');
});
