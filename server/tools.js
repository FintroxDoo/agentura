// Workspace-scoped tools exposed to agents via Claude tool-use.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MAX_OUTPUT = 20_000; // chars returned to the model per tool call

export const TOOL_DEFS = [
  {
    name: 'list_dir',
    description: 'List files and directories at a path relative to the project workspace root. Returns names; directories end with "/".',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path, "." for root' } },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file relative to the workspace root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file relative to the workspace root. Creates parent directories automatically. Set append=true to append to the end instead of overwriting (useful for building large files in chunks).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean', description: 'Append to the file instead of overwriting (default false)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an EXACT text snippet inside an existing file — the efficient way to make partial changes without rewriting the whole file. old_string must match the file content exactly (including whitespace) and be unique, otherwise the call fails with an explanation. Set replace_all=true to replace every occurrence.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact existing text to replace (must be unique unless replace_all)' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern, recursively (skips node_modules/.git/dist/build). Use ** for any depth: "**/*.ts" = all TypeScript files anywhere, "src/**/*.test.js" = tests under src. Much faster than exploring with list_dir.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern relative to workspace root, e.g. "**/*.ts"' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file CONTENTS across the workspace (recursive, skips node_modules/.git/dist/build, max 25 matches per file). Returns path:line:text. Use this to locate code instead of reading files one by one. Pattern is an extended regex; if invalid it is retried as literal text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regex (or literal text) to search for' },
        path: { type: 'string', description: 'Subdirectory to search in (default: whole workspace)' },
        filePattern: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts" (optional)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default false)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command inside the workspace root (bash -c). 120s timeout. Returns stdout+stderr (truncated).',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

function resolveSafe(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  return p;
}

function truncate(s) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

// Directories never worth searching/globbing through.
const WALK_EXCLUDE = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.expo', 'coverage']);

// Recursive file listing with exclusions and a hard cap (runaway guard).
async function walkFiles(root, cap = 20_000) {
  const out = [];
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > cap) { out.push('...[walk cap reached]'); return out; }
      if (e.name === '.DS_Store') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (WALK_EXCLUDE.has(e.name) || e.name.startsWith('.hwt-')) continue;
        stack.push(full);
      } else {
        out.push(path.relative(root, full));
      }
    }
  }
  return out;
}

// Glob → regex. Supports: ** (any depth), * (within one segment), ? (one char).
// "**/*.ts" also matches root-level .ts files (the "**/" prefix is optional).
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

// grep(1) via execFile (argument array — no shell, no injection). Exit 1 = no
// matches; exit 2 (e.g. invalid regex) retries the pattern as literal text.
function runGrep(cwd, { pattern, filePattern, ignoreCase }, literal = false) {
  return new Promise((resolve) => {
    const args = ['-rn', '-I', '-m', '25', literal ? '-F' : '-E'];
    if (ignoreCase) args.push('-i');
    for (const d of WALK_EXCLUDE) args.push(`--exclude-dir=${d}`);
    args.push('--exclude-dir=.hwt-*');
    if (filePattern) args.push(`--include=${filePattern}`);
    args.push('-e', pattern, '.');
    execFile('grep', args, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ ok: true, out: stdout });
      if (err.code === 1) return resolve({ ok: true, out: '(no matches)' });
      if (!literal) return resolve(runGrep(cwd, { pattern, filePattern, ignoreCase }, true));
      resolve({ ok: false, out: `grep failed: ${String(err.message).slice(0, 200)}` });
    });
  });
}

/**
 * Create a tool executor bound to a workspace root.
 * Tracks files written so the orchestrator can build a review diff.
 */
export function createToolExecutor(root) {
  const changedFiles = new Set();

  async function execute(name, input) {
    try {
      switch (name) {
        case 'list_dir': {
          const dir = resolveSafe(root, input.path || '.');
          const entries = await fs.readdir(dir, { withFileTypes: true });
          return entries
            .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
            .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
            .join('\n') || '(empty)';
        }
        case 'read_file': {
          const f = resolveSafe(root, input.path);
          const data = await fs.readFile(f, 'utf8');
          return truncate(data);
        }
        case 'write_file': {
          const f = resolveSafe(root, input.path);
          await fs.mkdir(path.dirname(f), { recursive: true });
          if (input.append) await fs.appendFile(f, input.content, 'utf8');
          else await fs.writeFile(f, input.content, 'utf8');
          changedFiles.add(path.relative(root, f));
          return `${input.append ? 'Appended' : 'Wrote'} ${input.content.length} chars to ${input.path}`;
        }
        case 'edit_file': {
          const f = resolveSafe(root, input.path);
          let data;
          try { data = await fs.readFile(f, 'utf8'); }
          catch { return `ERROR: file not found: ${input.path} (use write_file to create new files)`; }
          const oldS = input.old_string;
          const newS = input.new_string ?? '';
          if (!oldS) return 'ERROR: old_string must be a non-empty exact snippet from the file';
          const count = data.split(oldS).length - 1;
          if (count === 0) return `ERROR: old_string not found in ${input.path} — re-read the file and copy the EXACT text (including whitespace/indentation)`;
          if (count > 1 && !input.replace_all) return `ERROR: old_string occurs ${count}× in ${input.path} — provide a longer unique snippet, or set replace_all=true`;
          // function replacer: a literal "$" in new_string must stay literal
          const next = input.replace_all ? data.split(oldS).join(newS) : data.replace(oldS, () => newS);
          await fs.writeFile(f, next, 'utf8');
          changedFiles.add(path.relative(root, f));
          return `Edited ${input.path}: replaced ${input.replace_all ? count : 1} occurrence(s) of the snippet`;
        }
        case 'glob': {
          if (!input.pattern) return 'ERROR: pattern is required';
          // patterns are workspace-relative; strip an accidental leading ./ or /
          const pat = String(input.pattern).replace(/^\.?\//, '');
          const rx = globToRegex(pat);
          const all = await walkFiles(root);
          const hits = all.filter((p) => rx.test(p.split(path.sep).join('/')));
          if (!hits.length) return `(no files match ${pat})`;
          return truncate(hits.sort().slice(0, 500).join('\n') + (hits.length > 500 ? `\n...[+${hits.length - 500} more]` : ''));
        }
        case 'grep': {
          if (!input.pattern) return 'ERROR: pattern is required';
          const target = resolveSafe(root, input.path || '.');
          const r = await runGrep(target, {
            pattern: String(input.pattern),
            filePattern: input.filePattern ? String(input.filePattern) : null,
            ignoreCase: !!input.ignoreCase,
          });
          if (!r.ok) return `ERROR: ${r.out}`;
          // prefix subdir so returned paths stay workspace-relative
          const prefix = input.path && input.path !== '.' ? String(input.path).replace(/\/+$/, '') + '/' : '';
          const out = prefix
            ? r.out.split('\n').map((l) => (l.startsWith('./') ? prefix + l.slice(2) : l)).join('\n')
            : r.out.replace(/^\.\//gm, '');
          return truncate(out);
        }
        case 'run_command': {
          const out = await runCommand(root, input.command);
          return truncate(out);
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  }

  return { execute, changedFiles };
}

export function runCommand(cwd, command, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n--- stderr ---\n' : '') + stderr;
      if (err && err.killed) out += '\n[command timed out]';
      else if (err && err.code) out += `\n[exit code ${err.code}]`;
      resolve(out || '(no output)');
    });
  });
}
