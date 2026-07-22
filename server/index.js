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
import { t, getLang, setLang } from './i18n.js';

const claudeCodeVersion = checkClaudeCode(); // Promise<string|null>

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESS_FILE = path.join(process.env.HARNESS_DATA_DIR || path.join(__dirname, '..', 'data'), 'sessions.json');
const PORT = Number(process.env.PORT || 4400);

const apiKey = () => (process.env.ANTHROPIC_API_KEY || '').trim();
const kimiKey = () => (process.env.KIMI_API_KEY || '').trim();

// Kimi For Coding: Anthropic-compatible endpoint, billed to the Kimi subscription.
const KIMI_MODELS_FALLBACK = [
  { id: 'kimi-for-coding', name: 'Kimi K2.7 Coding' },
  { id: 'kimi-for-coding-highspeed', name: 'Kimi K2.7 Highspeed' },
];

const sseClients = new Set();
function broadcast(evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ---- Sessions: one Orchestrator per project tab, all can run in parallel.
// Every session is permanently BOUND to a project directory (workspacePath) —
// picked once via the file browser; persisted so tabs survive server restarts.
const sessions = new Map(); // id -> { id, name, workspacePath, orch }
let sessionSeq = 0;

function addSession(id, name, workspacePath = '') {
  const orch = new Orchestrator((evt) => broadcast({ ...evt, sessionId: id }));
  const s = {
    id,
    name: (name || '').trim() || (workspacePath ? path.basename(workspacePath) : t('Project {n}', { n: id.slice(1) })),
    workspacePath: workspacePath || '',
    orch,
  };
  sessions.set(id, s);
  return s;
}
function createSession(name, workspacePath = '') {
  const s = addSession('s' + (++sessionSeq), name, workspacePath);
  saveSessions();
  return s;
}
async function saveSessions() {
  try {
    await fs.mkdir(path.dirname(SESS_FILE), { recursive: true });
    await fs.writeFile(SESS_FILE, JSON.stringify(
      [...sessions.values()].map(({ id, name, workspacePath }) => ({ id, name, workspacePath })), null, 1));
  } catch { /* non-fatal */ }
}
// Restore tabs + directory bindings from the last server run.
try {
  const stored = JSON.parse(await fs.readFile(SESS_FILE, 'utf8'));
  for (const s of stored) {
    if (!/^s\d+$/.test(s.id)) continue;
    sessionSeq = Math.max(sessionSeq, Number(s.id.slice(1)));
    addSession(s.id, s.name, s.workspacePath);
  }
} catch { /* first boot */ }
if (!sessions.size) createSession(t('Project {n}', { n: 1 }));

function getSession(url, body = {}) {
  const id = body.sessionId || url.searchParams.get('session') || 's1';
  const s = sessions.get(id);
  if (!s) { const e = new Error(t('Unknown session: {id}', { id })); e.statusCode = 404; throw e; }
  return s;
}
function getOrch(url, body = {}) {
  return getSession(url, body).orch;
}

function sessionSummaries() {
  return [...sessions.values()].map((s) => ({
    id: s.id, name: s.name, phase: s.orch.phase, goal: s.orch.goal, workspacePath: s.workspacePath,
  }));
}

// Bind a session to its project directory (once) and tell all UIs.
async function bindSessionWorkspace(s, ws, { rename = true } = {}) {
  s.workspacePath = ws;
  if (rename && /^(?:Projekat|Project) \d+$/.test(s.name)) s.name = path.basename(ws);
  await saveSessions();
  broadcast({ type: 'session_updated', session: { id: s.id, name: s.name, workspacePath: s.workspacePath } });
}

// Resolve a path inside the session workspace; rejects traversal outside it.
function insideWorkspace(s, rel) {
  const root = path.resolve(s.workspacePath || s.orch.config?.workspacePath || '');
  if (!root || root === path.resolve('/')) return null;
  const p = path.resolve(root, rel || '.');
  return p === root || p.startsWith(root + path.sep) ? { root, p } : null;
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

// ---- Kimi model list (cached 10 min; fallback to known ids)
let kimiCache = { at: 0, models: [] };
async function listKimiModels() {
  if (!kimiKey()) return KIMI_MODELS_FALLBACK;
  if (Date.now() - kimiCache.at < 10 * 60_000 && kimiCache.models.length) return kimiCache.models;
  try {
    const res = await fetch('https://api.kimi.com/coding/v1/models', {
      headers: { authorization: `Bearer ${kimiKey()}` },
    });
    if (!res.ok) return KIMI_MODELS_FALLBACK;
    const data = await res.json();
    const models = (data.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
    if (models.length) kimiCache = { at: Date.now(), models };
    return models.length ? models : KIMI_MODELS_FALLBACK;
  } catch { return KIMI_MODELS_FALLBACK; }
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
        lang: getLang(),
        sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, workspacePath: s.workspacePath, state: s.orch.state() })),
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
      let ws = (body.workspacePath || '').trim();
      if (ws) {
        ws = path.resolve(ws);
        if (body.createDir) await fs.mkdir(ws, { recursive: true });
        try {
          const st = await fs.stat(ws);
          if (!st.isDirectory()) return json(res, 400, { error: t('Path is not a directory') });
        } catch { return json(res, 400, { error: t('Directory does not exist: {ws}', { ws }) }); }
      }
      const s = createSession(body.name, ws);
      broadcast({ type: 'session_created', session: { id: s.id, name: s.name, workspacePath: s.workspacePath, state: s.orch.state() } });
      return json(res, 200, { ok: true, id: s.id, name: s.name, workspacePath: s.workspacePath });
    }
    // Bind (or re-bind) an existing session to a project directory
    if (/^\/api\/sessions\/[^/]+\/workspace$/.test(url.pathname) && req.method === 'POST') {
      const id = url.pathname.split('/')[3];
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: t('Unknown session') });
      if (s.orch.phase === 'running' || s.orch.phase === 'planning') {
        return json(res, 400, { error: t('Session is active — the directory cannot be changed mid-run') });
      }
      const body = await readBody(req);
      let ws = (body.workspacePath || '').trim();
      if (!ws) return json(res, 400, { error: t('Missing workspacePath') });
      ws = path.resolve(ws);
      if (body.createDir) await fs.mkdir(ws, { recursive: true });
      try {
        const st = await fs.stat(ws);
        if (!st.isDirectory()) return json(res, 400, { error: t('Path is not a directory') });
      } catch { return json(res, 400, { error: t('Directory does not exist: {ws}', { ws }) }); }
      await bindSessionWorkspace(s, ws);
      return json(res, 200, { ok: true, workspacePath: s.workspacePath, name: s.name });
    }
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = url.pathname.slice('/api/sessions/'.length);
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: t('Unknown session') });
      if (sessions.size === 1) return json(res, 400, { error: t('The last tab cannot be closed') });
      if (s.orch.phase === 'running' || s.orch.phase === 'planning') {
        return json(res, 400, { error: t('Project is active — stop it first (■)') });
      }
      sessions.delete(id);
      await saveSessions();
      broadcast({ type: 'session_closed', sessionId: id });
      return json(res, 200, { ok: true });
    }

    // ---- File tree of the session's bound project (left panel in the UI)
    if (url.pathname === '/api/tree' && req.method === 'GET') {
      const s = getSession(url);
      const loc = insideWorkspace(s, url.searchParams.get('path') || '.');
      if (!loc) return json(res, 400, { error: t('Session has no bound directory (or the path is outside it)') });
      let entries;
      try { entries = await fs.readdir(loc.p, { withFileTypes: true }); }
      catch (err) { return json(res, 400, { error: t('Cannot open: {msg}', { msg: err.message }) }); }
      const HIDE = new Set(['node_modules', '.git', '.DS_Store']);
      const dirs = [], files = [];
      for (const e of entries) {
        if (HIDE.has(e.name) || e.name.startsWith('.hwt-')) continue;
        if (e.isDirectory()) dirs.push(e.name);
        else files.push(e.name);
      }
      dirs.sort((a, b) => a.localeCompare(b));
      files.sort((a, b) => a.localeCompare(b));
      return json(res, 200, { root: loc.root, rel: path.relative(loc.root, loc.p) || '.', dirs, files });
    }

    // ---- Read-only file preview (capped), only inside the session workspace
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const s = getSession(url);
      const loc = insideWorkspace(s, url.searchParams.get('path') || '');
      if (!loc) return json(res, 400, { error: t('Path is outside the session workspace') });
      try {
        const st = await fs.stat(loc.p);
        if (st.size > 300_000) return json(res, 200, { path: loc.p, tooBig: true, size: st.size });
        const buf = await fs.readFile(loc.p);
        if (buf.subarray(0, 8000).includes(0)) return json(res, 200, { path: loc.p, binary: true, size: st.size });
        return json(res, 200, { path: loc.p, size: st.size, content: buf.toString('utf8') });
      } catch (err) { return json(res, 400, { error: err.message }); }
    }

    // ---- REST
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, getOrch(url).state());
    }

    // Available Claude models + engine availability (+ Kimi)
    if (url.pathname === '/api/models' && req.method === 'GET') {
      const claudeCode = await claudeCodeVersion;
      const kimi = { available: !!kimiKey(), models: await listKimiModels() };
      if (!apiKey()) return json(res, 200, { mock: true, models: [], claudeCode, kimi });
      try {
        return json(res, 200, { mock: false, models: await listModels(), claudeCode, kimi });
      } catch (err) {
        const invalid = /401|authentication/i.test(err.message);
        return json(res, 200, { mock: false, models: [], claudeCode, kimi, apiKeyInvalid: invalid, error: invalid ? null : err.message });
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
        return json(res, 400, { error: t('Cannot open directory: {msg}', { msg: err.message }) });
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
      const ENG = (v) => (['claude-code', 'kimi', 'api'].includes(v) ? v : null);
      const engine = ENG(body.engine) || 'api';
      // Per-role engine mix (e.g. Claude team lead + Kimi programmers)
      const engines = {
        programmer: ENG(body.engines?.programmer) || engine,
        reviewer: ENG(body.engines?.reviewer) || engine,
        qa: ENG(body.engines?.qa) || engine,
      };
      if (Object.values(engines).includes('kimi') && !kimiKey()) return json(res, 400, { error: t('KIMI_API_KEY is not set in .env') });
      // Claude Code accepts aliases (sonnet/opus/haiku) or empty = session default
      const DFLT = { 'claude-code': '', kimi: 'kimi-for-coding-highspeed', api: 'claude-sonnet-4-5' };
      const models = body.models || {};
      const pick = (v, role) => String(v || DFLT[engines[role]]).trim();
      const sess = getSession(url, body);
      const cfg = {
        programmers: clampInt(body.programmers, 1, 10, 2),
        reviewers: clampInt(body.reviewers, 1, 5, 1),
        qa: clampInt(body.qa, 1, 5, 1),
        models: { programmer: pick(models.programmer, 'programmer'), reviewer: pick(models.reviewer, 'reviewer'), qa: pick(models.qa, 'qa') },
        engine,
        engines,
        requireMergeApproval: !!body.requireMergeApproval,
        prMode: !!body.prMode,
        finalQa: body.finalQa !== false,
        branch: String(body.branch || '').trim(),
        baseBranch: String(body.baseBranch || '').trim(),
        apiKey: apiKey(),
        kimiKey: kimiKey(),
        // A bound session ALWAYS uses its own directory — no re-picking per run.
        workspacePath: sess.workspacePath || (body.workspacePath || '').trim(),
        gitUrl: sess.workspacePath ? '' : (body.gitUrl || '').trim(),
        notifyEmail: (body.notifyEmail || '').trim(),
      };
      const goal = (body.goal || '').trim();
      if (!goal) return json(res, 400, { error: t('Describe the goal for the team.') });

      const orch = sess.orch;
      await orch.plan(cfg, goal);
      // First run of an unbound (legacy) session binds it to the resolved dir.
      if (!sess.workspacePath && orch.config?.workspacePath) {
        await bindSessionWorkspace(sess, orch.config.workspacePath);
      }
      return json(res, 200, { ok: true, state: orch.state() });
    }

    // Solo mode: run a single agent (programmer / team lead / QA) directly,
    // with one instruction — no plan, no pipeline.
    if (url.pathname === '/api/quick' && req.method === 'POST') {
      const body = await readBody(req);
      const role = ['programmer', 'reviewer', 'qa', 'ask'].includes(body.role) ? body.role : null;
      if (!role) return json(res, 400, { error: t('Role must be programmer, reviewer, qa or ask.') });
      const instruction = (body.instruction || '').trim();
      if (!instruction) return json(res, 400, { error: t('Describe what the agent should do.') });
      const engine = ['claude-code', 'kimi'].includes(body.engine) ? body.engine : 'api';
      if (engine === 'kimi' && !kimiKey()) return json(res, 400, { error: t('KIMI_API_KEY is not set in .env') });
      const model = String(body.model || (engine === 'claude-code' ? '' : engine === 'kimi' ? 'kimi-for-coding-highspeed' : 'claude-sonnet-4-5')).trim();
      const sess = getSession(url, body);
      const cfg = {
        programmers: 1, reviewers: 1, qa: 1,
        models: { programmer: model, reviewer: model, qa: model },
        engine,
        engines: { programmer: engine, reviewer: engine, qa: engine },
        requireMergeApproval: false, prMode: false, finalQa: false,
        branch: String(body.branch || '').trim(),
        baseBranch: String(body.baseBranch || '').trim(),
        apiKey: apiKey(),
        kimiKey: kimiKey(),
        workspacePath: sess.workspacePath || (body.workspacePath || '').trim(),
        gitUrl: sess.workspacePath ? '' : (body.gitUrl || '').trim(),
        notifyEmail: (body.notifyEmail || '').trim(),
      };
      const orch = sess.orch;
      await orch.quickRun(cfg, role, instruction);
      if (!sess.workspacePath && orch.config?.workspacePath) {
        await bindSessionWorkspace(sess, orch.config.workspacePath);
      }
      return json(res, 200, { ok: true, state: orch.state() });
    }

    // Step 1b: user objections → new plan
    if (url.pathname === '/api/replan' && req.method === 'POST') {
      const body = await readBody(req);
      const feedback = (body.feedback || '').trim();
      if (!feedback) return json(res, 400, { error: t('Write your objections for the new plan.') });
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
        return json(res, 404, { error: t('Run snapshot does not exist (already resumed or deleted)') });
      }
      const orch = getOrch(url, body);
      try {
        await orch.restore(snap, apiKey(), kimiKey());
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
      if (!task) return json(res, 404, { error: t('Task does not exist') });
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
      if (!ws) return json(res, 400, { error: t('No active workspace') });
      let target = ws;
      try { await fs.access(path.join(ws, 'index.html')); target = path.join(ws, 'index.html'); } catch { /* open folder */ }
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      execFile(opener, [target]);
      return json(res, 200, { ok: true, target });
    }

    // UI language (en default / sr) — persisted server-side so orchestrator
    // messages and emails follow the same setting as the web UI chrome.
    if (url.pathname === '/api/lang' && req.method === 'GET') {
      return json(res, 200, { lang: getLang() });
    }
    if (url.pathname === '/api/lang' && req.method === 'POST') {
      const body = await readBody(req);
      const lang = await setLang(body.lang);
      broadcast({ type: 'lang_changed', lang });
      return json(res, 200, { ok: true, lang });
    }

    if (url.pathname === '/api/test-email' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await sendEmail({
          to: body.to,
          subject: t('Agentura — test email'),
          text: t('Resend configuration works. Notifications will arrive here when agents finish tasks.'),
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
  console.log(`\n  Agentura ▸ http://localhost:${PORT}  (bind: ${HOST})\n`);
  if (HOST !== '127.0.0.1') console.log('  ⚠ Server is reachable from other machines — anyone on the network can execute commands!');
  console.log(apiKey() ? '  ANTHROPIC_API_KEY: set ✓' : '  ANTHROPIC_API_KEY: not set → MOCK mode (add it to .env)');
  console.log(kimiKey() ? '  KIMI_API_KEY: set ✓ (Kimi engine available)' : '  KIMI_API_KEY: not set (Kimi engine disabled)');
  console.log('  Email: Resend' + (process.env.RESEND_API_KEY ? ' (env key) ✓' : ' (RESEND_API_KEY missing in .env)'));
});
