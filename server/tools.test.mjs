// Tests for server/tools.js — run with: node --test server/tools.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolExecutor } from './tools.js';

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function makeWorkspace(files) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'agentura-tools-test-'));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(ws, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, content, 'utf8');
  }
  return ws;
}

const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('read_file default returns the whole file unchanged', async () => {
  const ws = await makeWorkspace({ 'a.txt': tenLines });
  const { execute } = createToolExecutor(ws);
  assert.equal(await execute('read_file', { path: 'a.txt' }), tenLines);
});

test('read_file offset+limit returns the numbered range with a header', async () => {
  const ws = await makeWorkspace({ 'a.txt': tenLines });
  const { execute } = createToolExecutor(ws);
  const out = await execute('read_file', { path: 'a.txt', offset: 3, limit: 2 });
  assert.equal(out, '[lines 3-4 of 10]\n3\tline 3\n4\tline 4');
});

test('read_file offset without limit reads to end of file', async () => {
  const ws = await makeWorkspace({ 'a.txt': tenLines });
  const { execute } = createToolExecutor(ws);
  const out = await execute('read_file', { path: 'a.txt', offset: 9 });
  assert.equal(out, '[lines 9-10 of 10]\n9\tline 9\n10\tline 10');
});

test('read_file offset beyond EOF returns an error string, not a throw', async () => {
  const ws = await makeWorkspace({ 'a.txt': tenLines });
  const { execute } = createToolExecutor(ws);
  const out = await execute('read_file', { path: 'a.txt', offset: 99 });
  assert.match(out, /^ERROR: /);
  assert.match(out, /only 10 lines/);
});
