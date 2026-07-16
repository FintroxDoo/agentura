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
    description: 'Create or overwrite a text file relative to the workspace root. Creates parent directories automatically.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
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
          await fs.writeFile(f, input.content, 'utf8');
          changedFiles.add(path.relative(root, f));
          return `Wrote ${input.content.length} chars to ${input.path}`;
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
