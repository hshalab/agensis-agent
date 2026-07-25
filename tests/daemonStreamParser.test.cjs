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

// A turn is [text][tool][text][tool][text], but every one of those texts used to
// be concatenated into ONE growing placeholder message: five separate thoughts
// ran together in a single bubble with no boundary for the human to read or
// interrupt at. A segment closes each text block so the transcript becomes one
// message per block with the tool chips in between.
test('a multi-block turn raises one segment per text block, in order, without duplicating the reply', () => {
  const segments = [];
  const steps = [];
  const p = createStreamJsonParser({ onStep: (s) => steps.push(s), onSegment: (s) => segments.push(s) });
  p.feed(lines(
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Only used here.' } } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Only used here.' },
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: 'ChatWindowContent.tsx' } },
        ],
      },
    },
  ));
  assert.deepEqual(segments.map((s) => s.text), ['Only used here.']);
  // The closed block must not replay into the message the server just opened.
  assert.equal(p.live, '');

  p.feed(lines(
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Now the dialog.' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Now the dialog.' }] } },
  ));
  p.end();

  assert.deepEqual(segments.map((s) => s.text), ['Only used here.', 'Now the dialog.']);
  assert.deepEqual(steps, [{ kind: 'tool', name: 'Edit', detail: 'ChatWindowContent.tsx' }]);
  // Each block counted ONCE: the segment carries its own text and never feeds
  // the accumulators the deltas already filled.
  assert.equal(p.result, 'Only used here.Now the dialog.');
});

// The model wrote the text before it called the tools that text announced.
test('the segment for a block is raised before the steps from the same assistant message', () => {
  const seen = [];
  const p = createStreamJsonParser({
    onStep: (s) => seen.push(`step:${s.name}`),
    onSegment: (s) => seen.push(`segment:${s.text}`),
  });
  p.feed(lines({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 'tu_2', name: 'Grep', input: { pattern: 'TODO' } },
      ],
    },
  }));
  assert.deepEqual(seen, ['segment:Let me look.', 'step:Read', 'step:Grep']);
});

// The pooled SDK executor has no raw assistant messages to forward, so it sends
// the boundary as its own line.
test('raises an agensis_segment line as a boundary that restarts the live view', () => {
  const segments = [];
  const p = createStreamJsonParser({ onSegment: (s) => segments.push(s) });
  p.feed(lines(
    { delta: { type: 'text_delta', text: 'First block.' } },
    { type: 'agensis_segment', segment: { text: 'First block.' } },
    { delta: { type: 'text_delta', text: 'Second block.' } },
  ));
  p.end();
  assert.deepEqual(segments, [{ text: 'First block.' }]);
  assert.equal(p.live, 'Second block.');
  assert.equal(p.result, 'First block.Second block.');
});

// Both executors can feed this parser; a block must be closed ONCE.
test('ignores raw assistant text once the pooled executor has sent agensis_segment lines', () => {
  const segments = [];
  const p = createStreamJsonParser({ onSegment: (s) => segments.push(s) });
  p.feed(lines(
    { type: 'agensis_segment', segment: { text: 'Only once.' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Only once.' }] } },
  ));
  p.end();
  assert.deepEqual(segments.map((s) => s.text), ['Only once.']);
  assert.equal(p.result, 'Only once.');
});

// A turn that produced text but no `result` event still has to resolve to the
// whole turn, not just the block that was open when it ended.
test('the result fallback spans every block when no result event arrives', () => {
  const p = createStreamJsonParser({ onSegment: () => {} });
  p.feed(lines(
    { delta: { type: 'text_delta', text: 'One.' } },
    { type: 'agensis_segment', segment: { text: 'One.' } },
    { delta: { type: 'text_delta', text: 'Two.' } },
    { type: 'agensis_segment', segment: { text: 'Two.' } },
    { delta: { type: 'text_delta', text: 'Three.' } },
  ));
  p.end();
  assert.equal(p.result, 'One.Two.Three.');
});

// A caller that cannot deliver boundaries keeps exactly the behaviour it had
// before segments existed — one growing message.
test('without an onSegment listener the live view stays one growing block', () => {
  const p = createStreamJsonParser();
  p.feed(lines(
    { delta: { type: 'text_delta', text: 'A.' } },
    { type: 'agensis_segment', segment: { text: 'A.' } },
    { delta: { type: 'text_delta', text: 'B.' } },
  ));
  p.end();
  assert.equal(p.live, 'A.B.');
  assert.equal(p.result, 'A.B.');
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
