// Project skills: SKILL.md files under <workspace>/.claude/skills/<dir>/ whose
// content is injected into agent episodes as mandatory repository guidance.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const VALID_ROLES = ['programmer', 'reviewer', 'qa', 'planner'];
// Roles that receive skills with no explicit `roles:` frontmatter (not planner).
const DEFAULT_ROLES = ['programmer', 'reviewer', 'qa'];

const SKILL_MAX = 5_000; // chars per skill body inside the block
const BLOCK_MAX = 15_000; // chars for the whole skills block

const HEADER =
  'PROJECT SKILLS — mandatory working guidance for this repository. Apply every skill below that is relevant to your current task; where they conflict with generic habits, the skills win.';

// Minimal YAML-ish frontmatter parser: a leading `---` line, simple single-line
// `key: value` pairs, then a closing `---` line. Anything else (including an
// unclosed `---`) is treated as having no frontmatter at all.
function parseSkillFile(raw, dirName) {
  let name = dirName;
  let description = '';
  let roles = null;
  let areas = null;
  let body = raw;
  const lines = raw.split('\n');
  if (/^---\s*$/.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
    if (close !== -1) {
      for (const line of lines.slice(1, close)) {
        const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!m) continue; // not a simple key: value pair — ignore
        const key = m[1].toLowerCase();
        let value = m[2].trim();
        if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1); // strip surrounding quotes
        if (key === 'name' && value) name = value;
        else if (key === 'description') description = value;
        else if (key === 'roles') {
          const list = value
            .replace(/^\[|\]$/g, '') // tolerate a YAML flow list
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => VALID_ROLES.includes(s));
          roles = list.length ? list : null;
        }
        else if (key === 'areas') {
          // Free-form lowercase tags (e.g. `areas: ui, mobile`) — no fixed list.
          const list = value
            .replace(/^\[|\]$/g, '') // tolerate a YAML flow list
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          areas = list.length ? list : null;
        }
      }
      body = lines.slice(close + 1).join('\n');
    }
  }
  return { name, description, roles, areas, body: body.trim() };
}

/**
 * Load all project skills from <workspace>/.claude/skills/<dir>/SKILL.md.
 * Returns [{ name, description, roles, areas, body, path }] sorted alphabetically
 * by name. Missing skills dir → []; unreadable entries are skipped silently.
 */
export async function loadProjectSkills(workspace) {
  const skills = [];
  try {
    const dir = path.join(workspace, '.claude', 'skills');
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const file = path.join(dir, entry, 'SKILL.md');
      let raw;
      try { raw = await fs.readFile(file, 'utf8'); } catch { continue; } // not a skill dir, or unreadable
      skills.push({ ...parseSkillFile(raw, entry), path: file });
    }
  } catch { /* no skills dir (or workspace unreadable) → [] */ }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the prompt block of skills applicable to `role` (and, optionally, `area`).
 * Skills without explicit roles apply to programmer/reviewer/qa; skills with
 * explicit roles apply only to those (the planner must be listed explicitly).
 * Area targeting: a skill is EXCLUDED only when the skill declares a non-empty
 * `areas` list AND `area` is a non-null string AND area.toLowerCase() is not in
 * that list. Skill without areas → always in; `area` null/omitted → everything
 * in (backward compatible with 2-arg calls).
 * Returns { text, names } where names are the skills actually included.
 * Never throws.
 */
export async function skillsBlock(workspace, role, area = null) {
  try {
    const r = String(role ?? '').trim().toLowerCase();
    const applicable = (await loadProjectSkills(workspace)).filter((s) => {
      const roleOk = s.roles ? s.roles.includes(r) : DEFAULT_ROLES.includes(r);
      if (!roleOk) return false;
      if (Array.isArray(s.areas) && s.areas.length && typeof area === 'string' && !s.areas.includes(area.toLowerCase())) return false;
      return true;
    });
    if (!applicable.length) return { text: '', names: [] };

    let text = HEADER;
    const names = [];
    for (let i = 0; i < applicable.length; i++) {
      const s = applicable[i];
      const body = s.body.length > SKILL_MAX ? s.body.slice(0, SKILL_MAX) + '\n[skill truncated]' : s.body;
      const section = `\n\n### Skill: ${s.name}\n${body}`;
      if (text.length + section.length > BLOCK_MAX) {
        const rest = applicable.slice(i).map((x) => x.name).join(', ');
        text += `\n\nAdditional project skills not included here: ${rest}`;
        break;
      }
      text += section;
      names.push(s.name);
    }
    return { text, names };
  } catch {
    return { text: '', names: [] };
  }
}
