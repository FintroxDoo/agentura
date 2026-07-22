// Alternative engine: episodes run through the Claude Code CLI in headless
// mode (`claude -p`), so usage is billed to the user's claude.ai subscription
// (Pro/Max plan) instead of pay-per-token API credits.
//
// Uses --output-format stream-json so tool calls and interim text are
// surfaced live in the harness log, same as the raw-API engine.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from './i18n.js';

// A hard wall-clock kill murders perfectly healthy long episodes (deep mobile
// E2E with simulator + Maestro legitimately runs 30+ min). Instead: kill only
// after IDLE_MS without any CLI output (a genuinely stuck episode), with a
// generous absolute backstop.
const EPISODE_IDLE_MS = 10 * 60_000;      // no stream output for 10 min = stuck
const EPISODE_HARD_CAP_MS = 90 * 60_000;  // absolute safety net
const MAX_NUDGES = 2;

const ENGINE_NOTE =
  '\n\nRuntime note: you are running inside Claude Code. Use your standard tools ' +
  '(Read, Write, Edit, Bash, Glob, Grep). Wherever these instructions mention ' +
  'list_dir/read_file/write_file/run_command, use your equivalent tools instead. ' +
  'Work strictly inside the current working directory.';

// Launcher resolved once by checkClaudeCode(); episodes spawn
// [bin, ...pre, ...args]. Plain `spawn('claude')` breaks in two real setups:
// (1) GUI-launched Electron on macOS inherits a minimal PATH without
//     Homebrew / npm / nvm dirs, so an installed CLI is invisible;
// (2) on Windows an npm install is a `claude.cmd` shim that Node refuses to
//     spawn without a shell (CVE-2024-27980) — and a shell launch mangles
//     multiline prompt/system argv. So: search the common install locations,
//     resolve .cmd shims to their underlying cli.js and run that with our own
//     Node; a shell launch is the LAST resort, and then the prompt travels
//     via stdin and the system prompt is folded into it (see runCliStream).
let launcher = { bin: 'claude', pre: [], viaShell: false };

function candidateBins() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const cands = ['claude.exe', 'claude.cmd', 'claude']; // PATH lookups first
    if (process.env.APPDATA) {
      // npm global default prefix on Windows
      cands.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
      cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
    }
    cands.push(path.join(home, '.local', 'bin', 'claude.exe')); // native installer
    return cands;
  }
  const cands = ['claude']; // PATH first — respects the user's chosen install
  for (const dir of [
    path.join(home, '.local', 'bin'),          // native installer
    path.join(home, '.claude', 'local'),       // claude-managed install
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
  ]) cands.push(path.join(dir, 'claude'));
  // nvm: every installed node version has its own global bin
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvm)) cands.push(path.join(nvm, v, 'bin', 'claude'));
  } catch { /* no nvm */ }
  return cands;
}

// npm's claude.cmd shim wraps `node ...\node_modules\@anthropic-ai\claude-code\cli.js`
// — extract that path so episodes can skip both the shim and the shell.
export function resolveCmdShim(cmdPath) {
  try {
    const txt = fs.readFileSync(cmdPath, 'utf8');
    const m = txt.match(/node_modules[\\/][^"'\r\n]*?cli\.js/i);
    if (!m) return null;
    const target = path.join(path.dirname(cmdPath), ...m[0].split(/[\\/]/));
    fs.accessSync(target);
    return target;
  } catch { return null; }
}

function tryLauncher(l) {
  return new Promise((resolve) => {
    execFile(l.bin, [...l.pre, '--version'], { timeout: 10_000, shell: l.viaShell }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

export async function checkClaudeCode() {
  for (const bin of candidateBins()) {
    const isPath = bin.includes(path.sep);
    if (isPath) { try { fs.accessSync(bin); } catch { continue; } }
    const attempts = [];
    if (/cli\.js$/i.test(bin)) {
      attempts.push({ bin: process.execPath, pre: [bin], viaShell: false });
    } else if (/\.cmd$/i.test(bin)) {
      const cli = isPath ? resolveCmdShim(bin) : null;
      if (cli) attempts.push({ bin: process.execPath, pre: [cli], viaShell: false });
      attempts.push({ bin, pre: [], viaShell: true }); // last resort
    } else {
      attempts.push({ bin, pre: [], viaShell: false });
    }
    for (const l of attempts) {
      const v = await tryLauncher(l);
      if (v) { launcher = l; return v; }
    }
  }
  return null;
}

// Keep tool inputs mostly intact so the live "agent work" view can show the
// code being written / command being run. Only very long strings are capped
// (2k) — enough for a useful preview without flooding the SSE stream.
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + `\n…[+${v.length - 2000} chars]` : v;
  }
  return out;
}

// Spawn `claude -p` with stream-json output; forward tool calls and text to
// onEvent as they happen; resolve with the final `result` event.
function runCliStream(args, cwd, onEvent) {
  return new Promise((resolve, reject) => {
    // Strip API credentials so the CLI authenticates with the claude.ai
    // login (subscription) — NOT the metered API key from .env.
    // CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is passed through.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    // Shell launches (Windows .cmd last resort) must not carry huge multiline
    // values in argv — ship the prompt via stdin and fold the system prompt
    // into it. The node+cli.js and direct-binary paths pass args untouched.
    let spawnArgs = [...launcher.pre, ...args];
    let stdinPayload = null;
    if (launcher.viaShell) {
      const si = spawnArgs.indexOf('--append-system-prompt');
      let sys = '';
      if (si >= 0) { sys = spawnArgs[si + 1] || ''; spawnArgs.splice(si, 2); }
      const pi = spawnArgs.indexOf('-p');
      if (pi >= 0 && typeof spawnArgs[pi + 1] === 'string') {
        stdinPayload = (sys ? `[SYSTEM INSTRUCTIONS]\n${sys}\n\n---\n\n` : '') + spawnArgs[pi + 1];
        spawnArgs.splice(pi + 1, 1); // keep -p; the prompt arrives on stdin
      }
    }
    const child = spawn(launcher.bin, spawnArgs, { cwd, env, shell: launcher.viaShell });
    if (stdinPayload !== null) child.stdin.write(stdinPayload);
    child.stdin.end();
    let buf = '';
    let stderr = '';
    let result = null;
    const toolById = new Map(); // tool_use_id → tool name, to label tool_results

    let idleTimer;
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(t('Claude Code CLI: no output at all for {mins} min — episode stuck, terminated', { mins: EPISODE_IDLE_MS / 60000 })));
      }, EPISODE_IDLE_MS);
    };
    bumpIdle();
    const hardTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(t('Claude Code CLI: absolute episode limit exceeded ({mins} min)', { mins: EPISODE_HARD_CAP_MS / 60000 })));
    }, EPISODE_HARD_CAP_MS);
    const clearTimers = () => { clearTimeout(idleTimer); clearTimeout(hardTimer); };

    child.stdout.on('data', (d) => {
      bumpIdle();
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'assistant' && j.message?.content) {
          for (const b of j.message.content) {
            if (b.type === 'tool_use') {
              toolById.set(b.id, b.name);
              onEvent({ type: 'tool_call', tool: b.name, input: summarizeInput(b.input) });
            } else if (b.type === 'text' && b.text?.trim()) onEvent({ type: 'agent_text', text: b.text });
          }
        }
        // tool_result arrives on `user` messages after each tool runs — this is
        // where command/test output lives, so surface it for the live view.
        if (j.type === 'user' && j.message?.content) {
          for (const b of j.message.content) {
            if (b.type !== 'tool_result') continue;
            const out = Array.isArray(b.content)
              ? b.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
              : String(b.content || '');
            if (out.trim()) onEvent({ type: 'tool_result', tool: toolById.get(b.tool_use_id), output: out.slice(0, 2000), isError: !!b.is_error });
          }
        }
        if (j.type === 'result') result = j;
      }
    });
    child.stderr.on('data', (d) => { bumpIdle(); stderr += d; });
    child.on('error', (err) => { clearTimers(); reject(err); });
    child.on('close', (code) => {
      clearTimers();
      if (!result) reject(new Error(`Claude Code CLI (exit ${code}): ${stderr.slice(0, 300) || t('did not return a result')}`));
      else resolve(result);
    });
  });
}

/**
 * Same contract as runAgentEpisode (agent.js), driven by `claude -p`.
 * The empty-submission nudge resumes the same CLI session (--resume).
 * `resumeSessionId` continues a previously interrupted CLI session (limit,
 * server restart) so the agent keeps its conversation instead of starting over.
 */
export async function runClaudeCodeEpisode({ model, system, userMessage, workspace, onEvent = () => {}, requireChanges = false, hasChanges = null, resumeSessionId = null }) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costUsd: 0 };
  let sessionId = resumeSessionId || null;
  let text = '';
  let prompt = resumeSessionId
    ? 'You were interrupted mid-task (usage limit / restart). The conversation above is your own previous progress on this task — continue from where you stopped and finish it. Do not start over and do not re-explain; just complete the remaining work.'
    : userMessage;

  for (let attempt = 0; attempt <= MAX_NUDGES; attempt++) {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--append-system-prompt', system + ENGINE_NOTE,
    ];
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);

    // If resuming a stale session fails (e.g. wiped CLI state), fall back to
    // a fresh episode with the full prompt instead of failing the task.
    let j;
    try {
      j = await runCliStream(args, workspace, onEvent);
    } catch (err) {
      if (sessionId && sessionId === resumeSessionId) {
        onEvent({ type: 'agent_text', text: t('(resuming the interrupted session failed — starting a new episode from scratch)') });
        sessionId = null;
        prompt = userMessage;
        attempt -= 1;
        continue;
      }
      throw err;
    }
    if ((j.is_error || (j.subtype && j.subtype !== 'success')) && sessionId === resumeSessionId &&
        /no conversation|not found|unknown session|no session/i.test(String(j.result || ''))) {
      onEvent({ type: 'agent_text', text: t('(the interrupted session no longer exists — starting a new episode from scratch)') });
      sessionId = null;
      prompt = userMessage;
      attempt -= 1;
      continue;
    }
    sessionId = j.session_id || sessionId;
    text = j.result || text || '';
    const u = j.usage || {};
    usage.input += u.input_tokens || 0;
    usage.output += u.output_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0;
    usage.calls += j.num_turns || 1;
    usage.costUsd += j.total_cost_usd || 0;

    const resultText = String(j.result || '');
    // Classify limit/auth ONLY on real CLI failures. Matching the agent's own
    // text on successful episodes misfires badly: a task about API auth whose
    // summary says "endpoint returns 401" would be flagged as an auth failure.
    const failed = j.is_error || (j.subtype && j.subtype !== 'success');
    if (failed) {
      if (/rate.?limit|usage limit|session limit|hit your.*limit|limit (reached|will reset)|resets \d|out of extended usage/i.test(resultText)) {
        const err = new Error(t('Claude Code: plan limit reached — {msg}', { msg: resultText.slice(0, 200) }));
        err.rateLimited = true;
        err.cliSessionId = sessionId; // caller can --resume this exact conversation later
        throw err;
      }
      if (/401|invalid authentication|failed to authenticate|authentication_error|oauth token.*(expired|revoked)/i.test(resultText)) {
        throw new Error(
          t('Claude Code CLI cannot authenticate (401). Fix: run `claude setup-token` in your terminal, confirm in the browser, then put the resulting token into agent-harness/.env as CLAUDE_CODE_OAUTH_TOKEN=... and restart the server. (Alternative: run `claude` then /login to refresh the login.)')
        );
      }
      throw new Error(t('Claude Code episode failed ({subtype}): {msg}', { subtype: j.subtype || 'error', msg: resultText.slice(0, 300) }));
    }
    onEvent({ type: 'agent_text', text });

    const anyChanges = hasChanges ? await hasChanges() : true;
    if (requireChanges && !anyChanges && attempt < MAX_NUDGES && sessionId) {
      onEvent({ type: 'nudge', attempt: attempt + 1 });
      prompt =
        'You ended without modifying ANY file — the diff is empty, so there is nothing to review. ' +
        'Implement the task NOW (create or modify the actual files). Do not describe a plan; make the changes.';
      continue;
    }
    break;
  }

  return { text, changedFiles: [], iterations: usage.calls || 1, usage, sessionId };
}
