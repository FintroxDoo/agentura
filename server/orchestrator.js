// Orchestrator: team lead plans tasks from a goal, user approves the plan,
// then tasks are distributed to programmer agents which work in parallel,
// with the review loop (team lead), the QA phase, and the final email.
//
// Phases: idle → planning → awaiting_approval → running → finished
//
// Isolation: every task gets its own git worktree (branch harness/task-N)
// forked from the main branch, so parallel programmers never step on each
// other. After QA passes, the task branch is merged back into main; a merge
// conflict sends the task back to the programmer on a fresh base.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentEpisode } from './agent.js';
import { runClaudeCodeEpisode } from './claude-code.js';
import { runMockEpisode } from './mock.js';
import { plannerPrompt, programmerPrompt, reviewerPrompt, qaPrompt, integrationQaPrompt, soloReviewerPrompt, soloQaPrompt } from './roles.js';
import { runCommand } from './tools.js';
import { sendEmail } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = path.join(__dirname, '..', 'data', 'runs');
// Live snapshot of every active run — enables resume after a server restart.
export const ACTIVE_DIR = path.join(__dirname, '..', 'data', 'active');
const HARNESS_DIR = path.join(__dirname, '..');
const NOTES_FILE = 'HARNESS-NOTES.md';

const MAX_REVIEW_CYCLES = 5; // safety valve per task
const POLL_MS = 400;

// USD per 1M tokens: [input, output]. Cache write = 1.25x input, read = 0.1x.
function priceFor(model) {
  const m = String(model).toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return [10, 50];
  if (m.includes('opus-4-1') || m.includes('opus-4-0')) return [15, 75];
  if (m.includes('opus')) return [5, 25];
  if (m.includes('sonnet')) return [3, 15];
  if (m.includes('haiku-3')) return [0.25, 1.25];
  if (m.includes('haiku')) return [1, 5];
  return null;
}

function costOf(usage, model) {
  const p = priceFor(model);
  if (!p) return 0;
  const [inP, outP] = p;
  return (
    (usage.input * inP + usage.cacheWrite * inP * 1.25 + usage.cacheRead * inP * 0.1 + usage.output * outP) / 1e6
  );
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costUsd: 0 });

export class Orchestrator {
  constructor(broadcast) {
    this.broadcast = broadcast; // (event) => void  → SSE to UI
    this.reset();
  }

  // Fire-and-forget email; never breaks the run if Resend fails.
  notify(subject, text) {
    const to = this.config?.notifyEmail;
    if (!to) return;
    sendEmail({ to, subject, text })
      .then(() => this.logMsg('Orkestrator', `📧 Email poslat na ${to}: ${subject}`))
      .catch((err) => this.logMsg('Orkestrator', `📧 Slanje emaila nije uspelo: ${err.message}`));
  }

  reset() {
    this.phase = 'idle';
    this.stopping = false;
    this.config = null;
    this.goal = '';
    this.proposal = null; // proposed tasks awaiting approval: [{title, description, dependsOn}]
    this.agents = [];
    this.tasks = [];
    this.reviewQueue = [];
    this.qaQueue = [];
    this.log = [];
    this.startedAt = null;
    this.finishedAt = null;
    this.runId = null;
    this.mainBranch = 'master';
    this.totalUsage = emptyUsage();
    this.steerings = [];        // [{taskId|null, message, ts}] — live user directives
    this.pausedUntil = 0;       // plan rate-limit backoff
    this.integrationRounds = 0; // final integration QA passes
    this.soloRole = null;       // set for solo (single-agent) runs
    this.workersRunning = false;
    this._gitLock = Promise.resolve();
    this._snapTimer = null;
    this._stuckPending = [];    // newly stuck tasks awaiting one digest email
    this._stuckTimer = null;
  }

  state() {
    return {
      phase: this.phase,
      running: this.phase === 'running',
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      runId: this.runId,
      goal: this.goal,
      plan: this.proposal,
      usage: this.totalUsage,
      pausedUntil: this.pausedUntil,
      soloRole: this.soloRole,
      steerings: this.steerings.slice(-20),
      agents: this.agents.map(({ id, name, role, status, currentTaskId, usage, lastText }) => ({
        id, name, role, status, currentTaskId, usage,
        lastText: (lastText || '').slice(0, 4000),
      })),
      tasks: this.tasks,
      log: this.log.slice(-200),
      config: this.config && {
        programmers: this.config.programmers,
        reviewers: this.config.reviewers,
        qa: this.config.qa,
        models: this.config.models,
        engine: this.config.engine,
        mock: this.config.engine === 'api' && !this.config.apiKey,
        workspacePath: this.config.workspacePath,
        notifyEmail: this.config.notifyEmail,
      },
    };
  }

  emit(type, data = {}) {
    const evt = { type, ts: Date.now(), ...data };
    if (type === 'log') {
      this.log.push({ ts: evt.ts, agent: data.agent, msg: data.msg });
      if (this.log.length > 2000) this.log.splice(0, this.log.length - 1000);
    }
    this.broadcast(evt);
  }

  logMsg(agent, msg) {
    this.emit('log', { agent, msg });
  }

  get isMock() {
    return this.config?.engine === 'api' && !this.config?.apiKey;
  }

  engineLabel() {
    if (this.isMock) return 'MOCK mod (bez API ključa)';
    if (this.config.engine === 'claude-code') return 'Claude Code (pretplata)';
    return 'Claude API';
  }

  setPhase(phase) {
    this.phase = phase;
    this.emit('phase_change', { state: this.state() });
  }

  addUsage(task, agent, usage, model) {
    if (!usage || !usage.calls) return;
    // Claude Code CLI reports its own cost (informative under a subscription);
    // the raw API path computes it from the price table.
    const cost = typeof usage.costUsd === 'number' ? usage.costUsd : costOf(usage, model);
    for (const target of [this.totalUsage, task?.usage, agent?.usage]) {
      if (!target) continue;
      target.input += usage.input;
      target.output += usage.output;
      target.cacheRead += usage.cacheRead;
      target.cacheWrite += usage.cacheWrite;
      target.calls += usage.calls;
      target.costUsd += cost;
    }
    this.emit('usage', { totals: this.totalUsage });
    this.scheduleSnapshot();
  }

  // ------------------------------------------------------------ planning
  async plan(config, goal) {
    if (this.phase === 'planning' || this.phase === 'running') {
      throw new Error('Planiranje ili run je već u toku');
    }
    this.reset();
    this.config = config;
    this.goal = goal;
    this.runId = new Date().toISOString().replace(/[:.]/g, '-');
    this.setPhase('planning');

    await this.prepareWorkspace();
    this.logMsg('Orkestrator', `Radni prostor spreman: ${config.workspacePath} (grana: ${this.mainBranch}) — motor: ${this.engineLabel()}`);

    // Planner runs async; result arrives via SSE (plan_ready / plan_failed).
    this._runPlanner(null);
  }

  replan(feedback) {
    if (this.phase !== 'awaiting_approval') throw new Error('Nema plana koji čeka odobrenje');
    this.setPhase('planning');
    this._runPlanner(feedback);
  }

  async _runPlanner(feedback) {
    const name = 'TeamLead-1';
    this.logMsg(name, feedback ? '🧠 Pravi novi plan uz tvoje primedbe…' : '🧠 Analizira cilj i pravi plan taskova…');

    let userMessage =
      `PROJECT GOAL:\n${this.goal}\n\n` +
      `The team has ${this.config.programmers} programmer(s) that will work on tasks in parallel.\n` +
      `The workspace may be empty (new project) or contain an existing codebase — explore it first if unsure.`;
    if (feedback) {
      userMessage +=
        `\n\nPREVIOUS PLAN:\n${JSON.stringify(this.proposal, null, 2)}` +
        `\n\nUSER OBJECTIONS — revise the plan to address these:\n${feedback}`;
    }
    userMessage += await this.notesBlock();
    userMessage += '\n\nProduce the task plan now.';

    try {
      const onEvent = (e) => {
        if (e.type === 'tool_call') this.logMsg(name, `🔧 ${e.tool} ${JSON.stringify(e.input).slice(0, 160)}`);
      };
      const model = this.config.models.reviewer;
      const runPlanEpisode = (msg, resumeSessionId) => {
        if (this.isMock) {
          return runMockEpisode({ role: 'planner', task: { id: 0, title: this.goal }, attempt: 1, workspace: this.config.workspacePath, onEvent });
        }
        if (this.config.engine === 'claude-code') {
          return runClaudeCodeEpisode({ model, system: plannerPrompt(name), userMessage: msg, workspace: this.config.workspacePath, onEvent, resumeSessionId });
        }
        return runAgentEpisode({ apiKey: this.config.apiKey, model, system: plannerPrompt(name), userMessage: msg, workspace: this.config.workspacePath, onEvent });
      };

      // Planner sometimes ends in prose without the JSON block (common on
      // multi-part goals). Retry up to twice, each time demanding JSON only —
      // for Claude Code we resume the same session so it doesn't re-explore.
      let tasks = null;
      let sessionId = null;
      for (let attempt = 1; attempt <= 3 && !tasks; attempt++) {
        const msg = attempt === 1 ? userMessage
          : `PROJECT GOAL:\n${this.goal}\n\n` +
            'Your previous reply did NOT contain a parseable task plan. Do NOT explore or explain further. ' +
            'Reply with ONLY the plan as a single fenced ```json code block — a JSON array of ' +
            '{ "title", "description", "size", "dependsOn" } objects — and NOTHING else before or after it.';
        if (attempt > 1) this.logMsg(name, `⚠ Plan nije bio u ispravnom JSON formatu — tražim ponovo samo JSON (pokušaj ${attempt}/3)…`);

        const result = await runPlanEpisode(msg, sessionId);
        sessionId = result.sessionId || sessionId;
        this.addUsage(null, null, result.usage, model);
        if (this.stopping || this.phase !== 'planning') return; // cancelled meanwhile
        tasks = parsePlanText(result.text);
      }
      if (!tasks) throw new Error('Planer nije vratio validan JSON plan taskova ni nakon 3 pokušaja');

      this.proposal = tasks;
      this.phase = 'awaiting_approval';
      this.logMsg(name, `📋 Plan spreman: ${tasks.length} taskova — čeka tvoje odobrenje.`);
      this.emit('plan_ready', { state: this.state() });
    } catch (err) {
      this.logMsg('Orkestrator', `✗ Planiranje nije uspelo: ${err.message}`);
      this.phase = 'idle';
      this.emit('plan_failed', { error: err.message, state: this.state() });
      this.notify(
        '✗ Agent Harness: planiranje nije uspelo',
        `Planiranje za cilj "${this.goal.slice(0, 120)}" je palo.\n\nGreška: ${err.message.slice(0, 500)}\n\nPokreni planiranje ponovo iz interfejsa.`
      );
    }
  }

  // ---------------------------------------------------------------- start
  async approve(taskInputs) {
    if (this.phase !== 'awaiting_approval') throw new Error('Nema plana koji čeka odobrenje');
    const inputs = (taskInputs && taskInputs.length ? taskInputs : this.proposal)
      .filter((t) => t && t.title && String(t.title).trim());
    if (!inputs.length) throw new Error('Plan nema nijedan task');

    const config = this.config;
    this.stopping = false;
    this.startedAt = Date.now();

    // Create agents
    let id = 0;
    for (let i = 0; i < config.programmers; i++)
      this.agents.push({ id: ++id, name: `Programer-${i + 1}`, role: 'programmer', status: 'idle', currentTaskId: null, usage: emptyUsage(), lastText: '' });
    for (let i = 0; i < config.reviewers; i++)
      this.agents.push({ id: ++id, name: `TeamLead-${i + 1}`, role: 'reviewer', status: 'idle', currentTaskId: null, usage: emptyUsage(), lastText: '' });
    for (let i = 0; i < config.qa; i++)
      this.agents.push({ id: ++id, name: `QA-${i + 1}`, role: 'qa', status: 'idle', currentTaskId: null, usage: emptyUsage(), lastText: '' });

    // Tasks form a shared pool — programmers claim the next available task
    // when free (work stealing), instead of a fixed round-robin split.
    const n = inputs.length;
    this.tasks = inputs.map((t, i) => ({
      id: i + 1,
      title: String(t.title).trim(),
      description: String(t.description || t.title).trim(),
      size: ['S', 'M', 'L'].includes(t.size) ? t.size : 'M',
      dependsOn: normalizeDeps(t.dependsOn, i + 1, n),
      status: 'queued', // queued | coding | in_review | in_qa | awaiting_merge | needs_fix | done | stuck
      assignee: null,   // claimed at pickup
      assigneeId: null,
      pinnedTo: null,   // manual drag&drop assignment — only that programmer may take it
      attempts: 0,
      reviewCycles: 0,
      qaCycles: 0,
      feedback: null,      // reviewer/QA/merge feedback awaiting fix
      feedbackSource: null,
      lastSummary: null,
      changedFiles: [],
      usage: emptyUsage(),
      worktree: null,
      branch: null,
      history: [],
    }));
    this.breakDependencyCycles();

    this.phase = 'running';
    this.emit('run_started', { state: this.state() });
    const m = config.models;
    this.logMsg('Orkestrator', `Plan odobren — run started: ${this.tasks.length} taskova, ${config.programmers} programera, ${config.reviewers} team lead(ova), ${config.qa} QA. Motor: ${this.engineLabel()}${this.isMock ? '' : ` — modeli: ${m.programmer || '(default)'}/${m.reviewer || '(default)'}/${m.qa || '(default)'}`}`);
    this.startWorkers();
    this.saveSnapshot().catch(() => {});
  }

  // ------------------------------------------------- solo (single-agent) run
  // One agent, one episode, no plan/review/QA pipeline: a lone programmer
  // implements a task, a team lead reviews/analyzes, or a QA verifies.
  async quickRun(config, role, instruction) {
    if (this.phase === 'planning' || this.phase === 'running') {
      throw new Error('Planiranje ili run je već u toku');
    }
    this.reset();
    this.config = config;
    this.goal = instruction;
    this.soloRole = role;
    this.runId = new Date().toISOString().replace(/[:.]/g, '-');
    this.startedAt = Date.now();

    await this.prepareWorkspace();

    const names = { programmer: 'Programer-1', reviewer: 'TeamLead-1', qa: 'QA-1' };
    const agent = { id: 1, name: names[role], role, status: 'idle', currentTaskId: null, usage: emptyUsage(), lastText: '' };
    this.agents = [agent];
    const statusFor = { programmer: 'coding', reviewer: 'in_review', qa: 'in_qa' };
    this.tasks = [{
      id: 1,
      title: instruction.slice(0, 90),
      description: instruction,
      size: 'M', dependsOn: [], status: statusFor[role],
      assignee: agent.name, assigneeId: 1, pinnedTo: null,
      attempts: 1, reviewCycles: 0, qaCycles: 0,
      feedback: null, feedbackSource: null, lastSummary: null,
      changedFiles: [], usage: emptyUsage(), worktree: null, branch: null, history: [],
    }];

    this.phase = 'running';
    this.emit('run_started', { state: this.state() });
    const roleLabel = { programmer: 'programer', reviewer: 'team lead (review/analiza)', qa: 'QA' }[role];
    this.logMsg('Orkestrator', `⚡ Solo run: ${roleLabel} — motor: ${this.engineLabel()}, workspace: ${config.workspacePath}`);
    this._runSolo(agent, this.tasks[0], role); // fires async; result arrives via SSE
  }

  async _runSolo(agent, task, role) {
    const ws = this.config.workspacePath;
    this.setAgent(agent, 'working', task.id);
    try {
      const system =
        role === 'programmer' ? programmerPrompt(agent.name) :
        role === 'reviewer' ? soloReviewerPrompt(agent.name) :
        soloQaPrompt(agent.name, HARNESS_DIR);
      let userMessage =
        role === 'programmer' ? `Task: ${this.goal}\n\nImplement this task in the workspace now.` :
        role === 'reviewer' ? `REVIEW/ANALYSIS REQUEST:\n${this.goal}\n\nInspect the repository and produce the review now.` :
        `QA REQUEST:\n${this.goal}\n\nVerify this in the project now. Remember to end with the VERDICT line.`;
      userMessage += await this.notesBlock();

      const result = await this.episode({ agent, role, task, system, userMessage, attempt: 1, workspace: ws });
      task.history.push({ role, agent: agent.name, text: result.text, ts: Date.now() });

      let failed = false;
      if (role === 'programmer') {
        // Solo programmer works directly on the main branch — commit the result.
        const changed = (await runCommand(ws, 'git status --porcelain')).trim();
        if (changed && !changed.startsWith('ERROR')) {
          await runCommand(ws, `git add -A && git -c user.email=harness@local -c user.name="Agent Harness" commit -qm ${JSON.stringify(`solo: ${this.goal.slice(0, 70)}`)}`);
          task.changedFiles = changed.split('\n').map((l) => l.slice(2).trim()).filter(Boolean);
          this.logMsg(agent.name, `✓ Izmene komitovane (${task.changedFiles.length} fajlova)`);
        } else {
          this.logMsg(agent.name, '⚠ Nema izmena fajlova — agent je odgovorio bez koda');
        }
      }
      if (role === 'qa') {
        failed = lastVerdict(result.text) === 'FAILED';
        this.logMsg(agent.name, failed ? '❌ VERDICT: FAILED — detalji u izveštaju' : '✅ VERDICT: PASSED');
      }
      this.updateTask(task, { status: 'done', lastSummary: result.text, feedback: failed ? result.text : null, feedbackSource: failed ? 'qa' : null });
      this.setAgent(agent, 'done');
      await this._finishSolo(role, result.text, failed);
    } catch (err) {
      this.logMsg(agent.name, `✗ Solo epizoda nije uspela: ${err.message}`);
      this.updateTask(task, { status: 'stuck', feedback: err.message });
      this.setAgent(agent, 'idle');
      await this._finishSolo(role, `Epizoda nije uspela: ${err.message}`, true);
    }
  }

  async _finishSolo(role, report, failed) {
    this.finishedAt = Date.now();
    const mins = ((this.finishedAt - this.startedAt) / 60000).toFixed(1);
    const u = this.totalUsage;
    const roleLabel = { programmer: 'programer', reviewer: 'team lead', qa: 'QA' }[role];
    const summary =
      `Agent Harness — solo ${roleLabel} završen za ${mins} min.${u.costUsd ? ` (~$${u.costUsd.toFixed(2)})` : ''}\n\n` +
      `Zahtev: ${this.goal}\n\nIZVEŠTAJ:\n${report}\n\nWorkspace: ${this.config.workspacePath}`;
    this.phase = 'finished';
    this.logMsg('Orkestrator', failed ? 'Solo run završen — NEUSPEŠNO/FAILED (vidi izveštaj).' : 'Solo run završen.');
    this.emit('run_finished', { summary, done: failed ? 0 : 1, total: 1, stuck: failed ? 1 : 0, usage: u, state: this.state() });
    await this.persistRun(summary, failed ? 0 : 1, failed ? 1 : 0);
    if (this.config.notifyEmail) {
      try {
        await sendEmail({
          to: this.config.notifyEmail,
          subject: `${failed ? '❌' : '✅'} Agent Harness (solo ${roleLabel}): ${this.goal.slice(0, 60)}`,
          text: summary.slice(0, 8000),
        });
        this.logMsg('Orkestrator', `📧 Izveštaj poslat na ${this.config.notifyEmail}`);
      } catch (err) {
        this.logMsg('Orkestrator', `📧 Slanje emaila nije uspelo: ${err.message}`);
      }
    }
  }

  startWorkers() {
    this.workersRunning = true;
    const workers = [
      ...this.agents.filter((a) => a.role === 'programmer').map((a) => this.programmerWorker(a)),
      ...this.agents.filter((a) => a.role === 'reviewer').map((a) => this.reviewerWorker(a)),
      ...this.agents.filter((a) => a.role === 'qa').map((a) => this.qaWorker(a)),
    ];
    Promise.all(workers)
      .then(() => { this.workersRunning = false; this.finishRun(); })
      .catch((err) => {
        this.workersRunning = false;
        this.logMsg('Orkestrator', `FATAL: ${err.message}`);
        this.finishRun();
      });
  }

  // Deps must be acyclic or dependent tasks would wait forever. Kahn's
  // algorithm; any task left in a cycle loses its dependencies.
  breakDependencyCycles() {
    const resolved = new Set();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const t of this.tasks) {
        if (!resolved.has(t.id) && t.dependsOn.every((d) => resolved.has(d))) {
          resolved.add(t.id);
          progressed = true;
        }
      }
    }
    for (const t of this.tasks) {
      if (!resolved.has(t.id)) {
        this.logMsg('Orkestrator', `⚠ Task #${t.id} je deo ciklusa zavisnosti — zavisnosti su mu uklonjene.`);
        t.dependsOn = [];
      }
    }
  }

  // ------------------------------------------------------ steering & pause
  steer(taskId, message) {
    if (!['running', 'finished'].includes(this.phase)) throw new Error('Poruke timu važe tek kad run krene');
    const msg = String(message || '').trim();
    if (!msg) throw new Error('Prazna poruka');
    if (taskId) {
      const t = this.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`Task #${taskId} ne postoji`);
    }
    this.steerings.push({ taskId: taskId || null, message: msg.slice(0, 2000), ts: Date.now() });
    this.logMsg('Ti', `📣 ${taskId ? `[task #${taskId}] ` : '[ceo tim] '}${msg.slice(0, 200)}`);
    this.emit('phase_change', { state: this.state() });
  }

  steeringBlockFor(taskId) {
    const relevant = this.steerings.filter((d) => d.taskId === null || d.taskId === taskId);
    if (!relevant.length) return '';
    return '\n\nUSER DIRECTIVES (live instructions from the human team lead — MUST follow):\n' +
      relevant.map((d) => `- ${d.message}`).join('\n') + '\n';
  }

  async notesBlock() {
    try {
      const notes = await fs.readFile(path.join(this.config.workspacePath, NOTES_FILE), 'utf8');
      const body = notes.split('\n').slice(1).join('\n').trim();
      if (!body) return '';
      return `\n\nPROJECT NOTES (lessons accumulated in previous runs — respect them):\n${notes.slice(0, 4000)}\n`;
    } catch { return ''; }
  }

  pauseForLimit(msg) {
    if (this.pausedUntil > Date.now()) return;
    this.pausedUntil = Date.now() + 15 * 60_000;
    this.logMsg('Orkestrator', `⏸ Limit plana dostignut — pauziram sve epizode 15 min. (${(msg || '').slice(0, 120)})`);
    this.emit('phase_change', { state: this.state() });
    const until = new Date(this.pausedUntil).toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' });
    this.notify(
      '⏸ Agent Harness: limit plana — run pauziran',
      `Run "${this.goal.slice(0, 120)}" je pauziran jer je dostignut limit Claude plana.\n\n` +
      `Poruka: ${(msg || '').slice(0, 300)}\n\n` +
      `Automatski nastavlja u ${until} (pa proverava ponovo na 15 min dok se limit ne resetuje).\n` +
      `Ako si već dopunio limit/tokene, klikni "▶ Nastavi odmah" u interfejsu — ne moraš da čekaš.\n\n` +
      `Workspace: ${this.config.workspacePath}`
    );
  }

  // User clicked "▶ Nastavi odmah" — cut the limit pause short.
  resumePause() {
    if (this.pausedUntil <= Date.now()) throw new Error('Run nije pauziran');
    this.pausedUntil = 0;
    this.logMsg('Orkestrator', '▶ Ručni nastavak — pauza prekinuta, tim nastavlja odmah.');
    this.emit('phase_change', { state: this.state() });
  }

  async waitIfPaused() {
    if (this.pausedUntil <= Date.now()) return false;
    await sleep(5000);
    // guard on pausedUntil !== 0 so a manual resumePause() doesn't double-log
    if (this.pausedUntil && this.pausedUntil <= Date.now()) {
      this.pausedUntil = 0;
      this.logMsg('Orkestrator', '▶ Pauza istekla — nastavljam rad.');
      this.emit('phase_change', { state: this.state() });
    }
    return true;
  }

  // ------------------------------------------------------ retry stuck task
  retryTask(taskId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task #${taskId} ne postoji`);
    if (task.status !== 'stuck') throw new Error(`Task #${taskId} nije zaglavljen (status: ${task.status})`);

    // Fresh budget of review/QA cycles; unclaim it so the first free
    // programmer (ideally a different one — fresh perspective) takes it.
    task.reviewCycles = 0;
    task.qaCycles = 0;
    const status = task.attempts > 0 && task.feedback ? 'needs_fix' : 'queued';
    this.updateTask(task, { status, assignee: null, assigneeId: null, pinnedTo: null });
    this.logMsg('Orkestrator', `↻ Task #${task.id} vraćen u rad (${status}) — uzima ga prvi slobodan programer`);

    if (!this.workersRunning) this.resumeRun();
  }

  // Manual drag&drop assignment: pin the task to a specific programmer.
  assignTask(taskId, agentId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task #${taskId} ne postoji`);
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent || agent.role !== 'programmer') throw new Error('Task može da se dodeli samo programeru');
    if (!['queued', 'needs_fix', 'stuck'].includes(task.status)) {
      throw new Error(`Task #${taskId} je u statusu "${task.status}" — ručno se dodeljuje samo task koji čeka, traži popravku ili je zaglavljen`);
    }
    if (task.status === 'stuck') {
      task.reviewCycles = 0;
      task.qaCycles = 0;
    }
    const status = task.status === 'stuck' ? (task.feedback ? 'needs_fix' : 'queued') : task.status;
    this.updateTask(task, { status, pinnedTo: agent.id, assignee: agent.name, assigneeId: agent.id });
    this.logMsg('Orkestrator', `👉 Task #${task.id} ručno dodeljen programeru ${agent.name} — uzima ga čim se oslobodi`);

    if (!this.workersRunning) this.resumeRun();
  }

  resumeRun() {
    if (this.workersRunning) return;
    this.phase = 'running';
    this.stopping = false;
    this.finishedAt = null;
    for (const a of this.agents) this.setAgent(a, 'idle');
    this.emit('run_started', { state: this.state() });
    this.logMsg('Orkestrator', 'Run nastavljen.');
    this.startWorkers();
  }

  // --------------------------------------------------------- workspace/git
  async prepareWorkspace() {
    const cfg = this.config;
    let ws = cfg.workspacePath;
    if (!ws) {
      ws = path.resolve(process.cwd(), 'workspace-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
    }
    ws = path.resolve(ws);
    cfg.workspacePath = ws;

    if (cfg.gitUrl) {
      await fs.mkdir(path.dirname(ws), { recursive: true });
      const out = await runCommand(path.dirname(ws), `git clone ${JSON.stringify(cfg.gitUrl)} ${JSON.stringify(ws)}`, 300_000);
      this.logMsg('Orkestrator', `git clone: ${out.slice(0, 300)}`);
    } else {
      await fs.mkdir(ws, { recursive: true });
    }
    // Ensure it is a git repo so we can produce diffs, worktrees and commits
    const isRepo = (await runCommand(ws, 'git rev-parse --is-inside-work-tree 2>/dev/null')).includes('true');
    if (!isRepo) {
      await runCommand(ws, 'git init -q && git add -A && git -c user.email=harness@local -c user.name=harness commit -qm "baseline" --allow-empty');
    }

    // Worktrees fork from HEAD — snapshot any uncommitted changes first so
    // programmers see the complete current state of the project.
    const dirty = (await runCommand(ws, 'git status --porcelain')).trim();
    if (dirty && !dirty.startsWith('ERROR')) {
      await runCommand(ws, 'git add -A && git -c user.email=harness@local -c user.name=harness commit -qm "pre-harness snapshot"');
      this.logMsg('Orkestrator', 'Zatečene nekomitovane izmene — snimljene kao "pre-harness snapshot" commit.');
    }

    // Project memory: notes file agents read every episode and append lessons
    // to. merge=union so parallel appends from task branches never conflict.
    const notesPath = path.join(ws, NOTES_FILE);
    try { await fs.access(notesPath); } catch {
      await fs.writeFile(notesPath, '# Beleške projekta (harness memorija)\n');
    }
    const gaPath = path.join(ws, '.gitattributes');
    let ga = '';
    try { ga = await fs.readFile(gaPath, 'utf8'); } catch { /* create below */ }
    if (!ga.includes(NOTES_FILE)) {
      await fs.writeFile(gaPath, ga + (ga && !ga.endsWith('\n') ? '\n' : '') + `${NOTES_FILE} merge=union\n`);
    }
    await runCommand(ws, 'git add -A && git -c user.email=harness@local -c user.name=harness commit -qm "harness notes init" || true');

    let branch = (await runCommand(ws, 'git rev-parse --abbrev-ref HEAD')).trim().split('\n')[0];
    if (!branch || branch === 'HEAD' || branch.startsWith('ERROR')) {
      await runCommand(ws, 'git checkout -qB harness-main');
      branch = 'harness-main';
    }
    this.mainBranch = branch;

    // Clean up leftovers from previous runs
    const base = path.basename(ws);
    await runCommand(ws, 'git worktree prune');
    await runCommand(path.dirname(ws), `rm -rf ".hwt-${base}-t"* ; true`);
    await runCommand(ws, `git worktree prune; git branch --list 'harness/task-*' --format='%(refname:short)' | while read b; do git branch -D "$b"; done; true`);
  }

  ensureWorktree(task) {
    this._gitLock = this._gitLock.then(async () => {
      if (task.worktree) return;
      const ws = this.config.workspacePath;
      const branch = `harness/task-${task.id}`;
      const wt = path.join(path.dirname(ws), `.hwt-${path.basename(ws)}-t${task.id}`);
      await runCommand(path.dirname(ws), `rm -rf ${JSON.stringify(wt)}`);
      const out = await runCommand(ws, `git worktree prune; git worktree add -B ${JSON.stringify(branch)} ${JSON.stringify(wt)} ${JSON.stringify(this.mainBranch)}`);
      if (/fatal:|ERROR/.test(out)) throw new Error(`git worktree add nije uspeo: ${out.slice(0, 300)}`);
      task.worktree = wt;
      task.branch = branch;
      this.logMsg('Orkestrator', `🌿 Task #${task.id}: radna kopija na grani ${branch}`);
    });
    return this._gitLock;
  }

  // Every change in the task's worktree belongs to that task — no more
  // relying on the agent reporting files through write_file.
  async taskChangedFiles(task) {
    if (!task.worktree) return [];
    const out = await runCommand(task.worktree, 'git status --porcelain');
    if (out.startsWith('ERROR')) return [];
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const p = l.slice(2).trim();
        return p.includes(' -> ') ? p.split(' -> ')[1] : p;
      })
      .filter(Boolean);
  }

  async diffFor(task, limitOverride = null) {
    if (!task.worktree) return '(no worktree — task has not started)';
    let diff = await runCommand(task.worktree, 'git add -N -A 2>/dev/null; git diff HEAD');
    if (!diff.trim() || diff.startsWith('ERROR')) diff = '(diff unavailable — see file list)';
    const limit = limitOverride || task.diffLimit || 30_000; // shrunk after a context-overflow error
    return diff.length > limit ? diff.slice(0, limit) + '\n...[diff truncated]' : diff;
  }

  // QA passed → commit the worktree and merge the task branch into main.
  // On conflict: reset the task to a fresh worktree and hand the programmer
  // their previous diff so they can re-implement on the new base.
  commitAndMerge(task) {
    this._gitLock = this._gitLock.then(async () => {
      const ws = this.config.workspacePath;
      await runCommand(
        task.worktree,
        `git add -A && git -c user.email=harness@local -c user.name="Agent Harness" commit -qm ${JSON.stringify(`task #${task.id}: ${task.title}`)} || true`
      );
      const out = await runCommand(ws, `git merge --no-ff -m ${JSON.stringify(`merge task #${task.id}: ${task.title}`)} ${JSON.stringify(task.branch)}`);
      if (/CONFLICT|fatal:|exit code/i.test(out)) {
        await runCommand(ws, 'git merge --abort; true');
        const oldDiff = await runCommand(ws, `git diff ${JSON.stringify(this.mainBranch)}...${JSON.stringify(task.branch)}`);
        await runCommand(ws, `git worktree remove --force ${JSON.stringify(task.worktree)}; git branch -D ${JSON.stringify(task.branch)}; true`);
        task.worktree = null;
        task.branch = null;
        return { ok: false, oldDiff: oldDiff.slice(0, 20_000) };
      }
      await runCommand(ws, `git worktree remove --force ${JSON.stringify(task.worktree)}; git branch -d ${JSON.stringify(task.branch)}; true`);
      task.worktree = null;
      task.branch = null;
      return { ok: true };
    });
    return this._gitLock;
  }

  // QA passed (and user approved if the gate is on) → deliver the task:
  // PR mode pushes the branch and opens a GitHub PR; otherwise local merge.
  async finalizeTask(task, byName) {
    if (this.config.prMode) {
      const pushed = await this.pushAndOpenPr(task);
      if (pushed) {
        this.logMsg(byName, `🎉 Task #${task.id} ZAVRŠEN — grana push-ovana i PR otvoren`);
        this.updateTask(task, { status: 'done' });
        return;
      }
      this.logMsg(byName, `⚠ Task #${task.id}: push/PR nije uspeo — radim lokalni merge umesto toga`);
    }
    const merge = await this.commitAndMerge(task);
    if (merge.ok) {
      this.logMsg(byName, `🎉 Task #${task.id} PROŠAO — merge u ${this.mainBranch}, task ZAVRŠEN`);
      this.updateTask(task, { status: 'done' });
    } else {
      this.logMsg(byName, `⚔ Task #${task.id}: merge u konfliktu — vraćam programeru na svežu bazu`);
      this.updateTask(task, {
        status: 'needs_fix',
        feedbackSource: 'merge',
        changedFiles: [],
        feedback:
          'Your changes conflicted with work merged from other tasks. The workspace has been RESET to the latest main state — your previous changes are NOT there anymore. ' +
          'Re-implement the task on the fresh base, adapting to the current code. Your previous diff for reference:\n```\n' + merge.oldDiff + '\n```',
      });
    }
  }

  pushAndOpenPr(task) {
    this._gitLock = this._gitLock.then(async () => {
      await runCommand(
        task.worktree,
        `git add -A && git -c user.email=harness@local -c user.name="Agent Harness" commit -qm ${JSON.stringify(`task #${task.id}: ${task.title}`)} || true`
      );
      const push = await runCommand(task.worktree, `git push -u origin ${JSON.stringify(task.branch)}`);
      if (/fatal:|error:|exit code/i.test(push)) {
        this.logMsg('Orkestrator', `git push: ${push.slice(0, 200)}`);
        return false;
      }
      const body = `Automatski PR iz Agent Harness-a.\n\nTask: ${task.title}\n\n${(task.lastSummary || '').slice(0, 1500)}`;
      const pr = await runCommand(
        task.worktree,
        `gh pr create --head ${JSON.stringify(task.branch)} --title ${JSON.stringify(`task #${task.id}: ${task.title}`)} --body ${JSON.stringify(body)} 2>&1`
      );
      const url = (pr.match(/https:\/\/\S+/) || [])[0];
      if (url) this.logMsg('Orkestrator', `🔗 PR otvoren: ${url}`);
      else this.logMsg('Orkestrator', `gh pr create: ${pr.slice(0, 200)}`);
      await runCommand(this.config.workspacePath, `git worktree remove --force ${JSON.stringify(task.worktree)}; true`);
      task.worktree = null;
      return true;
    });
    return this._gitLock;
  }

  // User clicked "✓ Merge" on an awaiting_merge card
  async approveMerge(taskId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task #${taskId} ne postoji`);
    if (task.status !== 'awaiting_merge') throw new Error(`Task #${taskId} ne čeka merge (status: ${task.status})`);
    await this.finalizeTask(task, 'Ti');
  }

  stop() {
    if (this.phase === 'running') {
      this.stopping = true;
      this.logMsg('Orkestrator', 'Stop requested — workers will halt after current episodes.');
    } else if (this.phase === 'planning' || this.phase === 'awaiting_approval') {
      this.stopping = true;
      this.logMsg('Orkestrator', 'Planiranje otkazano.');
      this.setPhase('idle');
    }
  }

  // ------------------------------------------------------------- helpers
  allDone() {
    return this.tasks.every((t) => t.status === 'done' || t.status === 'stuck');
  }

  depsDone(task) {
    return task.dependsOn.every((d) => this.tasks.find((t) => t.id === d)?.status === 'done');
  }

  updateTask(task, patch) {
    const wasStuck = task.status === 'stuck';
    Object.assign(task, patch);
    this.emit('task_update', { task });
    if (task.status === 'stuck' && !wasStuck) this.queueStuckEmail(task);
    this.scheduleSnapshot();
  }

  // Stuck tasks often cascade (dependency propagation) — collect them for a
  // few seconds and send ONE digest email instead of a burst.
  queueStuckEmail(task) {
    if (!this.config?.notifyEmail) return;
    this._stuckPending.push({ id: task.id, title: task.title, feedback: (task.feedback || '').slice(0, 400) });
    clearTimeout(this._stuckTimer);
    this._stuckTimer = setTimeout(() => {
      const list = this._stuckPending.splice(0);
      if (!list.length) return;
      this.notify(
        `⚠ Agent Harness: ${list.length} task(ova) ZAGLAVLJENO`,
        `Run "${this.goal.slice(0, 120)}" ima novo-zaglavljene taskove:\n\n` +
        list.map((t) => `#${t.id} ${t.title}\n  Razlog: ${t.feedback || '(bez detalja)'}`).join('\n\n') +
        `\n\nRun nastavlja sa ostalim taskovima. Zaglavljene možeš da vratiš u rad dugmetom ↻ Retry u interfejsu.\n` +
        `Workspace: ${this.config.workspacePath}`
      );
    }, 20_000);
  }

  setAgent(agent, status, taskId = null) {
    agent.status = status;
    agent.currentTaskId = taskId;
    this.emit('agent_update', {
      agent: {
        id: agent.id, name: agent.name, role: agent.role, status, currentTaskId: taskId,
        usage: agent.usage, lastText: (agent.lastText || '').slice(0, 4000),
      },
    });
  }

  async episode({ agent, role, task, system, userMessage, attempt, workspace, resumeSessionId = null }) {
    const ws = workspace || this.config.workspacePath;
    const onEvent = (e) => {
      if (e.type === 'tool_call') this.logMsg(agent.name, `🔧 ${e.tool} ${JSON.stringify(e.input).slice(0, 160)}`);
      if (e.type === 'nudge') this.logMsg(agent.name, `⚠ Predao prazan rad (bez izmena fajlova) — podsetnik da implementira (pokušaj ${e.attempt}/2)`);
      if (e.type === 'agent_text') {
        agent.lastText = e.text;
        this.emit('agent_text', { agentId: agent.id, text: e.text.slice(0, 4000) });
      }
    };
    let result;
    const model = this.config.models[role] || this.config.models.programmer;
    const gitHasChanges = async () => (await runCommand(ws, 'git status --porcelain')).trim().length > 0;
    if (this.isMock) {
      result = await runMockEpisode({ role, task, attempt, workspace: ws, onEvent });
    } else if (this.config.engine === 'claude-code') {
      result = await runClaudeCodeEpisode({
        model, system, userMessage, workspace: ws, onEvent,
        requireChanges: role === 'programmer',
        hasChanges: role === 'programmer' ? gitHasChanges : null,
        resumeSessionId,
      });
    } else {
      result = await runAgentEpisode({
        apiKey: this.config.apiKey,
        model, system, userMessage, workspace: ws, onEvent,
        requireChanges: role === 'programmer',
        hasChanges: role === 'programmer' ? gitHasChanges : null,
      });
    }
    this.addUsage(task, agent, result.usage, model);
    return result;
  }

  // ------------------------------------------------------- worker loops
  // Can this programmer take this task right now?
  claimableBy(task, agent) {
    if (task.status === 'needs_fix') {
      // fixes stay with the owner (context continuity) unless pinned elsewhere
      if (task.pinnedTo) return task.pinnedTo === agent.id;
      return task.assigneeId === agent.id || !task.assigneeId;
    }
    if (task.status !== 'queued' || !this.depsDone(task)) return false;
    if (task.pinnedTo) return task.pinnedTo === agent.id;
    return !task.assigneeId; // unclaimed — first free programmer takes it
  }

  async programmerWorker(agent) {
    while (!this.stopping && !this.allDone()) {
      if (await this.waitIfPaused()) continue;
      // A task whose dependency got stuck can never start — propagate.
      for (const t of this.tasks) {
        if (t.status === 'queued') {
          const stuckDep = t.dependsOn.find((d) => this.tasks.find((x) => x.id === d)?.status === 'stuck');
          if (stuckDep) {
            this.logMsg('Orkestrator', `⚠ Task #${t.id} blokiran: zavisnost #${stuckDep} je zaglavljena`);
            this.updateTask(t, { status: 'stuck', feedback: `Zavisnost (task #${stuckDep}) je zaglavljena — task ne može da počne. Odglavi task #${stuckDep} pa pokušaj ponovo ovaj.` });
          }
        }
      }

      // Priority: manually pinned to me → my fixes → any unclaimed task
      const task =
        this.tasks.find((t) => t.pinnedTo === agent.id && this.claimableBy(t, agent)) ||
        this.tasks.find((t) => this.claimableBy(t, agent));
      if (!task) {
        await sleep(POLL_MS);
        continue;
      }

      task.attempts += 1;
      const fixing = task.status === 'needs_fix';
      this.updateTask(task, { status: 'coding', assignee: agent.name, assigneeId: agent.id });
      this.setAgent(agent, 'working', task.id);
      this.logMsg(agent.name, fixing ? `▶ Popravlja task #${task.id} (${task.feedbackSource} feedback)` : `▶ Počinje task #${task.id}: ${task.title}`);

      try {
        await this.ensureWorktree(task);

        let userMessage;
        if (fixing && task.feedback) {
          const label = { qa: 'QA FAILURE REPORT', merge: 'MERGE CONFLICT REPORT', reviewer: 'REVIEWER FEEDBACK' }[task.feedbackSource] || 'FEEDBACK';
          userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}\n\nYour previous summary:\n${task.lastSummary || '(none)'}\n\n${label} — fix these issues:\n${task.feedback}`;
        } else {
          userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}\n\nImplement this task in the workspace now.`;
        }
        userMessage += await this.notesBlock();
        userMessage += this.steeringBlockFor(task.id);

        const result = await this.episode({
          agent, role: 'programmer', task, attempt: task.attempts,
          system: programmerPrompt(agent.name), userMessage, workspace: task.worktree,
          resumeSessionId: task.resumeSessions?.programmer || null,
        });
        if (task.resumeSessions) delete task.resumeSessions.programmer;
        task.history.push({ role: 'programmer', agent: agent.name, text: result.text, ts: Date.now() });
        const gitFiles = await this.taskChangedFiles(task);
        const files = new Set([...result.changedFiles, ...gitFiles]);
        this.updateTask(task, { status: 'in_review', lastSummary: result.text, changedFiles: [...files], feedback: null });
        this.reviewQueue.push(task.id);
        this.logMsg(agent.name, `✓ Task #${task.id} poslat na review (${files.size} fajlova izmenjeno)`);
      } catch (err) {
        if (err.rateLimited) {
          // Remember the cut-off CLI session so the retry continues the same
          // conversation (--resume) instead of starting the task over.
          if (err.cliSessionId) task.resumeSessions = { ...task.resumeSessions, programmer: err.cliSessionId };
          this.pauseForLimit(err.message);
          this.updateTask(task, { status: fixing ? 'needs_fix' : 'queued' });
        } else {
          this.logMsg(agent.name, `✗ Greška na tasku #${task.id}: ${err.message}`);
          this.updateTask(task, { status: 'stuck', feedback: err.message });
        }
      }
      this.setAgent(agent, 'idle');
    }
    this.setAgent(agent, 'done');
  }

  async reviewerWorker(agent) {
    while (!this.stopping && !this.allDone()) {
      if (await this.waitIfPaused()) continue;
      const taskId = this.reviewQueue.shift();
      if (taskId == null) {
        await sleep(POLL_MS);
        continue;
      }
      const task = this.tasks.find((t) => t.id === taskId);
      task.reviewCycles += 1;
      this.setAgent(agent, 'working', task.id);
      this.logMsg(agent.name, `🔍 Review #${task.reviewCycles} za task #${task.id}`);

      const diff = await this.diffFor(task);
      // Episodes are stateless — hand the reviewer its own previous feedback
      // so cycle N verifies cycle N-1's requests instead of raising new ones.
      const prevReview = [...task.history].reverse().find((h) => h.role === 'reviewer');
      const prevBlock = prevReview
        ? `\n\nYOUR PREVIOUS REVIEW FEEDBACK (cycle ${task.reviewCycles - 1}) — FIRST verify each of these points was addressed; do not raise new minor issues if these are resolved:\n${prevReview.text.slice(0, 4000)}\n`
        : '';
      const userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}\n\nProgrammer (${task.assignee}) summary:\n${task.lastSummary}\n\nChanged files: ${task.changedFiles.join(', ') || '(none reported)'}${prevBlock}\n\nDiff:\n\`\`\`\n${diff}\n\`\`\`\n\nReview this change now. Remember to end with the VERDICT line.`;

      try {
        const result = await this.episode({
          agent, role: 'reviewer', task, attempt: task.reviewCycles,
          system: reviewerPrompt(agent.name), userMessage, workspace: task.worktree,
          resumeSessionId: task.resumeSessions?.reviewer || null,
        });
        if (task.resumeSessions) delete task.resumeSessions.reviewer;
        task.history.push({ role: 'reviewer', agent: agent.name, text: result.text, ts: Date.now() });
        const approved = lastVerdict(result.text) === 'APPROVED';

        task.errorCount = 0;
        if (approved) {
          this.logMsg(agent.name, `✅ Task #${task.id} ODOBREN — ide u QA`);
          this.updateTask(task, { status: 'in_qa' });
          this.qaQueue.push(task.id);
        } else if (task.reviewCycles >= MAX_REVIEW_CYCLES) {
          this.logMsg(agent.name, `⚠ Task #${task.id} dostigao ${MAX_REVIEW_CYCLES} review ciklusa — označen kao STUCK`);
          this.updateTask(task, { status: 'stuck', feedback: result.text, feedbackSource: 'reviewer' });
        } else {
          this.logMsg(agent.name, `↩ Task #${task.id}: tražene izmene — vraćam programeru ${task.assignee}`);
          this.updateTask(task, { status: 'needs_fix', feedback: result.text, feedbackSource: 'reviewer' });
        }
      } catch (err) {
        this.handleWorkerError(agent, task, err, this.reviewQueue);
        await sleep(3000);
      }
      this.setAgent(agent, 'idle');
    }
    this.setAgent(agent, 'done');
  }

  // Transient errors requeue; a context-overflow first shrinks the diff, a
  // second overflow (or 3 consecutive errors) marks the task stuck so a
  // permanently failing episode can't spin the queue forever.
  handleWorkerError(agent, task, err, queue) {
    if (err.rateLimited) {
      if (err.cliSessionId) task.resumeSessions = { ...task.resumeSessions, [agent.role]: err.cliSessionId };
      this.pauseForLimit(err.message);
      queue.push(task.id);
      return;
    }
    const contextErr = /prompt is too long|context window|request_too_large|413/i.test(err.message);
    task.errorCount = (task.errorCount || 0) + 1;
    if (contextErr && !task.diffLimit) {
      task.diffLimit = 8000;
      this.logMsg(agent.name, `✗ Task #${task.id}: kontekst prevelik — smanjujem diff na 8k i pokušavam ponovo`);
      queue.push(task.id);
    } else if (contextErr || task.errorCount >= 3) {
      this.logMsg(agent.name, `✗ Task #${task.id}: trajna greška (${task.errorCount}. pokušaj) — STUCK`);
      this.updateTask(task, { status: 'stuck', feedback: `Epizoda nije mogla da se izvrši: ${err.message}` });
    } else {
      this.logMsg(agent.name, `✗ Greška za task #${task.id}: ${err.message} — vraćam u red (${task.errorCount}/3)`);
      queue.push(task.id);
    }
  }

  async qaWorker(agent) {
    while (!this.stopping && !this.allDone()) {
      if (await this.waitIfPaused()) continue;
      const taskId = this.qaQueue.shift();
      if (taskId == null) {
        await sleep(POLL_MS);
        continue;
      }
      const task = this.tasks.find((t) => t.id === taskId);
      task.qaCycles += 1;
      this.setAgent(agent, 'working', task.id);
      this.logMsg(agent.name, `🧪 QA #${task.qaCycles} za task #${task.id}`);

      const prevQa = [...task.history].reverse().find((h) => h.role === 'qa');
      const prevQaBlock = prevQa
        ? `\n\nYOUR PREVIOUS QA REPORT (cycle ${task.qaCycles - 1}) — FIRST re-verify the failures you reported there:\n${prevQa.text.slice(0, 4000)}\n`
        : '';
      const userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}\n\nImplemented and code-review-approved. Programmer summary:\n${task.lastSummary}\n\nChanged files: ${task.changedFiles.join(', ') || '(unknown)'}${prevQaBlock}\n\nVerify this change works. Remember to end with the VERDICT line.`;

      try {
        const result = await this.episode({
          agent, role: 'qa', task, attempt: task.qaCycles,
          system: qaPrompt(agent.name, HARNESS_DIR), userMessage, workspace: task.worktree,
          resumeSessionId: task.resumeSessions?.qa || null,
        });
        if (task.resumeSessions) delete task.resumeSessions.qa;
        task.history.push({ role: 'qa', agent: agent.name, text: result.text, ts: Date.now() });
        const passed = lastVerdict(result.text) === 'PASSED';

        task.errorCount = 0;
        if (passed) {
          if (this.config.requireMergeApproval) {
            this.logMsg(agent.name, `✋ Task #${task.id} prošao QA — čeka TVOJE odobrenje za merge (dugme na kartici)`);
            this.updateTask(task, { status: 'awaiting_merge' });
          } else {
            await this.finalizeTask(task, agent.name);
          }
        } else if (task.qaCycles >= MAX_REVIEW_CYCLES) {
          this.logMsg(agent.name, `⚠ Task #${task.id} pao QA ${MAX_REVIEW_CYCLES} puta — STUCK`);
          this.updateTask(task, { status: 'stuck', feedback: result.text, feedbackSource: 'qa' });
        } else {
          this.logMsg(agent.name, `❌ Task #${task.id} pao QA — vraćam programeru na popravku`);
          this.updateTask(task, { status: 'needs_fix', feedback: result.text, feedbackSource: 'qa' });
        }
      } catch (err) {
        this.handleWorkerError(agent, task, err, this.qaQueue);
        await sleep(3000);
      }
      this.setAgent(agent, 'idle');
    }
    this.setAgent(agent, 'done');
  }

  // -------------------------------------------------------------- finish
  async finishRun() {
    if (this.phase !== 'running') return;

    // Final integration QA: individual tasks passed, but do the merged parts
    // work TOGETHER? (Skipped in PR mode — main is not updated there.)
    if (!this.stopping && this.config.finalQa !== false && !this.config.prMode &&
        this.integrationRounds < 2 && this.tasks.some((t) => t.status === 'done')) {
      this.integrationRounds += 1;
      const verdict = await this.runIntegrationQa();
      if (!verdict.passed) {
        const id = Math.max(...this.tasks.map((t) => t.id)) + 1;
        this.tasks.push({
          id,
          title: `Integracione popravke (runda ${this.integrationRounds})`,
          description: `Završni integracioni QA celog projekta je pao. Popravi probleme iz izveštaja.\n\nOriginalni cilj:\n${this.goal}`,
          size: 'M', dependsOn: [], status: 'needs_fix',
          assignee: null, assigneeId: null, pinnedTo: null,
          attempts: 0, reviewCycles: 0, qaCycles: 0,
          feedback: verdict.report, feedbackSource: 'qa',
          lastSummary: null, changedFiles: [], usage: emptyUsage(),
          worktree: null, branch: null, history: [],
        });
        this.emit('task_update', { task: this.tasks[this.tasks.length - 1] });
        this.logMsg('Orkestrator', `🔧 Integracioni QA pao — otvoren popravni task #${id}, tim nastavlja`);
        this.resumeRun();
        return;
      }
    }

    this.finishedAt = Date.now();

    const done = this.tasks.filter((t) => t.status === 'done').length;
    const stuck = this.tasks.filter((t) => t.status === 'stuck');
    const mins = ((this.finishedAt - this.startedAt) / 60000).toFixed(1);
    const u = this.totalUsage;

    const summaryLines = this.tasks.map((t) =>
      `#${t.id} [${t.status.toUpperCase()}] ${t.title} — ${t.assignee || '—'}, review ciklusa: ${t.reviewCycles}, QA: ${t.qaCycles}${t.usage.costUsd ? `, ~$${t.usage.costUsd.toFixed(2)}` : ''}`
    );
    const summary =
      `Agent Harness — run završen za ${mins} min.\n` +
      `Taskova završeno: ${done}/${this.tasks.length}${stuck.length ? `, zaglavljeno: ${stuck.length}` : ''}\n` +
      (u.calls ? `Potrošnja: ${fmtTok(u.input + u.cacheRead + u.cacheWrite)} in / ${fmtTok(u.output)} out (${u.calls} poziva), ~$${u.costUsd.toFixed(2)}\n` : '') +
      '\n' + summaryLines.join('\n') +
      `\n\nWorkspace: ${this.config.workspacePath}`;

    this.logMsg('Orkestrator', this.stopping ? 'Run zaustavljen.' : `Svi taskovi obrađeni (${done}/${this.tasks.length} done)${u.costUsd ? ` — ukupno ~$${u.costUsd.toFixed(2)}` : ''}.`);
    this.phase = 'finished';
    this.emit('run_finished', { summary, done, total: this.tasks.length, stuck: stuck.length, usage: u, state: this.state() });

    await this.persistRun(summary, done, stuck.length);
    await this.deleteSnapshot(); // run is over — nothing to resume anymore

    if (this.config.notifyEmail && !this.stopping) {
      try {
        await sendEmail({
          to: this.config.notifyEmail,
          subject: stuck.length
            ? `⚠ Agent Harness: ${done}/${this.tasks.length} završeno, ${stuck.length} ZAGLAVLJENO`
            : `✅ Agent Harness: ${done}/${this.tasks.length} taskova završeno`,
          text: summary,
        });
        this.logMsg('Orkestrator', `📧 Email notifikacija poslata na ${this.config.notifyEmail}`);
      } catch (err) {
        this.logMsg('Orkestrator', `📧 Slanje emaila nije uspelo: ${err.message}`);
      }
    }
  }

  async runIntegrationQa() {
    const agent = this.agents.find((a) => a.role === 'qa') || this.agents[0];
    this.setAgent(agent, 'working', null);
    this.logMsg(agent.name, '🧪 ZAVRŠNI integracioni QA — proveravam da li ceo projekat radi kao celina…');
    try {
      const taskList = this.tasks
        .map((t) => `#${t.id} [${t.status}] ${t.title}`)
        .join('\n');
      const userMessage =
        `PROJECT GOAL:\n${this.goal}\n\nCompleted tasks (already merged into ${this.mainBranch}):\n${taskList}` +
        '\n\nVerify the whole project now. Remember to end with the VERDICT line.' +
        (await this.notesBlock());
      const result = await this.episode({
        agent, role: 'qa', task: { id: 0, title: `Integracija: ${this.goal.slice(0, 60)}` }, attempt: this.integrationRounds,
        system: integrationQaPrompt(agent.name, HARNESS_DIR), userMessage,
        workspace: this.config.workspacePath,
      });
      const passed = lastVerdict(result.text) === 'PASSED';
      this.logMsg(agent.name, passed ? '✅ Integracioni QA PROŠAO — projekat radi kao celina' : '❌ Integracioni QA PAO — otvaram popravni task');
      this.setAgent(agent, 'idle');
      return { passed, report: result.text };
    } catch (err) {
      this.setAgent(agent, 'idle');
      this.logMsg(agent.name, `⚠ Integracioni QA nije mogao da se izvrši (${err.message}) — preskačem`);
      return { passed: true, report: '' };
    }
  }

  // ------------------------------------------ live snapshot (crash resume)
  // The whole run state lives in memory; snapshot it to disk on every task
  // change so an interrupted run (server restart, crash) can be resumed.
  scheduleSnapshot() {
    // Solo runs are one short episode — not worth crash-resume machinery.
    if (!this.runId || this.phase !== 'running' || this.soloRole) return;
    clearTimeout(this._snapTimer);
    this._snapTimer = setTimeout(() => this.saveSnapshot().catch(() => {}), 1500);
  }

  async saveSnapshot() {
    if (!this.runId || this.phase !== 'running') return;
    const { apiKey, ...cfg } = this.config || {};
    const snap = {
      v: 1,
      savedAt: Date.now(),
      runId: this.runId,
      goal: this.goal,
      phase: this.phase,
      startedAt: this.startedAt,
      mainBranch: this.mainBranch,
      integrationRounds: this.integrationRounds,
      steerings: this.steerings,
      totalUsage: this.totalUsage,
      config: cfg,
      agents: this.agents.map(({ id, name, role, usage }) => ({ id, name, role, usage })),
      tasks: this.tasks,
      log: this.log.slice(-300),
    };
    await fs.mkdir(ACTIVE_DIR, { recursive: true });
    const file = path.join(ACTIVE_DIR, `${this.runId}.json`);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(snap));
    await fs.rename(tmp, file);
  }

  async deleteSnapshot() {
    clearTimeout(this._snapTimer);
    if (!this.runId) return;
    await fs.unlink(path.join(ACTIVE_DIR, `${this.runId}.json`)).catch(() => {});
  }

  // Rebuild a run from a snapshot after a server restart and start workers.
  async restore(snap, apiKey) {
    if (this.phase === 'running' || this.phase === 'planning') {
      throw new Error('Ova sesija je zauzeta — otvori novi tab pa nastavi run u njemu');
    }
    try { await fs.access(snap.config.workspacePath); } catch {
      throw new Error(`Workspace više ne postoji: ${snap.config.workspacePath}`);
    }

    this.reset();
    this.config = { ...snap.config, apiKey };
    this.goal = snap.goal;
    this.runId = snap.runId;
    this.startedAt = snap.startedAt || Date.now();
    this.mainBranch = snap.mainBranch || 'master';
    this.integrationRounds = snap.integrationRounds || 0;
    this.steerings = snap.steerings || [];
    this.totalUsage = { ...emptyUsage(), ...snap.totalUsage };
    this.log = snap.log || [];
    this.agents = (snap.agents || []).map((a) => ({
      ...a, status: 'idle', currentTaskId: null, usage: { ...emptyUsage(), ...a.usage }, lastText: '',
    }));
    this.tasks = snap.tasks || [];

    for (const t of this.tasks) {
      t.errorCount = 0;
      // A worktree lost with the crash → the task restarts on a fresh base.
      if (t.worktree) {
        try { await fs.access(t.worktree); } catch {
          this.logMsg('Orkestrator', `⚠ Task #${t.id}: radna kopija je nestala u prekidu — task kreće ispočetka`);
          t.worktree = null; t.branch = null; t.changedFiles = [];
          if (!['done', 'stuck'].includes(t.status)) {
            t.status = 'queued'; t.feedback = null; t.assignee = null; t.assigneeId = null;
          }
          continue;
        }
      }
      // Mid-flight statuses → back to an actionable state / queue. A queued
      // task must be unclaimed (assigneeId blocks claimableBy) — fixes keep
      // their owner so the same programmer (same id after restore) continues.
      if (t.status === 'coding') {
        t.status = t.feedback ? 'needs_fix' : 'queued';
        if (t.status === 'queued') { t.assignee = null; t.assigneeId = null; }
      } else if (t.status === 'queued') {
        t.assignee = null; t.assigneeId = null;
      } else if (t.status === 'in_review') this.reviewQueue.push(t.id);
      else if (t.status === 'in_qa') this.qaQueue.push(t.id);
    }

    this.phase = 'running';
    this.emit('run_started', { state: this.state() });
    const open = this.tasks.filter((t) => !['done', 'stuck'].includes(t.status)).length;
    this.logMsg('Orkestrator', `⏯ Run obnovljen iz snimka (${snap.runId}) — ${open} taskova za dovršavanje. Radne kopije i Claude Code sesije su sačuvane.`);
    this.startWorkers();
    this.scheduleSnapshot();
  }

  async persistRun(summary, done, stuck) {
    try {
      await fs.mkdir(RUNS_DIR, { recursive: true });
      const record = {
        id: this.runId,
        goal: this.goal,
        startedAt: this.startedAt,
        finishedAt: this.finishedAt,
        done,
        total: this.tasks.length,
        stuck,
        usage: this.totalUsage,
        summary,
        workspacePath: this.config.workspacePath,
        models: this.config.models,
        tasks: this.tasks,
        log: this.log,
      };
      await fs.writeFile(path.join(RUNS_DIR, `${this.runId}.json`), JSON.stringify(record, null, 1));
      this.logMsg('Orkestrator', `💾 Run sačuvan u istoriju (${this.runId})`);
    } catch (err) {
      this.logMsg('Orkestrator', `💾 Snimanje istorije nije uspelo: ${err.message}`);
    }
  }
}

// The verdict is the LAST "VERDICT: X" occurrence in the reply. Matching the
// keyword anywhere (.test) is wrong: agents often mention "VERDICT: PASSED"
// in their reasoning (e.g. quoting the instructions) before concluding FAILED.
function lastVerdict(text) {
  const matches = [...String(text).matchAll(/VERDICT:\s*([A-Z_]+)/gi)];
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : null;
}

function normalizeDeps(deps, selfId, taskCount) {
  if (!Array.isArray(deps)) return [];
  return [...new Set(deps.map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= taskCount && d !== selfId);
}

// Extract the task array from the planner's reply. Robust to: fenced or bare
// JSON, prose around it, an object wrapper ({ "tasks": [...] } / { "plan": [...] }),
// and stray `[...]` inside prose (we try every bracket span, not just the widest).
function parsePlanText(text) {
  const src = String(text);
  const fenced = [...src.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  // Try fenced blocks first (last one wins — the model's final answer), then raw.
  for (const c of [...fenced.reverse(), src]) {
    for (const span of balancedSpans(c)) {
      const tasks = tasksFromJson(span);
      if (tasks) return tasks;
    }
  }
  return null;
}

// Yield every balanced [...] and {...} substring, longest-first so the full
// plan array is tried before any nested fragment (e.g. a lone "dependsOn": [1]).
function balancedSpans(s) {
  const spans = [];
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== open) continue;
      let depth = 0, inStr = false, esc = false;
      for (let j = i; j < s.length; j++) {
        const ch = s[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = !inStr;
        else if (!inStr && ch === open) depth++;
        else if (!inStr && ch === close && --depth === 0) { spans.push(s.slice(i, j + 1)); break; }
      }
    }
  }
  return spans.sort((a, b) => b.length - a.length);
}

// Parse a JSON string into a normalized task list, accepting a bare array or an
// object whose first array-valued property holds the tasks. Returns null if not
// a usable task list.
function tasksFromJson(jsonStr) {
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return null; }
  let arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed).find((v) => Array.isArray(v))
      : null;
  if (!Array.isArray(arr)) return null;
  const tasks = arr
    .map((t) => (typeof t === 'string' ? { title: t } : t))
    .filter((t) => t && t.title && String(t.title).trim())
    .map((t) => ({
      title: String(t.title).trim(),
      description: String(t.description || t.title).trim(),
      size: ['S', 'M', 'L'].includes(t.size) ? t.size : 'M',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(Number).filter((d) => Number.isInteger(d) && d > 0) : [],
    }));
  return tasks.length ? tasks : null;
}

function fmtTok(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
