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
      { title: 'Postavi osnovnu strukturu projekta', description: `Inicijalna struktura i konfiguracija za: ${goal}.` },
      { title: 'Implementiraj glavnu funkcionalnost', description: `Jezgro funkcionalnosti za: ${goal}.`, dependsOn: [1] },
      { title: 'Dodaj testove i dokumentaciju', description: `Osnovni testovi i README za: ${goal}.`, dependsOn: [1] },
    ];
    const text = `Predlog plana (MOCK simulacija — bez API ključa).\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
    onEvent({ type: 'agent_text', text });
    return { text, changedFiles: [], iterations: 1 };
  }

  if (role === 'programmer') {
    const file = `task-${task.id}-solution.md`;
    onEvent({ type: 'tool_call', tool: 'write_file', input: { path: file } });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, file),
      `# Mock solution for task #${task.id} (attempt ${attempt})\n\n${task.title}\n`,
      'utf8'
    );
    await sleep(1000);
    const text =
      attempt === 1
        ? `Implemented "${task.title}". Created ${file} with the initial solution.`
        : `Applied requested fixes for "${task.title}" (attempt ${attempt}). Updated ${file}.`;
    onEvent({ type: 'agent_text', text });
    return { text, changedFiles: [file], iterations: 2 };
  }

  if (role === 'reviewer') {
    // First review of every task requests changes, so you can see the loop.
    const approve = attempt > 1;
    const text = approve
      ? `Change looks correct and complete for the task. Nice work.\nVERDICT: APPROVED`
      : `1. Add error handling for the edge case.\n2. Clarify the naming in the new file.\nVERDICT: CHANGES_REQUESTED`;
    onEvent({ type: 'agent_text', text });
    return { text, changedFiles: [], iterations: 1 };
  }

  // qa
  const text = `Ran smoke checks against the change for "${task.title}". Everything behaves as expected.\nVERDICT: PASSED`;
  onEvent({ type: 'agent_text', text });
  return { text, changedFiles: [], iterations: 1 };
}
