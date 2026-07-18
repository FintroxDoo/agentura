// Tiny gettext-style i18n. English strings ARE the keys; the Serbian catalog
// maps them 1:1 — a missing entry silently falls back to English. The chosen
// language persists in data/settings.json and applies to all server-emitted
// messages (orchestrator log, API errors, emails). The web UI keeps its own
// mirror of the same setting for static chrome strings.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(
  process.env.HARNESS_DATA_DIR || path.join(__dirname, '..', 'data'),
  'settings.json'
);

let lang = 'en';
try {
  lang = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')).lang === 'sr' ? 'sr' : 'en';
} catch { /* first boot → English */ }

export function getLang() {
  return lang;
}

export async function setLang(next) {
  lang = next === 'sr' ? 'sr' : 'en';
  try {
    await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
    let cur = {};
    try { cur = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')); } catch { /* new file */ }
    await fs.writeFile(SETTINGS_FILE, JSON.stringify({ ...cur, lang }, null, 1));
  } catch { /* non-fatal: lang still applies for this process */ }
  return lang;
}

/** t('Task {id} failed', {id: 3}) → looks up the Serbian catalog when lang==='sr', then interpolates {placeholders}. */
export function t(msg, vars = null) {
  let out = lang === 'sr' ? SR[msg] || msg : msg;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

// Serbian catalog: English source string → Serbian translation.
export const SR = {
  'Unknown session: {id}': 'Nepoznata sesija: {id}',
  'Unknown session': 'Nepoznata sesija',
  'Project {n}': 'Projekat {n}',
  'Path is not a directory': 'Putanja nije folder',
  'Directory does not exist: {ws}': 'Folder ne postoji: {ws}',
  'Session is active — the directory cannot be changed mid-run': 'Sesija je aktivna — folder ne može da se menja usred rada',
  'Missing workspacePath': 'Nedostaje workspacePath',
  'The last tab cannot be closed': 'Poslednji tab ne može da se zatvori',
  'Project is active — stop it first (■)': 'Projekat je aktivan — prvo ga zaustavi (■)',
  'Session has no bound directory (or the path is outside it)': 'Sesija nema vezan folder (ili je putanja van njega)',
  'Cannot open: {msg}': 'Ne mogu da otvorim: {msg}',
  'Path is outside the session workspace': 'Putanja je van radnog foldera sesije',
  'Cannot open directory: {msg}': 'Ne mogu da otvorim folder: {msg}',
  'KIMI_API_KEY is not set in .env': 'KIMI_API_KEY nije postavljen u .env',
  'Describe the goal for the team.': 'Opiši zadatak (cilj) za tim.',
  'Role must be programmer, reviewer, qa or ask.': 'Uloga mora biti programmer, reviewer, qa ili ask.',
  'Describe what the agent should do.': 'Opiši šta agent treba da uradi.',
  'Write your objections for the new plan.': 'Upiši primedbe za novi plan.',
  'Run snapshot does not exist (already resumed or deleted)': 'Snimak runa ne postoji (možda je već nastavljen ili obrisan)',
  'Task does not exist': 'Task ne postoji',
  'No active workspace': 'Nema aktivnog workspace-a',
  'Agentura — test email': 'Agentura — test email',
  'Resend configuration works. Notifications will arrive here when agents finish tasks.': 'Resend konfiguracija radi. Ovde će stići notifikacija kad agenti završe taskove.',

  // --- server/orchestrator.js ---
  'Orchestrator': 'Orkestrator',
  'You': 'Ti',
  '📧 Email sent to {to}: {subject}': '📧 Email poslat na {to}: {subject}',
  '📧 Sending the email failed: {msg}': '📧 Slanje emaila nije uspelo: {msg}',
  ' (subscription)': ' (pretplata)',
  'mix — programmers: {p}, lead: {r}, QA: {q}': 'mix — programeri: {p}, lead: {r}, QA: {q}',
  'Planning or a run is already in progress': 'Planiranje ili run je već u toku',
  'Workspace ready: {ws} (branch: {branch}) — engine: {engine}': 'Radni prostor spreman: {ws} (grana: {branch}) — motor: {engine}',
  'No plan is awaiting approval': 'Nema plana koji čeka odobrenje',
  '🧠 Drafting a new plan with your objections…': '🧠 Pravi novi plan uz tvoje primedbe…',
  '🧠 Analyzing the goal and drafting the task plan…': '🧠 Analizira cilj i pravi plan taskova…',
  '⚠ The plan was not valid JSON — asking again for JSON only (attempt {attempt}/3)…': '⚠ Plan nije bio u ispravnom JSON formatu — tražim ponovo samo JSON (pokušaj {attempt}/3)…',
  'The planner did not return a valid JSON task plan even after 3 attempts': 'Planer nije vratio validan JSON plan taskova ni nakon 3 pokušaja',
  '📋 Plan ready: {n} tasks — awaiting your approval.': '📋 Plan spreman: {n} taskova — čeka tvoje odobrenje.',
  '✗ Planning failed: {msg}': '✗ Planiranje nije uspelo: {msg}',
  '✗ Agentura: planning failed': '✗ Agentura: planiranje nije uspelo',
  'Planning for goal "{goal}" failed.\n\nError: {msg}\n\nStart planning again from the UI.': 'Planiranje za cilj "{goal}" je palo.\n\nGreška: {msg}\n\nPokreni planiranje ponovo iz interfejsa.',
  'The plan has no tasks': 'Plan nema nijedan task',
  'Programmer-{n}': 'Programer-{n}',
  'Plan approved — run started: {tasks} tasks, {programmers} programmers, {reviewers} team lead(s), {qa} QA. Engine: {engine}{models}': 'Plan odobren — run started: {tasks} taskova, {programmers} programera, {reviewers} team lead(ova), {qa} QA. Motor: {engine}{models}',
  ' — models: {p}/{r}/{q}': ' — modeli: {p}/{r}/{q}',
  'programmer': 'programer',
  'team lead (review/analysis)': 'team lead (review/analiza)',
  'team lead (answer to a question)': 'team lead (odgovor na pitanje)',
  'team lead answer': 'team lead odgovor',
  '⚡ Solo run: {role} — engine: {engine}, workspace: {ws}': '⚡ Solo run: {role} — motor: {engine}, workspace: {ws}',
  '✓ Changes committed ({n} files)': '✓ Izmene komitovane ({n} fajlova)',
  '⚠ No file changes — the agent replied without code': '⚠ Nema izmena fajlova — agent je odgovorio bez koda',
  '❌ VERDICT: FAILED — details in the report': '❌ VERDICT: FAILED — detalji u izveštaju',
  '✗ Solo episode failed: {msg}': '✗ Solo epizoda nije uspela: {msg}',
  'Episode failed: {msg}': 'Epizoda nije uspela: {msg}',
  'Agentura — solo {role} finished in {mins} min.{cost}\n\nRequest: {goal}\n\nREPORT:\n{report}\n\nWorkspace: {ws}': 'Agentura — solo {role} završen za {mins} min.{cost}\n\nZahtev: {goal}\n\nIZVEŠTAJ:\n{report}\n\nWorkspace: {ws}',
  'Solo run finished — FAILED (see the report).': 'Solo run završen — NEUSPEŠNO/FAILED (vidi izveštaj).',
  'Solo run finished.': 'Solo run završen.',
  'Agentura (solo {role}): {goal}': 'Agentura (solo {role}): {goal}',
  '📧 Report sent to {to}': '📧 Izveštaj poslat na {to}',
  '⚠ Task #{id} is part of a dependency cycle — its dependencies were removed.': '⚠ Task #{id} je deo ciklusa zavisnosti — zavisnosti su mu uklonjene.',
  'Messages to the team only apply once the run starts': 'Poruke timu važe tek kad run krene',
  'Empty message': 'Prazna poruka',
  'Task #{id} does not exist': 'Task #{id} ne postoji',
  '[whole team] ': '[ceo tim] ',
  '⏸ Plan limit reached — pausing all episodes for 15 min. ({msg})': '⏸ Limit plana dostignut — pauziram sve epizode 15 min. ({msg})',
  '⏸ Agentura: plan limit — run paused': '⏸ Agentura: limit plana — run pauziran',
  'Run "{goal}" is paused because the Claude plan limit was reached.\n\nMessage: {msg}\n\nIt resumes automatically at {until} (then re-checks every 15 min until the limit resets).\nIf you have already topped up the limit/tokens, click "▶ Resume now" in the UI — you do not have to wait.\n\nWorkspace: {ws}': 'Run "{goal}" je pauziran jer je dostignut limit Claude plana.\n\nPoruka: {msg}\n\nAutomatski nastavlja u {until} (pa proverava ponovo na 15 min dok se limit ne resetuje).\nAko si već dopunio limit/tokene, klikni "▶ Nastavi odmah" u interfejsu — ne moraš da čekaš.\n\nWorkspace: {ws}',
  'The run is not paused': 'Run nije pauziran',
  '▶ Manual resume — pause cut short, the team continues immediately.': '▶ Ručni nastavak — pauza prekinuta, tim nastavlja odmah.',
  '▶ Pause expired — resuming work.': '▶ Pauza istekla — nastavljam rad.',
  'Task #{id} is not stuck (status: {status})': 'Task #{id} nije zaglavljen (status: {status})',
  '↻ Task #{id} put back to work ({status}) — the first free programmer takes it': '↻ Task #{id} vraćen u rad ({status}) — uzima ga prvi slobodan programer',
  'A task can only be assigned to a programmer': 'Task može da se dodeli samo programeru',
  'Task #{id} is in status "{status}" — only a queued, needs-fix or stuck task can be assigned manually': 'Task #{id} je u statusu "{status}" — ručno se dodeljuje samo task koji čeka, traži popravku ili je zaglavljen',
  '👉 Task #{id} manually assigned to programmer {name} — they take it as soon as they are free': '👉 Task #{id} ručno dodeljen programeru {name} — uzima ga čim se oslobodi',
  'Run resumed.': 'Run nastavljen.',
  'Found uncommitted changes — saved as a "pre-harness snapshot" commit.': 'Zatečene nekomitovane izmene — snimljene kao "pre-harness snapshot" commit.',
  '# Project notes (harness memory)': '# Beleške projekta (harness memorija)',
  'git worktree add failed: {out}': 'git worktree add nije uspeo: {out}',
  '🌿 Task #{id}: working copy on branch {branch}': '🌿 Task #{id}: radna kopija na grani {branch}',
  '📸 Found uncommitted changes in the main folder ({n} files) — saved before the merge.': '📸 Zatečene nekomitovane izmene u glavnom folderu ({n} fajlova) — snimljene pre merge-a.',
  '🎉 Task #{id} FINISHED — branch pushed and PR opened': '🎉 Task #{id} ZAVRŠEN — grana push-ovana i PR otvoren',
  '⚠ Task #{id}: push/PR failed — doing a local merge instead': '⚠ Task #{id}: push/PR nije uspeo — radim lokalni merge umesto toga',
  '🎉 Task #{id} PASSED — merged into {branch}, task FINISHED': '🎉 Task #{id} PROŠAO — merge u {branch}, task ZAVRŠEN',
  '⚔ Task #{id}: merge conflict — returning it to the programmer on a fresh base': '⚔ Task #{id}: merge u konfliktu — vraćam programeru na svežu bazu',
  'Automatic PR from Agentura.\n\nTask: {title}\n\n{summary}': 'Automatski PR iz Agenture.\n\nTask: {title}\n\n{summary}',
  '🔗 PR opened: {url}': '🔗 PR otvoren: {url}',
  'Task #{id} is not awaiting merge (status: {status})': 'Task #{id} ne čeka merge (status: {status})',
  'Stop requested — workers will halt after current episodes.': 'Zatražen stop — radnici će stati posle tekućih epizoda.',
  'Planning cancelled.': 'Planiranje otkazano.',
  '⚠ Agentura: {n} task(s) STUCK': '⚠ Agentura: {n} task(ova) ZAGLAVLJENO',
  'Run "{goal}" has newly-stuck tasks:': 'Run "{goal}" ima novo-zaglavljene taskove:',
  '  Reason: {reason}': '  Razlog: {reason}',
  '(no details)': '(bez detalja)',
  'The run continues with the remaining tasks. You can put stuck tasks back to work with the ↻ Retry button in the UI.': 'Run nastavlja sa ostalim taskovima. Zaglavljene možeš da vratiš u rad dugmetom ↻ Retry u interfejsu.',
  '⚠ Submitted empty work (no file changes) — reminding it to implement (attempt {attempt}/2)': '⚠ Predao prazan rad (bez izmena fajlova) — podsetnik da implementira (pokušaj {attempt}/2)',
  '⚠ Empty work — reminder to implement (attempt {attempt}/2)': '⚠ Prazan rad — podsetnik da implementira (pokušaj {attempt}/2)',
  '⚠ Task #{id} blocked: dependency #{dep} is stuck': '⚠ Task #{id} blokiran: zavisnost #{dep} je zaglavljena',
  'Dependency (task #{dep}) is stuck — this task cannot start. Unstick task #{dep} and then retry this one.': 'Zavisnost (task #{dep}) je zaglavljena — task ne može da počne. Odglavi task #{dep} pa pokušaj ponovo ovaj.',
  '▶ Fixing task #{id} ({source} feedback)': '▶ Popravlja task #{id} ({source} feedback)',
  '▶ Starting task #{id}: {title}': '▶ Počinje task #{id}: {title}',
  '✓ Task #{id} sent to review ({n} files changed)': '✓ Task #{id} poslat na review ({n} fajlova izmenjeno)',
  '✗ Error on task #{id}: {msg}': '✗ Greška na tasku #{id}: {msg}',
  '🔍 Review #{cycle} for task #{id}': '🔍 Review #{cycle} za task #{id}',
  '✅ Task #{id} APPROVED — moving on to QA': '✅ Task #{id} ODOBREN — ide u QA',
  '⚠ Task #{id} reached {n} review cycles — marked as STUCK': '⚠ Task #{id} dostigao {n} review ciklusa — označen kao STUCK',
  '↩ Task #{id}: changes requested — returning it to programmer {name}': '↩ Task #{id}: tražene izmene — vraćam programeru {name}',
  '✗ Task #{id}: context too large — shrinking the diff to 8k and retrying': '✗ Task #{id}: kontekst prevelik — smanjujem diff na 8k i pokušavam ponovo',
  '✗ Task #{id}: permanent error (attempt {n}) — STUCK': '✗ Task #{id}: trajna greška ({n}. pokušaj) — STUCK',
  'The episode could not be executed: {msg}': 'Epizoda nije mogla da se izvrši: {msg}',
  '✗ Error for task #{id}: {msg} — requeueing ({n}/3)': '✗ Greška za task #{id}: {msg} — vraćam u red ({n}/3)',
  '🧪 QA #{cycle} for task #{id}': '🧪 QA #{cycle} za task #{id}',
  '✋ Task #{id} passed QA — awaiting YOUR merge approval (button on the card)': '✋ Task #{id} prošao QA — čeka TVOJE odobrenje za merge (dugme na kartici)',
  '⚠ Task #{id} failed QA {n} times — STUCK': '⚠ Task #{id} pao QA {n} puta — STUCK',
  '❌ Task #{id} failed QA — returning it to the programmer for fixes': '❌ Task #{id} pao QA — vraćam programeru na popravku',
  'Integration fixes (round {n})': 'Integracione popravke (runda {n})',
  'The final integration QA of the whole project failed. Fix the problems from the report.\n\nOriginal goal:\n{goal}': 'Završni integracioni QA celog projekta je pao. Popravi probleme iz izveštaja.\n\nOriginalni cilj:\n{goal}',
  '🔧 Integration QA failed — fix task #{id} opened, the team continues': '🔧 Integracioni QA pao — otvoren popravni task #{id}, tim nastavlja',
  '⚠ Integration QA FAILED even after all fix rounds — the run ends UNVERIFIED. See the report in the log/email.': '⚠ Integracioni QA je PAO i posle svih popravnih rundi — run se završava NEPOTVRĐEN. Pogledaj izveštaj u logu/emailu.',
  '#{id} [{status}] {title} — {assignee}, review cycles: {reviews}, QA: {qa}': '#{id} [{status}] {title} — {assignee}, review ciklusa: {reviews}, QA: {qa}',
  '✅ Final integration QA: PASSED': '✅ Završni integracioni QA: PROŠAO',
  '⚠ Final integration QA: FAILED even after fix rounds — the project is NOT verified!\nReport:\n{report}': '⚠ Završni integracioni QA: PAO i posle popravnih rundi — projekat NIJE potvrđen!\nIzveštaj:\n{report}',
  'Agentura — run finished in {mins} min.': 'Agentura — run završen za {mins} min.',
  'Tasks completed: {done}/{total}': 'Taskova završeno: {done}/{total}',
  ', stuck: {n}': ', zaglavljeno: {n}',
  'Usage: {in} in / {out} out ({calls} calls), ~${cost}': 'Potrošnja: {in} in / {out} out ({calls} poziva), ~${cost}',
  'Run stopped.': 'Run zaustavljen.',
  'All tasks processed ({done}/{total} done)': 'Svi taskovi obrađeni ({done}/{total} done)',
  ' — total ~${cost}': ' — ukupno ~${cost}',
  '⚠ Agentura: {done}/{total} completed, but integration QA FAILED': '⚠ Agentura: {done}/{total} završeno, ali integracioni QA PAO',
  '⚠ Agentura: {done}/{total} completed, {stuck} STUCK': '⚠ Agentura: {done}/{total} završeno, {stuck} ZAGLAVLJENO',
  '✅ Agentura: {done}/{total} tasks completed': '✅ Agentura: {done}/{total} taskova završeno',
  '📧 Email notification sent to {to}': '📧 Email notifikacija poslata na {to}',
  '🧪 FINAL integration QA — checking whether the whole project works together…': '🧪 ZAVRŠNI integracioni QA — proveravam da li ceo projekat radi kao celina…',
  'Integration: {goal}': 'Integracija: {goal}',
  '✅ Integration QA PASSED — the project works as a whole': '✅ Integracioni QA PROŠAO — projekat radi kao celina',
  '❌ Integration QA FAILED — opening a fix task': '❌ Integracioni QA PAO — otvaram popravni task',
  '⚠ Integration QA could not be executed ({msg}) — skipping': '⚠ Integracioni QA nije mogao da se izvrši ({msg}) — preskačem',
  'This session is busy — open a new tab and resume the run there': 'Ova sesija je zauzeta — otvori novi tab pa nastavi run u njemu',
  'The workspace no longer exists: {ws}': 'Workspace više ne postoji: {ws}',
  '⚠ Task #{id}: the working copy vanished in the interruption — the task starts over': '⚠ Task #{id}: radna kopija je nestala u prekidu — task kreće ispočetka',
  '⏯ Run restored from a snapshot ({runId}) — {n} tasks left to finish. Working copies and Claude Code sessions are preserved.': '⏯ Run obnovljen iz snimka ({runId}) — {n} taskova za dovršavanje. Radne kopije i Claude Code sesije su sačuvane.',
  '💾 Run saved to history ({runId})': '💾 Run sačuvan u istoriju ({runId})',
  '💾 Saving history failed: {msg}': '💾 Snimanje istorije nije uspelo: {msg}',

  // --- server/mock.js ---
  'project': 'projekat',
  'Set up the basic project structure': 'Postavi osnovnu strukturu projekta',
  'Initial structure and configuration for: {goal}.': 'Inicijalna struktura i konfiguracija za: {goal}.',
  'The project has a clear folder structure': 'Projekat ima jasnu strukturu foldera',
  'Configuration files exist and are valid': 'Konfiguracioni fajlovi postoje i validni su',
  'Implement the main functionality': 'Implementiraj glavnu funkcionalnost',
  'Core functionality for: {goal}.': 'Jezgro funkcionalnosti za: {goal}.',
  'The main functionality works on an example': 'Glavna funkcionalnost radi na primeru',
  'Invalid input does not crash the application': 'Nevalidan unos ne ruši aplikaciju',
  'Add tests and documentation': 'Dodaj testove i dokumentaciju',
  'Basic tests and a README for: {goal}.': 'Osnovni testovi i README za: {goal}.',
  'Tests pass': 'Testovi prolaze',
  'The README describes how to run the project': 'README opisuje pokretanje',
  'Plan proposal (MOCK simulation — no API key).': 'Predlog plana (MOCK simulacija — bez API ključa).',
  'Analyzing task "{title}" and drafting an implementation plan…': 'Analiziram task "{title}" i pravim plan implementacije…',
  'OK (mock) — no errors during execution.': 'OK (mock) — nema grešaka pri izvršavanju.',
  'Reading the changes and checking correctness for "{title}"…': 'Čitam izmene i proveravam ispravnost za "{title}"…',
  'Running smoke checks for "{title}"…': 'Pokrećem smoke provere za "{title}"…',

  // --- server/claude-code.js ---
  'Claude Code CLI: no output at all for {mins} min — episode stuck, terminated': 'Claude Code CLI: bez ikakvog izlaza {mins} min — epizoda zaglavljena, prekinuta',
  'Claude Code CLI: absolute episode limit exceeded ({mins} min)': 'Claude Code CLI: prekoračen apsolutni limit epizode ({mins} min)',
  'did not return a result': 'nije vratio rezultat',
  '(resuming the interrupted session failed — starting a new episode from scratch)': '(nastavak prekinute sesije nije uspeo — krećem novu epizodu od početka)',
  '(the interrupted session no longer exists — starting a new episode from scratch)': '(prekinuta sesija više ne postoji — krećem novu epizodu od početka)',
  'Claude Code: plan limit reached — {msg}': 'Claude Code: dostignut limit plana — {msg}',
  'Claude Code CLI cannot authenticate (401). Fix: run `claude setup-token` in your terminal, confirm in the browser, then put the resulting token into agent-harness/.env as CLAUDE_CODE_OAUTH_TOKEN=... and restart the server. (Alternative: run `claude` then /login to refresh the login.)': 'Claude Code CLI ne može da se autentifikuje (401). Rešenje: u svom terminalu pokreni `claude setup-token`, potvrdi u browseru, pa dobijeni token upiši u agent-harness/.env kao CLAUDE_CODE_OAUTH_TOKEN=... i restartuj server. (Alternativa: `claude` pa /login da osvežiš prijavu.)',
  'Claude Code episode failed ({subtype}): {msg}': 'Claude Code epizoda nije uspela ({subtype}): {msg}',

  // --- server/mailer.js ---
  'No recipient email address provided': 'Nije unet email primaoca',
  'RESEND_API_KEY is not set in .env — the email cannot be sent': 'RESEND_API_KEY nije postavljen u .env — email se ne može poslati',
};
