// Unit tests for the Windows npm-shim resolution in claude-code.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCmdShim } from './claude-code.js';

const tmps = [];
async function makeShim({ withTarget = true, body = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-'));
  tmps.push(dir);
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (withTarget) {
    await fs.mkdir(path.dirname(cli), { recursive: true });
    await fs.writeFile(cli, '// cli');
  }
  const cmd = path.join(dir, 'claude.cmd');
  await fs.writeFile(cmd, body ?? [
    '@ECHO off', 'SETLOCAL',
    'SET "NODE_EXE=%~dp0\\node.exe"',
    // real npm shims reference the target with backslashes relative to %~dp0
    '"%NODE_EXE%" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n'));
  return { cmd, cli };
}

after(async () => { for (const d of tmps) await fs.rm(d, { recursive: true, force: true }); });

test('resolves a realistic npm .cmd shim to its cli.js', async () => {
  const { cmd, cli } = await makeShim();
  assert.equal(resolveCmdShim(cmd), cli);
});

test('returns null when the referenced cli.js does not exist', async () => {
  const { cmd } = await makeShim({ withTarget: false });
  assert.equal(resolveCmdShim(cmd), null);
});

test('returns null for a shim without a recognizable target', async () => {
  const { cmd } = await makeShim({ body: '@ECHO off\r\nECHO not a shim\r\n' });
  assert.equal(resolveCmdShim(cmd), null);
});

test('returns null for a missing file', () => {
  assert.equal(resolveCmdShim('/nonexistent/claude.cmd'), null);
});
