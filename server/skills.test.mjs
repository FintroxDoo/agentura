// Tests for server/skills.js — run with: node --test server/skills.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectSkills, skillsBlock } from './skills.js';

const HEADER =
  'PROJECT SKILLS — mandatory working guidance for this repository. Apply every skill below that is relevant to your current task; where they conflict with generic habits, the skills win.';

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

// Temp workspace with .claude/skills/<dir>/SKILL.md fixtures.
// `skills` maps dir name → SKILL.md content (null → dir without a SKILL.md).
async function makeWorkspace(skills = null) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'agentura-skills-test-'));
  tmpDirs.push(ws);
  if (skills) {
    for (const [dir, content] of Object.entries(skills)) {
      const d = path.join(ws, '.claude', 'skills', dir);
      await fs.mkdir(d, { recursive: true });
      if (content !== null) await fs.writeFile(path.join(d, 'SKILL.md'), content, 'utf8');
    }
  }
  return ws;
}

const fm = (front, body) => `---\n${front}\n---\n${body}`;

test('no .claude/skills dir → [] and empty block', async () => {
  const ws = await makeWorkspace(null);
  assert.deepEqual(await loadProjectSkills(ws), []);
  assert.deepEqual(await skillsBlock(ws, 'programmer'), { text: '', names: [] });
});

test('parses frontmatter: name, description, roles; body keeps later --- lines', async () => {
  const ws = await makeWorkspace({
    alpha: fm('name: Alpha Skill\ndescription: Does alpha things\nroles: Programmer, QA', 'Alpha body.\n---\nmore body'),
  });
  const [s] = await loadProjectSkills(ws);
  assert.equal(s.name, 'Alpha Skill');
  assert.equal(s.description, 'Does alpha things');
  assert.deepEqual(s.roles, ['programmer', 'qa']);
  assert.equal(s.body, 'Alpha body.\n---\nmore body');
  assert.equal(s.path, path.join(ws, '.claude', 'skills', 'alpha', 'SKILL.md'));
});

test('missing name falls back to directory name', async () => {
  const ws = await makeWorkspace({ 'my-skill': fm('description: some skill', 'Body') });
  const [s] = await loadProjectSkills(ws);
  assert.equal(s.name, 'my-skill');
  assert.equal(s.description, 'some skill');
  assert.equal(s.roles, null);
});

test('file without frontmatter: whole file is the body, name = dir', async () => {
  const ws = await makeWorkspace({ raw: 'Just a body.\nSecond line.\n' });
  const [s] = await loadProjectSkills(ws);
  assert.equal(s.name, 'raw');
  assert.equal(s.description, '');
  assert.equal(s.roles, null);
  assert.equal(s.body, 'Just a body.\nSecond line.');
});

test('unclosed frontmatter is treated as plain body', async () => {
  const ws = await makeWorkspace({ u: '---\nname: never closed\nbody-ish' });
  const [s] = await loadProjectSkills(ws);
  assert.equal(s.name, 'u');
  assert.ok(s.body.startsWith('---'));
});

test('unknown role values are filtered out; empty result → null', async () => {
  const ws = await makeWorkspace({ a: fm('roles: designer, cook', 'Body') });
  const [s] = await loadProjectSkills(ws);
  assert.equal(s.roles, null);
});

test('null roles apply to programmer/reviewer/qa but not planner', async () => {
  const ws = await makeWorkspace({ a: 'Body only.' });
  for (const role of ['programmer', 'reviewer', 'qa']) {
    const { names } = await skillsBlock(ws, role);
    assert.deepEqual(names, ['a'], `role ${role} should get the skill`);
  }
  assert.deepEqual(await skillsBlock(ws, 'planner'), { text: '', names: [] });
});

test('explicit roles restrict: planner-only skill', async () => {
  const ws = await makeWorkspace({ p: fm('roles: planner', 'Plan body.') });
  const planner = await skillsBlock(ws, 'planner');
  assert.deepEqual(planner.names, ['p']);
  assert.ok(planner.text.includes('### Skill: p\nPlan body.'));
  assert.deepEqual(await skillsBlock(ws, 'programmer'), { text: '', names: [] });
});

test('skills sorted alphabetically by name; exact block format', async () => {
  const ws = await makeWorkspace({
    zdir: fm('name: alpha', 'A body'),
    adir: fm('name: zeta', 'Z body'),
    mdir: fm('name: mid', 'M body'),
  });
  const all = await loadProjectSkills(ws);
  assert.deepEqual(all.map((s) => s.name), ['alpha', 'mid', 'zeta']);
  const { text, names } = await skillsBlock(ws, 'reviewer');
  assert.deepEqual(names, ['alpha', 'mid', 'zeta']);
  assert.equal(
    text,
    `${HEADER}\n\n### Skill: alpha\nA body\n\n### Skill: mid\nM body\n\n### Skill: zeta\nZ body`,
  );
});

test('per-skill body truncated to 5000 chars with marker (loader keeps full body)', async () => {
  const ws = await makeWorkspace({ big: 'y'.repeat(6000) });
  const [s] = await loadProjectSkills(ws);
  assert.equal(s.body.length, 6000);
  const { text, names } = await skillsBlock(ws, 'programmer');
  assert.deepEqual(names, ['big']);
  assert.ok(text.includes('y'.repeat(5000) + '\n[skill truncated]'));
  assert.ok(!text.includes('y'.repeat(5001)));
});

test('block capped at 15000 chars with overflow listing', async () => {
  const body = 'x'.repeat(4600);
  const ws = await makeWorkspace({
    'skill-a': body,
    'skill-b': body,
    'skill-c': body,
    'skill-d': body,
  });
  const { text, names } = await skillsBlock(ws, 'qa');
  assert.deepEqual(names, ['skill-a', 'skill-b', 'skill-c']);
  assert.ok(!text.includes('### Skill: skill-d'));
  const marker = '\n\nAdditional project skills not included here: skill-d';
  assert.ok(text.endsWith(marker));
  assert.ok(text.length - marker.length <= 15_000);
});

test('skill dir without SKILL.md and stray files are skipped', async () => {
  const ws = await makeWorkspace({ good: 'Good body.', empty: null });
  await fs.writeFile(path.join(ws, '.claude', 'skills', 'stray.txt'), 'not a skill');
  const all = await loadProjectSkills(ws);
  assert.deepEqual(all.map((s) => s.name), ['good']);
});

test('skillsBlock never throws on bad input', async () => {
  assert.deepEqual(await skillsBlock(null, 'programmer'), { text: '', names: [] });
  assert.deepEqual(await skillsBlock('/nonexistent/nope-' + Date.now(), 'qa'), { text: '', names: [] });
  const ws = await makeWorkspace(null);
  const filePath = path.join(ws, 'plain.txt'); // workspace path that is a file
  await fs.writeFile(filePath, 'x', 'utf8');
  assert.deepEqual(await skillsBlock(filePath, 'reviewer'), { text: '', names: [] });
});
