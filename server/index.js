// Agent Harness server — zero-dependency Node.js (>=18).
// Serves the UI, a small REST API, and an SSE stream with live events.
import './env.js';
import './compat.js';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, RUNS_DIR, ACTIVE_DIR } from './orchestrator.js';
import { checkClaudeCode } from './claude-code.js';
import { sendEmail } from './mailer.js';

const claudeCodeVersion = checkClaudeCode(); // Promise<string|null>

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 4400);

const apiKey = () => (process.env.ANTHROPIC_API_KEY || '').trim();

const sseClients = new Set();
function broadcast(evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ---- Sessions: one Orchestrator per project tab, all can run in parallel.
const sessions = new Map(); // id -> { id, name, orch }
let sessionSeq = 0;
function createSession(name) {
  const id = 's' + (++sessionSeq);
  const orch = new Orchestrator((evt) => broadcast({ ...evt, sessionId: id }));
  const s = { id, name: (name || '').trim() || `Projekat ${sessionSeq}`, orch };
  sessions.set(id, s);
  return s;
}
createSession('Projekat 1');

function getOrch(url, body = {}) {
  const id = body.sessionId || url.searchParams.get('session') || 's1';
  const s = sessions.get(id);
  if (!s) { const e = new Error(`Nepoznata sesija: ${id}`); e.statusCode = 404; throw e; }
  return s.orch;
}

function sessionSummaries() {
  return [...sessions.values()].map((s) => ({
    id: s.id, name: s.name, phase: s.orch.phase, goal: s.orch.goal,
  }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 5_000_000) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---- Claude model list (cached 10 min)
let modelsCache = { at: 0, models: [] };
async function listModels() {
  if (Date.now() - modelsCache.at < 10 * 60_000 && modelsCache.models.length) return modelsCache.models;
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  modelsCache = {
    at: Date.now(),
    models: (data.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id })),
  };
  return modelsCache.models;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // ---- SSE stream
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const hello = {
        type: 'hello',
        sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, state: s.orch.state() })),
      };
      res.write(`data: ${JSON.stringify(hello)}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- Sessions (project tabs)
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, { sessions: sessionSummaries() });
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      const s = createSession(body.name);
      broadcast({ type: 'session_created', session: { id: s.id, name: s.name, state: s.orch.state() } });
      return json(res, 200, { ok: true, id: s.id, name: s.name });
    }
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = url.pathname.slice('/api/sessions/'.length);
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'Nepoznata sesija' });
      if (sessions.size === 1) return json(res, 400, { error: 'Poslednji tab ne može da se zatvori' });
      if (s.orch.phase === 'running' || s.orch.phase === 'planning') {
        return json(res, 400, { error: 'Projekat je aktivan — prvo ga zaustavi (■)' });
      }
      sessions.delete(id);
      broadcast({ type: 'session_closed', sessionId: id });
      return json(res, 200, { ok: true });
    }

    // ---- REST
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, getOrch(url).state());
    }

    // Available Claude models + engine availability
    if (url.pathname === '/api/models' && req.method === 'GET') {
      const claudeCode = await claudeCodeVersion;
      if (!apiKey()) return json(res, 200, { mock: true, models: [], claudeCode });
      try {
        return json(res, 200, { mock: false, models: await listModels(), claudeCode });
      } catch (err) {
        const invalid = /401|authentication/i.test(err.message);
        return json(res, 200, { mock: false, models: [], claudeCode, apiKeyInvalid: invalid, error: invalid ? null : err.message });
      }
    }

    // Directory browser for picking a workspace folder
    if (url.pathname === '/api/fs' && req.method === 'GET') {
      const raw = url.searchParams.get('path') || os.homedir();
      const dir = path.resolve(raw);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        return json(res, 400, { error: `Ne mogu da otvorim folder: ${err.message}` });
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      const parent = path.dirname(dir);
      return json(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs, sep: path.sep, home: os.homedir() });
    }

    // Step 1: team lead makes a task plan from the goal
    if (url.pathname === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req);
      const engine = body.engine === 'claude-code' ? 'claude-code' : 'api';
      // Claude Code accepts aliases (sonnet/opus/haiku) or empty = session default
      const DFLT_MODEL = engine === 'claude-code' ? '' : 'claude-sonnet-4-5';
      const models = body.models || {};
      const pick = (v) => String(v || DFLT_MODEL).trim();
      const cfg = {
        programmers: clampInt(body.programmers, 1, 10, 2),
        reviewers: clampInt(body.reviewers, 1, 5, 1),
        qa: clampInt(body.qa, 1, 5, 1),
        models: { programmer: pick(models.programmer), reviewer: pick(models.reviewer), qa: pick(models.qa) },
        engine,
        requireMergeApproval: !!body.requireMergeApproval,
        prMode: !!body.prMode,
        finalQa: body.finalQa !== false,
        apiKey: apiKey(),
        workspacePath: (body.workspacePath || '').trim(),
        gitUrl: (body.gitUrl || '').trim(),
        notifyEmail: (body.notifyEmail || '').trim(),
      };
      const goal = (body.goal || '').trim();
      if (!goal) return json(res, 400, { error: 'Opiši zadatak (cilj) za tim.' });

      const orch = getOrch(url, body);
      await orch.plan(cfg, goal);
      return json(res, 200, { ok: true, state: orch.state() });
    }

    // Solo mode: run a single agent (programmer / team lead / QA) directly,
    // with one instruction — no plan, no pipeline.
    if (url.pathname === '/api/quick' && req.method === 'POST') {
      const body = await readBody(req);
      const role = ['programmer', 'reviewer', 'qa'].includes(body.role) ? body.role : null;
      if (!role) return json(res, 400, { error: 'Uloga mora biti programmer, reviewer ili qa.' });
      const instruction = (body.instruction || '').trim();
      if (!instruction) return json(res, 400, { error: 'Opiši šta agent treba da uradi.' });
      const engine = body.engine === 'claude-code' ? 'claude-code' : 'api';
      const model = String(body.model || (engine === 'claude-code' ? '' : 'claude-sonnet-4-5')).trim();
      const cfg = {
        programmers: 1, reviewers: 1, qa: 1,
        models: { programmer: model, reviewer: model, qa: model },
        engine,
        requireMergeApproval: false, prMode: false, finalQa: false,
        apiKey: apiKey(),
        workspacePath: (body.workspacePath || '').trim(),
        gitUrl: (body.gitUrl || '').trim(),
        notifyEmail: (body.notifyEmail || '').trim(),
      };
      const orch = getOrch(url, body);
      await orch.quickRun(cfg, role, instruction);
      return json(res, 200, { ok: true, state: orch.state() });
    }

    // Step 1b: user objections → new plan
    if (url.pathname === '/api/replan' && req.method === 'POST') {
      const body = await readBody(req);
      const feedback = (body.feedback || '').trim();
      if (!feedback) return json(res, 400, { error: 'Upiši primedbe za novi plan.' });
      const orch = getOrch(url, body);
      orch.replan(feedback);
      return json(res, 200, { ok: true, state: orch.state() });
    }

    // Step 2: user approved the (possibly edited) plan → run
    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const body = await readBody(req);
      const tasks = (body.tasks || [])
        .map((t) => (typeof t === 'string' ? { title: t } : t))
        .filter((t) => t && t.title && String(t.title).trim());
      const orch = getOrch(url, body);
      await orch.approve(tasks);
      return json(res, 200, { ok: true, state: orch.state() });
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      getOrch(url, body).stop();
      return json(res, 200, { ok: true });
    }

    // Cut a rate-limit pause short ("▶ Nastavi odmah" button)
    if (url.pathname === '/api/resume-pause' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const orch = getOrch(url, body);
      try {
        orch.resumePause();
        return json(res, 200, { ok: true, state: orch.state() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // Interrupted runs (server died mid-run) available for resume
    if (url.pathname === '/api/resumable' && req.method === 'GET') {
      let files = [];
      try { files = await fs.readdir(ACTIVE_DIR); } catch { /* none */ }
      // Snapshots of runs that are live right now are not "resumable".
      const liveRunIds = new Set([...sessions.values()].map((s) => s.orch.runId).filter(Boolean));
      const runs = [];
      for (const f of files.filter((x) => x.endsWith('.json')).sort().reverse()) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(ACTIVE_DIR, f), 'utf8'));
          if (liveRunIds.has(j.runId)) continue;
          runs.push({
            id: j.runId, goal: j.goal, workspacePath: j.config?.workspacePath,
            savedAt: j.savedAt, startedAt: j.startedAt,
            done: (j.tasks || []).filter((t) => t.status === 'done').length,
            total: (j.tasks || []).length,
          });
        } catch { /* skip corrupt snapshot */ }
      }
      return json(res, 200, { runs });
    }

    // Resume an interrupted run into the given session tab
    if (url.pathname === '/api/resume-run' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!/^[\w.-]+$/.test(id)) return json(res, 400, { error: 'bad id' });
      let snap;
      try {
        snap = JSON.parse(await fs.readFile(path.join(ACTIVE_DIR, `${id}.json`), 'utf8'));
      } catch {
        return json(res, 404, { error: 'Snimak runa ne postoji (možda je već nastavljen ili obrisan)' });
      }
      const orch = getOrch(url, body);
      try {
        await orch.restore(snap, apiKey());
        return json(res, 200, { ok: true, state: orch.state() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // Discard an interrupted-run snapshot
    if (url.pathname.startsWith('/api/resumable/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/resumable/'.length));
      if (!/^[\w.-]+$/.test(id)) return json(res, 400, { error: 'bad id' });
      await fs.unlink(path.join(ACTIVE_DIR, `${id}.json`)).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // Retry a stuck task (optionally resumes a finished run)
    if (url.pathname === '/api/retry-task' && req.method === 'POST') {
      const body = await readBody(req);
      const orch = getOrch(url, body);
      try {
        orch.retryTask(Number(body.taskId));
        return json(res, 200, { ok: true, state: orch.state() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // Live user directive to the whole team or one task
    if (url.pathname === '/api/steer' && req.method === 'POST') {
      const body = await readBody(req);
      const orch = getOrch(url, body);
      try {
        orch.steer(body.taskId ? Number(body.taskId) : null, body.message);
        return json(res, 200, { ok: true, state: orch.state() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // User approves the merge of an awaiting_merge task
    if (url.pathname === '/api/approve-merge' && req.method === 'POST') {
      const body = await readBody(req);
      const orch = getOrch(url, body);
      try {
        await orch.approveMerge(Number(body.taskId));
        return json(res, 200, { ok: true, state: orch.state() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // Full diff of a task's worktree (for the UI diff viewer)
    if (url.pathname === '/api/task-diff' && req.method === 'GET') {
      const orch = getOrch(url);
      const task = orch.tasks.find((t) => t.id === Number(url.searchParams.get('taskId')));
      if (!task) return json(res, 404, { error: 'Task ne postoji' });
      const diff = await orch.diffFor(task, 120_000);
      return json(res, 200, { taskId: task.id, diff });
    }

    // Manual drag&drop assignment of a task to a programmer
    if (url.pathname === '/api/assign-task' && req.method === 'POST') {
      const body = await readBody(req);
      const orch = getOrch(url, body);
      try {
        orch.assignTask(Number(body.taskId), Number(body.agentId));
        return json(res, 200, { ok: true, state: orch.state() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // Run history (persisted to data/runs/*.json on every finished run)
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      let files = [];
      try { files = await fs.readdir(RUNS_DIR); } catch { /* no runs yet */ }
      const runs = [];
      for (const f of files.filter((x) => x.endsWith('.json')).sort().reverse().slice(0, 50)) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(RUNS_DIR, f), 'utf8'));
          runs.push({
            id: j.id, goal: j.goal, finishedAt: j.finishedAt, done: j.done, total: j.total,
            stuck: j.stuck, costUsd: j.usage?.costUsd ?? 0, workspacePath: j.workspacePath,
          });
        } catch { /* skip corrupt file */ }
      }
      return json(res, 200, { runs });
    }

    if (url.pathname.startsWith('/api/runs/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length));
      if (!/^[\w.-]+$/.test(id)) return json(res, 400, { error: 'bad id' });
      try {
        return json(res, 200, JSON.parse(await fs.readFile(path.join(RUNS_DIR, `${id}.json`), 'utf8')));
      } catch {
        return json(res, 404, { error: 'run not found' });
      }
    }

    // Open the workspace (index.html in browser if present, else the folder)
    if (url.pathname === '/api/open-workspace' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const ws = (body.path || getOrch(url, body).config?.workspacePath || '').trim();
      if (!ws) return json(res, 400, { error: 'Nema aktivnog workspace-a' });
      let target = ws;
      try { await fs.access(path.join(ws, 'index.html')); target = path.join(ws, 'index.html'); } catch { /* open folder */ }
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      execFile(opener, [target]);
      return json(res, 200, { ok: true, target });
    }

    if (url.pathname === '/api/test-email' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await sendEmail({
          to: body.to,
          subject: 'Agent Harness — test email',
          text: 'Resend konfiguracija radi. Ovde će stići notifikacija kad agenti završe taskove.',
        });
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // ---- static files
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(PUBLIC_DIR, path.normalize(filePath));
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
    try {
      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    return json(res, err.statusCode || 500, { error: err.message });
  }
});

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// SECURITY: agents run with --dangerously-skip-permissions, so anyone who can
// reach this port can execute arbitrary commands on this machine. Bind to
// localhost by default; set HOST=0.0.0.0 explicitly for LAN/VPN (Tailscale) use.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n  Agent Harness ▸ http://localhost:${PORT}  (bind: ${HOST})\n`);
  if (HOST !== '127.0.0.1') console.log('  ⚠ Server je dostupan van ove mašine — svako sa mreže može da izvršava komande!');
  console.log(apiKey() ? '  ANTHROPIC_API_KEY: postavljen ✓' : '  ANTHROPIC_API_KEY: nije postavljen → MOCK mod (dodaj ga u .env)');
  console.log('  Email: Resend' + (process.env.RESEND_API_KEY ? ' (env ključ) ✓' : ' (nedostaje RESEND_API_KEY u .env)'));
});
