// Agent loop implemented directly on the Claude Messages API (no SDK).
import { TOOL_DEFS, createToolExecutor } from './tools.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_ITERATIONS = 40;

/**
 * Run one agentic episode: system prompt + user message, tool-use loop
 * until the model answers with plain text (or iteration cap).
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.system   role system prompt
 * @param {string} opts.userMessage
 * @param {string} opts.workspace absolute path of workspace root
 * @param {(evt: object) => void} opts.onEvent  progress callback (tool calls, text)
 * @param {boolean} [opts.requireChanges]  nudge the agent if it finishes without touching any file
 * @param {() => Promise<boolean>} [opts.hasChanges]  extra change detector (e.g. git status) so
 *   shell-made edits don't trigger a false nudge
 * @returns {Promise<{ text: string, changedFiles: string[], iterations: number, usage: object }>}
 */
export async function runAgentEpisode({ apiKey, model, system, userMessage, workspace, onEvent = () => {}, requireChanges = false, hasChanges = null }) {
  const { execute, changedFiles } = createToolExecutor(workspace);
  const messages = [{ role: 'user', content: userMessage }];
  let finalText = '';
  let nudges = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await callClaude({ apiKey, model, system, messages });
    if (resp.usage) {
      usage.input += resp.usage.input_tokens || 0;
      usage.output += resp.usage.output_tokens || 0;
      usage.cacheRead += resp.usage.cache_read_input_tokens || 0;
      usage.cacheWrite += resp.usage.cache_creation_input_tokens || 0;
      usage.calls += 1;
    }

    const textParts = resp.content.filter((b) => b.type === 'text').map((b) => b.text);
    const toolUses = resp.content.filter((b) => b.type === 'tool_use');

    if (textParts.length) {
      finalText = textParts.join('\n');
      onEvent({ type: 'agent_text', text: finalText });
    }

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      // Empty submission guard: the model sometimes announces a plan and ends
      // its turn without writing anything. Push back in the same conversation.
      const anyChanges = changedFiles.size > 0 || (hasChanges ? await hasChanges() : false);
      if (requireChanges && !anyChanges && nudges < 2) {
        nudges += 1;
        onEvent({ type: 'nudge', attempt: nudges });
        messages.push({ role: 'assistant', content: resp.content });
        messages.push({
          role: 'user',
          content:
            'You ended your turn without modifying ANY file — the diff is empty, so there is nothing to review. ' +
            'Implement the task NOW using the write_file tool (create or modify the actual files). ' +
            'Do not describe a plan; make the changes.',
        });
        continue;
      }
      return { text: finalText, changedFiles: [...changedFiles], iterations: i + 1, usage };
    }

    messages.push({ role: 'assistant', content: resp.content });

    const results = [];
    for (const tu of toolUses) {
      onEvent({ type: 'tool_call', tool: tu.name, input: summarizeInput(tu.name, tu.input) });
      const output = await execute(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    text: finalText || '[agent hit iteration limit without a final answer]',
    changedFiles: [...changedFiles],
    iterations: MAX_ITERATIONS,
    usage,
  };
}

function summarizeInput(tool, input) {
  if (tool === 'write_file') return { path: input.path, bytes: (input.content || '').length };
  if (tool === 'run_command') return { command: (input.command || '').slice(0, 200) };
  return input;
}

async function callClaude({ apiKey, model, system, messages }) {
  // Prompt caching: breakpoint on system (covers tools+system prefix) and on
  // the last block of the last message, so each loop iteration reuses the
  // previous iteration's cached conversation prefix (reads cost ~10%).
  const msgs = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
  }));
  const last = msgs[msgs.length - 1];
  last.content = last.content.map((block, i) =>
    i === last.content.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block
  );

  const body = {
    model,
    max_tokens: 8192,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: msgs,
    tools: TOOL_DEFS,
  };

  // Retry on 429/5xx with backoff.
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const errText = await res.text().catch(() => '');
    lastErr = new Error(`Claude API ${res.status}: ${errText.slice(0, 500)}`);
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    throw lastErr; // 4xx other than 429 — do not retry
  }
  throw lastErr;
}
