// Tests for server/agent.js pruneHistory — run with: node --test server/agent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneHistory } from './agent.js';

const big = (n) => 'x'.repeat(n);

// One tool round: assistant tool_use + user tool_result of `size` chars.
const toolTurn = (i, size) => [
  { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${i}`, name: 'read_file', input: { path: 'a.txt' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: big(size) }] },
];

function history(turns, size = 1000) {
  const msgs = [{ role: 'user', content: 'do the task' }];
  for (let i = 0; i < turns; i++) msgs.push(...toolTurn(i, size));
  return msgs;
}

test('keeps the last keepLast tool_result messages intact, prunes older ones', () => {
  const out = pruneHistory(history(12, 1000), { keepLast: 10, minSize: 500 });
  const toolMsgs = out.filter((m) => m.role === 'user' && Array.isArray(m.content));
  assert.equal(toolMsgs.length, 12);
  for (const m of toolMsgs.slice(0, 2)) assert.match(m.content[0].content, /^\[pruned earlier tool output/);
  for (const m of toolMsgs.slice(-10)) assert.equal(m.content[0].content, big(1000));
});

test('blocks at or below minSize stay untouched even in prunable messages', () => {
  const msgs = history(12, 100);
  assert.deepEqual(pruneHistory(msgs, { keepLast: 2, minSize: 500 }), msgs);
});

test('prunes only oversized tool_result blocks; other block types untouched', () => {
  const msgs = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'grep', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'short' },
        { type: 'tool_result', tool_use_id: 'b', content: big(600) },
        { type: 'text', text: 'note' },
      ],
    },
    ...toolTurn(99, 50),
  ];
  const out = pruneHistory(msgs, { keepLast: 1, minSize: 500 });
  assert.equal(out[2].content[0].content, 'short');
  assert.equal(out[2].content[1].content, '[pruned earlier tool output (600 chars) — call the tool again if you need it]');
  assert.deepEqual(out[2].content[2], { type: 'text', text: 'note' });
});

test('assistant messages, tool_use blocks, and plain user messages are preserved', () => {
  const msgs = history(12, 1000);
  const out = pruneHistory(msgs, { keepLast: 1 });
  assert.equal(out.length, msgs.length);
  assert.deepEqual(out[0], msgs[0]); // plain user message
  msgs.forEach((m, i) => {
    if (m.role === 'assistant') assert.deepEqual(out[i], m);
  });
});

test('does not mutate the input array or its objects', () => {
  const msgs = history(12, 1000);
  const snapshot = structuredClone(msgs);
  pruneHistory(msgs, { keepLast: 1 });
  assert.deepEqual(msgs, snapshot);
});

test('replacement text carries the original char count', () => {
  const out = pruneHistory(history(3, 1234), { keepLast: 1, minSize: 500 });
  assert.equal(out[2].content[0].content, '[pruned earlier tool output (1234 chars) — call the tool again if you need it]');
});
