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
import { plannerPrompt, programmerPrompt, reviewerPrompt, qaPrompt, integrationQaPrompt, soloReviewerPrompt, soloQaPrompt, soloAskPrompt } from './roles.js';
import { runCommand } from './tools.js';
import { sendEmail } from './mailer.js';
import { t } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = path.join(process.env.HARNESS_DATA_DIR || path.join(__dirname, '..', 'data'), 'runs');
// Live snapshot of every active run — enables resume after a server restart.
export const ACTIVE_DIR = path.join(process.env.HARNESS_DATA_DIR || path.join(__dirname, '..', 'data'), 'active');
const HARNESS_DIR = path.join(__dirname, '..');
const NOTES_FILE = 'HARNESS-NOTES.md';

const KIMI_URL = 'https://api.kimi.com/coding/v1/messages'; // Anthropic-compatible
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
      .then(() => this.logMsg(t('Orchestrator'), t('📧 Email sent to {to}: {subject}', { to, subject })))
      .catch((err) => this.logMsg(t('Orchestrator'), t('📧 Sending the email failed: {msg}', { msg: err.message })));
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
    this.integrationStatus = null;   // null | 'passed' | 'failed' (last verdict)
    this.integrationReport = null;
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
      agents: this.agents.map((a) => ({
        id: a.id, name: a.name, role: a.role, status: a.status, currentTaskId: a.currentTaskId, usage: a.usage,
        lastText: (a.lastText || '').slice(0, 4000),
        // last 40 entries, each trimmed — full text still streams live via agent_activity
        activity: (a.activity || []).slice(-40).map((e) => ({ ...e, text: e.text ? String(e.text).slice(0, 800) : e.text })),
      })),
      tasks: this.tasks,
      log: this.log.slice(-200),
      config: this.config && {
        programmers: this.config.programmers,
        reviewers: this.config.reviewers,
        qa: this.config.qa,
        models: this.config.models,
        engine: this.config.engine,
        engines: this.config.engines || null,
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

  // Engines can be mixed per role (e.g. Claude team lead + Kimi programmers).
  engineFor(role) {
    return (this.config?.engines && this.config.engines[role]) || this.config?.engine || 'api';
  }
  roleIsMock(role) {
    return this.engineFor(role) === 'api' && !this.config?.apiKey;
  }

  engineLabel() {
    const L = (e) => e === 'claude-code' ? 'Claude Code' : e === 'kimi' ? 'Kimi' : (this.config?.apiKey ? 'Claude API' : 'MOCK');
    const e = { p: this.engineFor('programmer'), r: this.engineFor('reviewer'), q: this.engineFor('qa') };
    if (e.p === e.r && e.r === e.q) {
      return L(e.p) + (e.p === 'claude-code' || e.p === 'kimi' ? t(' (subscription)') : '');
    }
    return t('mix — programmers: {p}, lead: {r}, QA: {q}', { p: L(e.p), r: L(e.r), q: L(e.q) });
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
      throw new Error(t('Planning or a run is already in progress'));
    }
    this.reset();
    this.config = config;
    this.goal = goal;
    this.runId = new Date().toISOString().replace(/[:.]/g, '-');
    this.setPhase('planning');

    await this.prepareWorkspace();
    this.logMsg(t('Orchestrator'), t('Workspace ready: {ws} (branch: {branch}) — engine: {engine}', { ws: config.workspacePath, branch: this.mainBranch, engine: this.engineLabel() }));

    // Planner runs async; result arrives via SSE (plan_ready / plan_failed).
    this._runPlanner(null);
  }

  replan(feedback) {
    if (this.phase !== 'awaiting_approval') throw new Error(t('No plan is awaiting approval'));
    this.setPhase('planning');
    this._runPlanner(feedback);
  }

  async _runPlanner(feedback) {
    const name = 'TeamLead-1';
    this.logMsg(name, feedback ? t('🧠 Drafting a new plan with your objections…') : t('🧠 Analyzing the goal and drafting the task plan…'));

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
        if (this.roleIsMock('reviewer')) {
          return runMockEpisode({ role: 'planner', task: { id: 0, title: this.goal }, attempt: 1, workspace: this.config.workspacePath, onEvent });
        }
        const planEngine = this.engineFor('reviewer');
        if (planEngine === 'claude-code') {
          return runClaudeCodeEpisode({ model, system: plannerPrompt(name), userMessage: msg, workspace: this.config.workspacePath, onEvent, resumeSessionId });
        }
        if (planEngine === 'kimi') {
          return runAgentEpisode({ apiKey: this.config.kimiKey, baseUrl: KIMI_URL, model, system: plannerPrompt(name), userMessage: msg, workspace: this.config.workspacePath, onEvent });
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
            '{ "title", "description", "size", "dependsOn", "acceptance" } objects — and NOTHING else before or after it.';
        if (attempt > 1) this.logMsg(name, t('⚠ The plan was not valid JSON — asking again for JSON only (attempt {attempt}/3)…', { attempt }));

        const result = await runPlanEpisode(msg, sessionId);
        sessionId = result.sessionId || sessionId;
        this.addUsage(null, null, result.usage, model);
        if (this.stopping || this.phase !== 'planning') return; // cancelled meanwhile
        tasks = parsePlanText(result.text);
      }
      if (!tasks) throw new Error(t('The planner did not return a valid JSON task plan even after 3 attempts'));

      this.proposal = tasks;
      this.phase = 'awaiting_approval';
      this.logMsg(name, t('📋 Plan ready: {n} tasks — awaiting your approval.', { n: tasks.length }));
      this.emit('plan_ready', { state: this.state() });
    } catch (err) {
      this.logMsg(t('Orchestrator'), t('✗ Planning failed: {msg}', { msg: err.message }));
      this.phase = 'idle';
      this.emit('plan_failed', { error: err.message, state: this.state() });
      this.notify(
        t('✗ Agentura: planning failed'),
        t('Planning for goal "{goal}" failed.\n\nError: {msg}\n\nStart planning again from the UI.', { goal: this.goal.slice(0, 120), msg: err.message.slice(0, 500) })
      );
    }
  }

  // ---------------------------------------------------------------- start
  async approve(taskInputs) {
    if (this.phase !== 'awaiting_approval') throw new Error(t('No plan is awaiting approval'));
    const inputs = (taskInputs && taskInputs.length ? taskInputs : this.proposal)
      .filter((t) => t && t.title && String(t.title).trim());
    if (!inputs.length) throw new Error(t('The plan has no tasks'));

    const config = this.config;
    this.stopping = false;
    this.startedAt = Date.now();

    // Create agents
    let id = 0;
    for (let i = 0; i < config.programmers; i++)
      this.agents.push({ id: ++id, name: t('Programmer-{n}', { n: i + 1 }), role: 'programmer', status: 'idle', currentTaskId: null, usage: emptyUsage(), lastText: '' });
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
      acceptance: normalizeAcceptance(t.acceptance),
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
    this.logMsg(t('Orchestrator'), t('Plan approved — run started: {tasks} tasks, {programmers} programmers, {reviewers} team lead(s), {qa} QA. Engine: {engine}{models}', {
      tasks: this.tasks.length, programmers: config.programmers, reviewers: config.reviewers, qa: config.qa,
      engine: this.engineLabel(),
      models: this.isMock ? '' : t(' — models: {p}/{r}/{q}', { p: m.programmer || '(default)', r: m.reviewer || '(default)', q: m.qa || '(default)' }),
    }));
    this.startWorkers();
    this.saveSnapshot().catch(() => {});
  }

  // ------------------------------------------------- solo (single-agent) run
  // One agent, one episode, no plan/review/QA pipeline: a lone programmer
  // implements a task, a team lead reviews/analyzes, or a QA verifies.
  async quickRun(config, role, instruction) {
    if (this.phase === 'planning' || this.phase === 'running') {
      throw new Error(t('Planning or a run is already in progress'));
    }
    this.reset();
    this.config = config;
    this.goal = instruction;
    this.soloRole = role;
    this.runId = new Date().toISOString().replace(/[:.]/g, '-');
    this.startedAt = Date.now();

    await this.prepareWorkspace();

    const names = { programmer: t('Programmer-{n}', { n: 1 }), reviewer: 'TeamLead-1', qa: 'QA-1', ask: 'TeamLead-1' };
    // 'ask' runs as the team lead (reviewer engine/model) but only ANSWERS.
    const agentRole = role === 'ask' ? 'reviewer' : role;
    const agent = { id: 1, name: names[role], role: agentRole, status: 'idle', currentTaskId: null, usage: emptyUsage(), lastText: '' };
    this.agents = [agent];
    const statusFor = { programmer: 'coding', reviewer: 'in_review', qa: 'in_qa', ask: 'in_review' };
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
    const roleLabel = { programmer: t('programmer'), reviewer: t('team lead (review/analysis)'), qa: 'QA', ask: t('team lead (answer to a question)') }[role];
    this.logMsg(t('Orchestrator'), t('⚡ Solo run: {role} — engine: {engine}, workspace: {ws}', { role: roleLabel, engine: this.engineLabel(), ws: config.workspacePath }));
    this._runSolo(agent, this.tasks[0], role); // fires async; result arrives via SSE
  }

  async _runSolo(agent, task, role) {
    const ws = this.config.workspacePath;
    this.setAgent(agent, 'working', task.id);
    try {
      const system =
        role === 'programmer' ? programmerPrompt(agent.name) :
        role === 'reviewer' ? soloReviewerPrompt(agent.name) :
        role === 'ask' ? soloAskPrompt(agent.name) :
        soloQaPrompt(agent.name, HARNESS_DIR);
      let userMessage =
        role === 'programmer' ? `Task: ${this.goal}\n\nImplement this task in the workspace now.` :
        role === 'reviewer' ? `REVIEW/ANALYSIS REQUEST:\n${this.goal}\n\nInspect the repository and produce the review now.` :
        role === 'ask' ? `QUESTION FROM THE PRODUCT OWNER:\n${this.goal}\n\nExplore the repository as needed and answer the question now.` :
        `QA REQUEST:\n${this.goal}\n\nVerify this in the project now. Remember to end with the VERDICT line.`;
      userMessage += await this.notesBlock();

      const result = await this.episode({ agent, role: agent.role, task, system, userMessage, attempt: 1, workspace: ws });
      task.history.push({ role, agent: agent.name, text: result.text, ts: Date.now() });

      let failed = false;
      if (role === 'programmer') {
        // Solo programmer works directly on the main branch — commit the result.
        const changed = (await runCommand(ws, 'git status --porcelain')).trim();
        if (changed && !changed.startsWith('ERROR')) {
          await runCommand(ws, `git add -A && git -c user.email=harness@local -c user.name="Agentura" commit -qm ${JSON.stringify(`solo: ${this.goal.slice(0, 70)}`)}`);
          task.changedFiles = changed.split('\n').map((l) => l.slice(2).trim()).filter(Boolean);
          this.logMsg(agent.name, t('✓ Changes committed ({n} files)', { n: task.changedFiles.length }));
        } else {
          this.logMsg(agent.name, t('⚠ No file changes — the agent replied without code'));
        }
      }
      if (role === 'qa') {
        failed = lastVerdict(result.text) === 'FAILED';
        this.logMsg(agent.name, failed ? t('❌ VERDICT: FAILED — details in the report') : '✅ VERDICT: PASSED');
      }
      this.updateTask(task, { status: 'done', lastSummary: result.text, feedback: failed ? result.text : null, feedbackSource: failed ? 'qa' : null });
      this.setAgent(agent, 'done');
      await this._finishSolo(role, result.text, failed);
    } catch (err) {
      this.logMsg(agent.name, t('✗ Solo episode failed: {msg}', { msg: err.message }));
      this.updateTask(task, { status: 'stuck', feedback: err.message });
      this.setAgent(agent, 'idle');
      await this._finishSolo(role, t('Episode failed: {msg}', { msg: err.message }), true);
    }
  }

  async _finishSolo(role, report, failed) {
    this.finishedAt = Date.now();
    const mins = ((this.finishedAt - this.startedAt) / 60000).toFixed(1);
    const u = this.totalUsage;
    const roleLabel = { programmer: t('programmer'), reviewer: 'team lead', qa: 'QA', ask: t('team lead answer') }[role];
    const summary = t('Agentura — solo {role} finished in {mins} min.{cost}\n\nRequest: {goal}\n\nREPORT:\n{report}\n\nWorkspace: {ws}', {
      role: roleLabel, mins, cost: u.costUsd ? ` (~$${u.costUsd.toFixed(2)})` : '',
      goal: this.goal, report, ws: this.config.workspacePath,
    });
    this.phase = 'finished';
    this.logMsg(t('Orchestrator'),failed ? t('Solo run finished — FAILED (see the report).') : t('Solo run finished.'));
    this.emit('run_finished', { summary, done: failed ? 0 : 1, total: 1, stuck: failed ? 1 : 0, usage: u, state: this.state() });
    await this.persistRun(summary, failed ? 0 : 1, failed ? 1 : 0);
    if (this.config.notifyEmail) {
      try {
        await sendEmail({
          to: this.config.notifyEmail,
          subject: `${failed ? '❌' : '✅'} ${t('Agentura (solo {role}): {goal}', { role: roleLabel, goal: this.goal.slice(0, 60) })}`,
          text: summary.slice(0, 8000),
        });
        this.logMsg(t('Orchestrator'), t('📧 Report sent to {to}', { to: this.config.notifyEmail }));
      } catch (err) {
        this.logMsg(t('Orchestrator'), t('📧 Sending the email failed: {msg}', { msg: err.message }));
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
        this.logMsg(t('Orchestrator'), `FATAL: ${err.message}`);
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
    for (const task of this.tasks) {
      if (!resolved.has(task.id)) {
        this.logMsg(t('Orchestrator'), t('⚠ Task #{id} is part of a dependency cycle — its dependencies were removed.', { id: task.id }));
        task.dependsOn = [];
      }
    }
  }

  // ------------------------------------------------------ steering & pause
  steer(taskId, message) {
    if (!['running', 'finished'].includes(this.phase)) throw new Error(t('Messages to the team only apply once the run starts'));
    const msg = String(message || '').trim();
    if (!msg) throw new Error(t('Empty message'));
    if (taskId) {
      const task = this.tasks.find((x) => x.id === taskId);
      if (!task) throw new Error(t('Task #{id} does not exist', { id: taskId }));
    }
    this.steerings.push({ taskId: taskId || null, message: msg.slice(0, 2000), ts: Date.now() });
    this.logMsg(t('You'), `📣 ${taskId ? `[task #${taskId}] ` : t('[whole team] ')}${msg.slice(0, 200)}`);
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
    this.logMsg(t('Orchestrator'), t('⏸ Plan limit reached — pausing all episodes for 15 min. ({msg})', { msg: (msg || '').slice(0, 120) }));
    this.emit('phase_change', { state: this.state() });
    const until = new Date(this.pausedUntil).toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' });
    this.notify(
      t('⏸ Agentura: plan limit — run paused'),
      t('Run "{goal}" is paused because the Claude plan limit was reached.\n\nMessage: {msg}\n\nIt resumes automatically at {until} (then re-checks every 15 min until the limit resets).\nIf you have already topped up the limit/tokens, click "▶ Resume now" in the UI — you do not have to wait.\n\nWorkspace: {ws}', {
        goal: this.goal.slice(0, 120), msg: (msg || '').slice(0, 300), until, ws: this.config.workspacePath,
      })
    );
  }

  // User clicked "▶ Resume now" — cut the limit pause short.
  resumePause() {
    if (this.pausedUntil <= Date.now()) throw new Error(t('The run is not paused'));
    this.pausedUntil = 0;
    this.logMsg(t('Orchestrator'), t('▶ Manual resume — pause cut short, the team continues immediately.'));
    this.emit('phase_change', { state: this.state() });
  }

  async waitIfPaused() {
    if (this.pausedUntil <= Date.now()) return false;
    await sleep(5000);
    // guard on pausedUntil !== 0 so a manual resumePause() doesn't double-log
    if (this.pausedUntil && this.pausedUntil <= Date.now()) {
      this.pausedUntil = 0;
      this.logMsg(t('Orchestrator'), t('▶ Pause expired — resuming work.'));
      this.emit('phase_change', { state: this.state() });
    }
    return true;
  }

  // ------------------------------------------------------ retry stuck task
  retryTask(taskId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(t('Task #{id} does not exist', { id: taskId }));
    if (task.status !== 'stuck') throw new Error(t('Task #{id} is not stuck (status: {status})', { id: taskId, status: task.status }));

    // Fresh budget of review/QA cycles; unclaim it so the first free
    // programmer (ideally a different one — fresh perspective) takes it.
    task.reviewCycles = 0;
    task.qaCycles = 0;
    const status = task.attempts > 0 && task.feedback ? 'needs_fix' : 'queued';
    this.updateTask(task, { status, assignee: null, assigneeId: null, pinnedTo: null });
    this.logMsg(t('Orchestrator'), t('↻ Task #{id} put back to work ({status}) — the first free programmer takes it', { id: task.id, status }));

    if (!this.workersRunning) this.resumeRun();
  }

  // Manual drag&drop assignment: pin the task to a specific programmer.
  assignTask(taskId, agentId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(t('Task #{id} does not exist', { id: taskId }));
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent || agent.role !== 'programmer') throw new Error(t('A task can only be assigned to a programmer'));
    if (!['queued', 'needs_fix', 'stuck'].includes(task.status)) {
      throw new Error(t('Task #{id} is in status "{status}" — only a queued, needs-fix or stuck task can be assigned manually', { id: taskId, status: task.status }));
    }
    if (task.status === 'stuck') {
      task.reviewCycles = 0;
      task.qaCycles = 0;
    }
    const status = task.status === 'stuck' ? (task.feedback ? 'needs_fix' : 'queued') : task.status;
    this.updateTask(task, { status, pinnedTo: agent.id, assignee: agent.name, assigneeId: agent.id });
    this.logMsg(t('Orchestrator'), t('👉 Task #{id} manually assigned to programmer {name} — they take it as soon as they are free', { id: task.id, name: agent.name }));

    if (!this.workersRunning) this.resumeRun();
  }

  resumeRun() {
    if (this.workersRunning) return;
    this.phase = 'running';
    this.stopping = false;
    this.finishedAt = null;
    for (const a of this.agents) this.setAgent(a, 'idle');
    this.emit('run_started', { state: this.state() });
    this.logMsg(t('Orchestrator'), t('Run resumed.'));
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
      this.logMsg(t('Orchestrator'), `git clone: ${out.slice(0, 300)}`);
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
      this.logMsg(t('Orchestrator'), t('Found uncommitted changes — saved as a "pre-harness snapshot" commit.'));
    }

    // Project memory: notes file agents read every episode and append lessons
    // to. merge=union so parallel appends from task branches never conflict.
    const notesPath = path.join(ws, NOTES_FILE);
    try { await fs.access(notesPath); } catch {
      await fs.writeFile(notesPath, t('# Project notes (harness memory)') + '\n');
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
      if (/fatal:|ERROR/.test(out)) throw new Error(t('git worktree add failed: {out}', { out: out.slice(0, 300) }));
      task.worktree = wt;
      task.branch = branch;
      this.logMsg(t('Orchestrator'), t('🌿 Task #{id}: working copy on branch {branch}', { id: task.id, branch }));
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
      // A dirty MAIN workspace (e.g. an artifact regenerated by a QA episode)
      // makes git refuse ANY merge touching that file ("local changes would be
      // overwritten") — which used to masquerade as a merge conflict and bounce
      // the task back to the programmer forever. Snapshot it first.
      const dirty = (await runCommand(ws, 'git status --porcelain')).trim();
      if (dirty && !dirty.startsWith('ERROR')) {
        await runCommand(ws, 'git add -A && git -c user.email=harness@local -c user.name=harness commit -qm "mid-run workspace snapshot (pre-merge)"');
        this.logMsg(t('Orchestrator'), t('📸 Found uncommitted changes in the main folder ({n} files) — saved before the merge.', { n: dirty.split('\n').length }));
      }
      await runCommand(
        task.worktree,
        `git add -A && git -c user.email=harness@local -c user.name="Agentura" commit -qm ${JSON.stringify(`task #${task.id}: ${task.title}`)} || true`
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
        this.logMsg(byName, t('🎉 Task #{id} FINISHED — branch pushed and PR opened', { id: task.id }));
        this.updateTask(task, { status: 'done' });
        return;
      }
      this.logMsg(byName, t('⚠ Task #{id}: push/PR failed — doing a local merge instead', { id: task.id }));
    }
    const merge = await this.commitAndMerge(task);
    if (merge.ok) {
      this.logMsg(byName, t('🎉 Task #{id} PASSED — merged into {branch}, task FINISHED', { id: task.id, branch: this.mainBranch }));
      this.updateTask(task, { status: 'done' });
    } else {
      this.logMsg(byName, t('⚔ Task #{id}: merge conflict — returning it to the programmer on a fresh base', { id: task.id }));
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
        `git add -A && git -c user.email=harness@local -c user.name="Agentura" commit -qm ${JSON.stringify(`task #${task.id}: ${task.title}`)} || true`
      );
      const push = await runCommand(task.worktree, `git push -u origin ${JSON.stringify(task.branch)}`);
      if (/fatal:|error:|exit code/i.test(push)) {
        this.logMsg(t('Orchestrator'), `git push: ${push.slice(0, 200)}`);
        return false;
      }
      const body = t('Automatic PR from Agentura.\n\nTask: {title}\n\n{summary}', { title: task.title, summary: (task.lastSummary || '').slice(0, 1500) });
      const pr = await runCommand(
        task.worktree,
        `gh pr create --head ${JSON.stringify(task.branch)} --title ${JSON.stringify(`task #${task.id}: ${task.title}`)} --body ${JSON.stringify(body)} 2>&1`
      );
      const url = (pr.match(/https:\/\/\S+/) || [])[0];
      if (url) this.logMsg(t('Orchestrator'), t('🔗 PR opened: {url}', { url }));
      else this.logMsg(t('Orchestrator'), `gh pr create: ${pr.slice(0, 200)}`);
      await runCommand(this.config.workspacePath, `git worktree remove --force ${JSON.stringify(task.worktree)}; true`);
      task.worktree = null;
      return true;
    });
    return this._gitLock;
  }

  // User clicked "✓ Merge" on an awaiting_merge card
  async approveMerge(taskId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(t('Task #{id} does not exist', { id: taskId }));
    if (task.status !== 'awaiting_merge') throw new Error(t('Task #{id} is not awaiting merge (status: {status})', { id: taskId, status: task.status }));
    await this.finalizeTask(task, t('You'));
  }

  stop() {
    if (this.phase === 'running') {
      this.stopping = true;
      this.logMsg(t('Orchestrator'), t('Stop requested — workers will halt after current episodes.'));
    } else if (this.phase === 'planning' || this.phase === 'awaiting_approval') {
      this.stopping = true;
      this.logMsg(t('Orchestrator'), t('Planning cancelled.'));
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
        t('⚠ Agentura: {n} task(s) STUCK', { n: list.length }),
        t('Run "{goal}" has newly-stuck tasks:', { goal: this.goal.slice(0, 120) }) + '\n\n' +
        list.map((s) => `#${s.id} ${s.title}\n` + t('  Reason: {reason}', { reason: s.feedback || t('(no details)') })).join('\n\n') +
        '\n\n' + t('The run continues with the remaining tasks. You can put stuck tasks back to work with the ↻ Retry button in the UI.') + '\n' +
        `Workspace: ${this.config.workspacePath}`
      );
    }, 20_000);
  }

  // Per-agent live activity feed (tool calls, code writes, command output,
  // narration) — bounded ring buffer; streamed live and included in state()
  // so the UI rehydrates on tab switch / reconnect.
  pushActivity(agent, entry) {
    if (!entry) return;
    const e = { ...entry, ts: Date.now() };
    // collapse consecutive identical text entries (engines re-emit the same text)
    const buf = (agent.activity = agent.activity || []);
    const last = buf[buf.length - 1];
    if (last && last.kind === e.kind && last.text === e.text && last.file === e.file) return;
    buf.push(e);
    if (buf.length > 80) buf.splice(0, buf.length - 80);
    this.emit('agent_activity', { agentId: agent.id, entry: e });
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
      if (e.type === 'tool_call') {
        this.logMsg(agent.name, `🔧 ${e.tool} ${JSON.stringify(e.input).slice(0, 160)}`);
        this.pushActivity(agent, activityFromTool(e.tool, e.input));
      }
      if (e.type === 'tool_result' && String(e.output || '').trim()) {
        // Only command/test output is interesting in the live feed — results of
        // Read/Glob/Write are file contents / "ok" acks and would flood it.
        const T = String(e.tool || '').toLowerCase();
        const cmdLike = !e.tool || /bash|run_command|command|exec|shell/.test(T);
        if (cmdLike || e.isError) {
          this.pushActivity(agent, { kind: 'result', text: String(e.output).slice(0, 1500), error: !!e.isError });
        }
      }
      if (e.type === 'nudge') {
        this.logMsg(agent.name, t('⚠ Submitted empty work (no file changes) — reminding it to implement (attempt {attempt}/2)', { attempt: e.attempt }));
        this.pushActivity(agent, { kind: 'note', text: t('⚠ Empty work — reminder to implement (attempt {attempt}/2)', { attempt: e.attempt }) });
      }
      if (e.type === 'agent_text') {
        agent.lastText = e.text;
        this.emit('agent_text', { agentId: agent.id, text: e.text.slice(0, 4000) });
        this.pushActivity(agent, { kind: 'text', text: e.text.slice(0, 1500) });
      }
    };
    let result;
    const model = this.config.models[role] || this.config.models.programmer;
    const engine = this.engineFor(role);
    const gitHasChanges = async () => (await runCommand(ws, 'git status --porcelain')).trim().length > 0;
    if (this.roleIsMock(role)) {
      result = await runMockEpisode({ role, task, attempt, workspace: ws, onEvent });
    } else if (engine === 'claude-code') {
      result = await runClaudeCodeEpisode({
        model, system, userMessage, workspace: ws, onEvent,
        requireChanges: role === 'programmer',
        hasChanges: role === 'programmer' ? gitHasChanges : null,
        resumeSessionId,
      });
    } else if (engine === 'kimi') {
      result = await runAgentEpisode({
        apiKey: this.config.kimiKey, baseUrl: KIMI_URL,
        model, system, userMessage, workspace: ws, onEvent,
        requireChanges: role === 'programmer',
        hasChanges: role === 'programmer' ? gitHasChanges : null,
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
      for (const cand of this.tasks) {
        if (cand.status === 'queued') {
          const stuckDep = cand.dependsOn.find((d) => this.tasks.find((x) => x.id === d)?.status === 'stuck');
          if (stuckDep) {
            this.logMsg(t('Orchestrator'), t('⚠ Task #{id} blocked: dependency #{dep} is stuck', { id: cand.id, dep: stuckDep }));
            this.updateTask(cand, { status: 'stuck', feedback: t('Dependency (task #{dep}) is stuck — this task cannot start. Unstick task #{dep} and then retry this one.', { dep: stuckDep }) });
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
      this.logMsg(agent.name, fixing ? t('▶ Fixing task #{id} ({source} feedback)', { id: task.id, source: task.feedbackSource }) : t('▶ Starting task #{id}: {title}', { id: task.id, title: task.title }));

      try {
        await this.ensureWorktree(task);

        let userMessage;
        if (fixing && task.feedback) {
          const label = { qa: 'QA FAILURE REPORT', merge: 'MERGE CONFLICT REPORT', reviewer: 'REVIEWER FEEDBACK' }[task.feedbackSource] || 'FEEDBACK';
          userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}\n\nYour previous summary:\n${task.lastSummary || '(none)'}\n\n${label} — fix these issues:\n${task.feedback}`;
        } else {
          userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}\n\nImplement this task in the workspace now.`;
        }
        userMessage += acceptanceBlock(task, 'programmer');
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
        this.logMsg(agent.name, t('✓ Task #{id} sent to review ({n} files changed)', { id: task.id, n: files.size }));
      } catch (err) {
        if (err.rateLimited) {
          // Remember the cut-off CLI session so the retry continues the same
          // conversation (--resume) instead of starting the task over.
          if (err.cliSessionId) task.resumeSessions = { ...task.resumeSessions, programmer: err.cliSessionId };
          this.pauseForLimit(err.message);
          this.updateTask(task, { status: fixing ? 'needs_fix' : 'queued' });
        } else {
          this.logMsg(agent.name, t('✗ Error on task #{id}: {msg}', { id: task.id, msg: err.message }));
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
      this.logMsg(agent.name, t('🔍 Review #{cycle} for task #{id}', { cycle: task.reviewCycles, id: task.id }));

      const diff = await this.diffFor(task);
      // Episodes are stateless — hand the reviewer its own previous feedback
      // so cycle N verifies cycle N-1's requests instead of raising new ones.
      const prevReview = [...task.history].reverse().find((h) => h.role === 'reviewer');
      const prevBlock = prevReview
        ? `\n\nYOUR PREVIOUS REVIEW FEEDBACK (cycle ${task.reviewCycles - 1}) — FIRST verify each of these points was addressed; do not raise new minor issues if these are resolved:\n${prevReview.text.slice(0, 4000)}\n`
        : '';
      const userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}${acceptanceBlock(task, 'reviewer')}\n\nProgrammer (${task.assignee}) summary:\n${task.lastSummary}\n\nChanged files: ${task.changedFiles.join(', ') || '(none reported)'}${prevBlock}\n\nDiff:\n\`\`\`\n${diff}\n\`\`\`\n\nReview this change now. Remember to end with the VERDICT line.`;

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
          this.logMsg(agent.name, t('✅ Task #{id} APPROVED — moving on to QA', { id: task.id }));
          this.updateTask(task, { status: 'in_qa' });
          this.qaQueue.push(task.id);
        } else if (task.reviewCycles >= MAX_REVIEW_CYCLES) {
          this.logMsg(agent.name, t('⚠ Task #{id} reached {n} review cycles — marked as STUCK', { id: task.id, n: MAX_REVIEW_CYCLES }));
          this.updateTask(task, { status: 'stuck', feedback: result.text, feedbackSource: 'reviewer' });
        } else {
          this.logMsg(agent.name, t('↩ Task #{id}: changes requested — returning it to programmer {name}', { id: task.id, name: task.assignee }));
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
      this.logMsg(agent.name, t('✗ Task #{id}: context too large — shrinking the diff to 8k and retrying', { id: task.id }));
      queue.push(task.id);
    } else if (contextErr || task.errorCount >= 3) {
      this.logMsg(agent.name, t('✗ Task #{id}: permanent error (attempt {n}) — STUCK', { id: task.id, n: task.errorCount }));
      this.updateTask(task, { status: 'stuck', feedback: t('The episode could not be executed: {msg}', { msg: err.message }) });
    } else {
      this.logMsg(agent.name, t('✗ Error for task #{id}: {msg} — requeueing ({n}/3)', { id: task.id, msg: err.message, n: task.errorCount }));
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
      this.logMsg(agent.name, t('🧪 QA #{cycle} for task #{id}', { cycle: task.qaCycles, id: task.id }));

      const prevQa = [...task.history].reverse().find((h) => h.role === 'qa');
      const prevQaBlock = prevQa
        ? `\n\nYOUR PREVIOUS QA REPORT (cycle ${task.qaCycles - 1}) — FIRST re-verify the failures you reported there:\n${prevQa.text.slice(0, 4000)}\n`
        : '';
      const userMessage = `Task #${task.id}: ${task.title}\n\n${task.description}${acceptanceBlock(task, 'qa')}\n\nImplemented and code-review-approved. Programmer summary:\n${task.lastSummary}\n\nChanged files: ${task.changedFiles.join(', ') || '(unknown)'}${prevQaBlock}\n\nVerify this change works. Remember to end with the VERDICT line.`;

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
            this.logMsg(agent.name, t('✋ Task #{id} passed QA — awaiting YOUR merge approval (button on the card)', { id: task.id }));
            this.updateTask(task, { status: 'awaiting_merge' });
          } else {
            await this.finalizeTask(task, agent.name);
          }
        } else if (task.qaCycles >= MAX_REVIEW_CYCLES) {
          this.logMsg(agent.name, t('⚠ Task #{id} failed QA {n} times — STUCK', { id: task.id, n: MAX_REVIEW_CYCLES }));
          this.updateTask(task, { status: 'stuck', feedback: result.text, feedbackSource: 'qa' });
        } else {
          this.logMsg(agent.name, t('❌ Task #{id} failed QA — returning it to the programmer for fixes', { id: task.id }));
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
    // work TOGETHER? Up to 2 fix rounds, plus one last VERIFY-ONLY round so the
    // final fixes never land unchecked. (Skipped in PR mode — main not updated.)
    if (!this.stopping && this.config.finalQa !== false && !this.config.prMode &&
        this.integrationRounds < 3 && this.tasks.some((t) => t.status === 'done')) {
      this.integrationRounds += 1;
      const verdict = await this.runIntegrationQa();
      this.integrationStatus = verdict.passed ? 'passed' : 'failed';
      this.integrationReport = verdict.report;
      if (!verdict.passed && this.integrationRounds < 3) {
        const id = Math.max(...this.tasks.map((t) => t.id)) + 1;
        this.tasks.push({
          id,
          title: t('Integration fixes (round {n})', { n: this.integrationRounds }),
          description: t('The final integration QA of the whole project failed. Fix the problems from the report.\n\nOriginal goal:\n{goal}', { goal: this.goal }),
          size: 'M', dependsOn: [], status: 'needs_fix',
          assignee: null, assigneeId: null, pinnedTo: null,
          attempts: 0, reviewCycles: 0, qaCycles: 0,
          feedback: verdict.report, feedbackSource: 'qa',
          lastSummary: null, changedFiles: [], usage: emptyUsage(),
          worktree: null, branch: null, history: [],
        });
        this.emit('task_update', { task: this.tasks[this.tasks.length - 1] });
        this.logMsg(t('Orchestrator'), t('🔧 Integration QA failed — fix task #{id} opened, the team continues', { id }));
        this.resumeRun();
        return;
      }
      if (!verdict.passed) {
        this.logMsg(t('Orchestrator'), t('⚠ Integration QA FAILED even after all fix rounds — the run ends UNVERIFIED. See the report in the log/email.'));
      }
    }

    this.finishedAt = Date.now();

    const done = this.tasks.filter((t) => t.status === 'done').length;
    const stuck = this.tasks.filter((t) => t.status === 'stuck');
    const mins = ((this.finishedAt - this.startedAt) / 60000).toFixed(1);
    const u = this.totalUsage;

    const summaryLines = this.tasks.map((x) =>
      t('#{id} [{status}] {title} — {assignee}, review cycles: {reviews}, QA: {qa}', {
        id: x.id, status: x.status.toUpperCase(), title: x.title, assignee: x.assignee || '—', reviews: x.reviewCycles, qa: x.qaCycles,
      }) + (x.usage.costUsd ? `, ~$${x.usage.costUsd.toFixed(2)}` : '')
    );
    const integLine =
      this.integrationStatus === 'passed' ? t('✅ Final integration QA: PASSED') + '\n' :
      this.integrationStatus === 'failed'
        ? t('⚠ Final integration QA: FAILED even after fix rounds — the project is NOT verified!\nReport:\n{report}', { report: (this.integrationReport || '').slice(0, 3000) }) + '\n'
        : '';
    const summary =
      t('Agentura — run finished in {mins} min.', { mins }) + '\n' +
      t('Tasks completed: {done}/{total}', { done, total: this.tasks.length }) + (stuck.length ? t(', stuck: {n}', { n: stuck.length }) : '') + '\n' +
      integLine +
      (u.calls ? t('Usage: {in} in / {out} out ({calls} calls), ~${cost}', { in: fmtTok(u.input + u.cacheRead + u.cacheWrite), out: fmtTok(u.output), calls: u.calls, cost: u.costUsd.toFixed(2) }) + '\n' : '') +
      '\n' + summaryLines.join('\n') +
      `\n\nWorkspace: ${this.config.workspacePath}`;

    this.logMsg(t('Orchestrator'),this.stopping ? t('Run stopped.') : t('All tasks processed ({done}/{total} done)', { done, total: this.tasks.length }) + (u.costUsd ? t(' — total ~${cost}', { cost: u.costUsd.toFixed(2) }) : '') + '.');
    this.phase = 'finished';
    this.emit('run_finished', { summary, done, total: this.tasks.length, stuck: stuck.length, usage: u, state: this.state() });

    await this.persistRun(summary, done, stuck.length);
    await this.deleteSnapshot(); // run is over — nothing to resume anymore

    if (this.config.notifyEmail && !this.stopping) {
      try {
        await sendEmail({
          to: this.config.notifyEmail,
          subject: this.integrationStatus === 'failed'
            ? t('⚠ Agentura: {done}/{total} completed, but integration QA FAILED', { done, total: this.tasks.length })
            : stuck.length
            ? t('⚠ Agentura: {done}/{total} completed, {stuck} STUCK', { done, total: this.tasks.length, stuck: stuck.length })
            : t('✅ Agentura: {done}/{total} tasks completed', { done, total: this.tasks.length }),
          text: summary,
        });
        this.logMsg(t('Orchestrator'), t('📧 Email notification sent to {to}', { to: this.config.notifyEmail }));
      } catch (err) {
        this.logMsg(t('Orchestrator'), t('📧 Sending the email failed: {msg}', { msg: err.message }));
      }
    }
  }

  async runIntegrationQa() {
    const agent = this.agents.find((a) => a.role === 'qa') || this.agents[0];
    this.setAgent(agent, 'working', null);
    this.logMsg(agent.name, t('🧪 FINAL integration QA — checking whether the whole project works together…'));
    try {
      const taskList = this.tasks
        .map((t) => `#${t.id} [${t.status}] ${t.title}`)
        .join('\n');
      // Aggregate the acceptance criteria of all delivered tasks into one
      // final checklist — integration QA re-verifies them on the MERGED state.
      const withAcc = this.tasks.filter((t) => t.status === 'done' && t.acceptance?.length);
      const checklist = withAcc.length
        ? '\n\nFULL ACCEPTANCE CHECKLIST (criteria of all merged tasks — verify EACH item on the integrated project and report ✓/✗ per item; FAILED if any item fails):\n' +
          withAcc.map((t) => `Task #${t.id} — ${t.title}:\n${t.acceptance.map((c, i) => `  ${t.id}.${i + 1} ${c}`).join('\n')}`).join('\n') + '\n'
        : '';
      const userMessage =
        `PROJECT GOAL:\n${this.goal}\n\nCompleted tasks (already merged into ${this.mainBranch}):\n${taskList}` +
        checklist +
        '\n\nVerify the whole project now. Remember to end with the VERDICT line.' +
        (await this.notesBlock());
      const result = await this.episode({
        agent, role: 'qa', task: { id: 0, title: t('Integration: {goal}', { goal: this.goal.slice(0, 60) }) }, attempt: this.integrationRounds,
        system: integrationQaPrompt(agent.name, HARNESS_DIR), userMessage,
        workspace: this.config.workspacePath,
      });
      const passed = lastVerdict(result.text) === 'PASSED';
      this.logMsg(agent.name, passed ? t('✅ Integration QA PASSED — the project works as a whole') : t('❌ Integration QA FAILED — opening a fix task'));
      this.setAgent(agent, 'idle');
      return { passed, report: result.text };
    } catch (err) {
      this.setAgent(agent, 'idle');
      this.logMsg(agent.name, t('⚠ Integration QA could not be executed ({msg}) — skipping', { msg: err.message }));
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
    const { apiKey, kimiKey, ...cfg } = this.config || {}; // keys never touch disk
    const snap = {
      v: 1,
      savedAt: Date.now(),
      runId: this.runId,
      goal: this.goal,
      phase: this.phase,
      startedAt: this.startedAt,
      mainBranch: this.mainBranch,
      integrationRounds: this.integrationRounds,
      integrationStatus: this.integrationStatus,
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
  async restore(snap, apiKey, kimiKey = '') {
    if (this.phase === 'running' || this.phase === 'planning') {
      throw new Error(t('This session is busy — open a new tab and resume the run there'));
    }
    try { await fs.access(snap.config.workspacePath); } catch {
      throw new Error(t('The workspace no longer exists: {ws}', { ws: snap.config.workspacePath }));
    }

    this.reset();
    this.config = { ...snap.config, apiKey, kimiKey };
    this.goal = snap.goal;
    this.runId = snap.runId;
    this.startedAt = snap.startedAt || Date.now();
    this.mainBranch = snap.mainBranch || 'master';
    this.integrationRounds = snap.integrationRounds || 0;
    this.integrationStatus = snap.integrationStatus || null;
    this.steerings = snap.steerings || [];
    this.totalUsage = { ...emptyUsage(), ...snap.totalUsage };
    this.log = snap.log || [];
    this.agents = (snap.agents || []).map((a) => ({
      ...a, status: 'idle', currentTaskId: null, usage: { ...emptyUsage(), ...a.usage }, lastText: '',
    }));
    this.tasks = snap.tasks || [];

    for (const task of this.tasks) {
      task.errorCount = 0;
      // A worktree lost with the crash → the task restarts on a fresh base.
      if (task.worktree) {
        try { await fs.access(task.worktree); } catch {
          this.logMsg(t('Orchestrator'), t('⚠ Task #{id}: the working copy vanished in the interruption — the task starts over', { id: task.id }));
          task.worktree = null; task.branch = null; task.changedFiles = [];
          if (!['done', 'stuck'].includes(task.status)) {
            task.status = 'queued'; task.feedback = null; task.assignee = null; task.assigneeId = null;
          }
          continue;
        }
      }
      // Mid-flight statuses → back to an actionable state / queue. A queued
      // task must be unclaimed (assigneeId blocks claimableBy) — fixes keep
      // their owner so the same programmer (same id after restore) continues.
      if (task.status === 'coding') {
        task.status = task.feedback ? 'needs_fix' : 'queued';
        if (task.status === 'queued') { task.assignee = null; task.assigneeId = null; }
      } else if (task.status === 'queued') {
        task.assignee = null; task.assigneeId = null;
      } else if (task.status === 'in_review') this.reviewQueue.push(task.id);
      else if (task.status === 'in_qa') this.qaQueue.push(task.id);
    }

    this.phase = 'running';
    this.emit('run_started', { state: this.state() });
    const open = this.tasks.filter((t) => !['done', 'stuck'].includes(t.status)).length;
    this.logMsg(t('Orchestrator'), t('⏯ Run restored from a snapshot ({runId}) — {n} tasks left to finish. Working copies and Claude Code sessions are preserved.', { runId: snap.runId, n: open }));
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
      this.logMsg(t('Orchestrator'), t('💾 Run saved to history ({runId})', { runId: this.runId }));
    } catch (err) {
      this.logMsg(t('Orchestrator'), t('💾 Saving history failed: {msg}', { msg: err.message }));
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

// Map a raw tool call to a compact live-activity entry. Handles both engines'
// tool names (Claude Code: Write/Edit/Bash/Read/Glob/Grep; API: write_file/
// run_command/read_file/list_dir).
function activityFromTool(tool, input) {
  const T = String(tool || '').toLowerCase();
  const inp = input && typeof input === 'object' ? input : {};
  const file = inp.path || inp.file_path || inp.file || inp.pattern || '';
  if (/write|edit|create|multiedit/.test(T)) {
    return { kind: 'write', tool, file, text: String(inp.content ?? inp.new_string ?? inp.contents ?? '').slice(0, 1500) };
  }
  if (/bash|run_command|command|exec|shell/.test(T)) {
    return { kind: 'cmd', tool, text: String(inp.command ?? inp.cmd ?? '').slice(0, 400) };
  }
  if (/read|glob|grep|^ls$|list_dir|search/.test(T)) {
    return { kind: 'read', tool, file, text: '' };
  }
  return { kind: 'tool', tool, text: JSON.stringify(inp).slice(0, 300) };
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
      acceptance: normalizeAcceptance(t.acceptance),
    }));
  return tasks.length ? tasks : null;
}

// Acceptance criteria: array of short non-empty strings (max 8 × 300 chars).
function normalizeAcceptance(a) {
  if (!Array.isArray(a)) return [];
  return a.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 8).map((c) => c.slice(0, 300));
}

// Shared "checklist" block injected into programmer / reviewer / QA messages.
function acceptanceBlock(task, role) {
  const list = task.acceptance || [];
  if (!list.length) return '';
  const head = {
    programmer: 'ACCEPTANCE CRITERIA (definition of done — your implementation must satisfy EACH):',
    reviewer: 'ACCEPTANCE CRITERIA (request changes if the code clearly fails to cover any):',
    qa: 'ACCEPTANCE CRITERIA (your test plan — verify EACH item and report ✓/✗ per item):',
  }[role] || 'ACCEPTANCE CRITERIA:';
  return `\n\n${head}\n${list.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`;
}

function fmtTok(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
