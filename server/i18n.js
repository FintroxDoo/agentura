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
};
