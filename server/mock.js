// Mock agent episodes — used when no ANTHROPIC_API_KEY is configured.
// Lets you test the whole orchestration flow (assignment, review loop, QA,
// email) without spending tokens.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runMockEpisode({ role, task, attempt, workspace, onEvent = () => {} }) {
  await sleep(1500 + Math.random() * 2000);

  if (role === 'planner') {
    const goal = (task.title || 'projekat').slice(0, 80);
    const plan = [
      { title: 'Postavi osnovnu strukturu projekta', description: `Inicijalna struktura i konfiguracija za: ${goal}.`,
        acceptance: ['Projekat ima jasnu strukturu foldera', 'Konfiguracioni fajlovi postoje i validni su'] },
      { title: 'Implementiraj glavnu funkcionalnost', description: `Jezgro funkcionalnosti za: ${goal}.`, dependsOn: [1],
        acceptance: ['Glavna funkcionalnost radi na primeru', 'Nevalidan unos ne ruši aplikaciju'] },
      { title: 'Dodaj testove i dokumentaciju', description: `Osnovni testovi i README za: ${goal}.`, dependsOn: [1],
        acceptance: ['Testovi prolaze', 'README opisuje pokretanje'] },
    ];
    const text = `Predlog plana (MOCK simulacija — bez API ključa).\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
    onEvent({ type: 'agent_text', text });
    return { text, changedFiles: [], iterations: 1 };
  }

  if (role === 'programmer') {
    const file = `task-${task.id}-solution.md`;
    onEvent({ type: 'agent_text', text: `Analiziram task "${task.title}" i pravim plan implementacije…` });
    await sleep(600);
    onEvent({ type: 'tool_call', tool: 'read_file', input: { path: 'README.md' } });
    await sleep(500);
    const content = `# Mock solution for task #${task.id} (attempt ${attempt})\n\n${task.title}\n\nfunction solve() {\n  // implementation\n  return true;\n}\n`;
    onEvent({ type: 'tool_call', tool: 'write_file', input: { path: file, content } });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, file), content, 'utf8');
    await sleep(700);
    onEvent({ type: 'tool_call', tool: 'run_command', input: { command: `node -e "require('./${file}')" || true` } });
    await sleep(500);
    onEvent({ type: 'tool_result', tool: 'run_command', output: 'OK (mock) — nema grešaka pri izvršavanju.' });
    await sleep(400);
    const text =
      attempt === 1
        ? `Implemented "${task.title}". Created ${file} with the initial solution.`
        : `Applied requested fixes for "${task.title}" (attempt ${attempt}). Updated ${file}.`;
    onEvent({ type: 'agent_text', text });
    return { text, changedFiles: [file], iterations: 2 };
  }

  if (role === 'reviewer') {
    onEvent({ type: 'agent_text', text: `Čitam izmene i proveravam ispravnost za "${task.title}"…` });
    await sleep(500);
    onEvent({ type: 'tool_call', tool: 'run_command', input: { command: 'git diff --stat' } });
    await sleep(500);
    onEvent({ type: 'tool_result', tool: 'run_command', output: ` task-${task.id}-solution.md | 6 ++++++\n 1 file changed, 6 insertions(+)` });
    await sleep(500);
    // First review of every task requests changes, so you can see the loop.
    const approve = attempt > 1;
    const text = approve
      ? `Change looks correct and complete for the task. Nice work.\nVERDICT: APPROVED`
      : `1. Add error handling for the edge case.\n2. Clarify the naming in the new file.\nVERDICT: CHANGES_REQUESTED`;
    onEvent({ type: 'agent_text', text });
    return { text, changedFiles: [], iterations: 1 };
  }

  // qa
  onEvent({ type: 'agent_text', text: `Pokrećem smoke provere za "${task.title}"…` });
  await sleep(500);
  onEvent({ type: 'tool_call', tool: 'run_command', input: { command: 'npm test' } });
  await sleep(800);
  onEvent({ type: 'tool_result', tool: 'run_command', output: '✓ 3 passing (42ms)\nAll checks green.' });
  await sleep(400);
  const text = `Ran smoke checks against the change for "${task.title}". Everything behaves as expected.\nVERDICT: PASSED`;
  onEvent({ type: 'agent_text', text });
  return { text, changedFiles: [], iterations: 1 };
}
