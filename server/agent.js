// Agent loop implemented directly on the Anthropic Messages API format (no SDK).
// Works against any Messages-compatible endpoint — Anthropic itself, or
// Kimi For Coding (https://api.kimi.com/coding/v1/messages).
import { TOOL_DEFS, createToolExecutor } from './tools.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
// Tool-loop cap. 40 proved too low in practice: Kimi reads files one by one and
// a big task (e.g. writing a full OpenAPI spec) legitimately needs 60-100 tool
// rounds — hitting the cap makes the agent submit EMPTY work and spin review
// cycles. Prompt caching keeps the extra rounds cheap.
const MAX_ITERATIONS = 120;
// History-size trigger (JSON chars) for pruning old tool_result payloads.
const PRUNE_AT = 240_000;

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
// Appended to every system prompt on the API engine: teaches the model to use
// the toolset efficiently (esp. models like Kimi that default to one small
// read per turn — which burns the iteration budget).
const TOOL_EFFICIENCY_NOTE =
  '\n\nTool efficiency (important): you may call MULTIPLE independent tools in a SINGLE turn — batch your reads. ' +
  'Use grep/glob to LOCATE code instead of reading files one by one. ' +
  'For large files, locate the code with grep first, then read only the relevant range via read_file offset/limit instead of the whole file. ' +
  'Use edit_file for partial changes instead of rewriting whole files; use write_file with append=true to build large files in chunks.';

/**
 * Replace bulky tool_result payloads in all but the last `keepLast` tool-result
 * messages with a short stub — the model can re-run the tool if it needs the
 * output again. Pure: returns new structures, never mutates the input; leaves
 * non-tool_result content (and small results) untouched.
 */
export function pruneHistory(messages, { keepLast = 10, minSize = 500 } = {}) {
  const idxs = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) idxs.push(i);
  });
  const prune = new Set(idxs.slice(0, Math.max(0, idxs.length - keepLast)));
  return messages.map((m, i) => {
    if (!prune.has(i)) return m;
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > minSize
          ? { ...b, content: `[pruned earlier tool output (${b.content.length} chars) — call the tool again if you need it]` }
          : b
      ),
    };
  });
}

export async function runAgentEpisode({ apiKey, model, system, userMessage, workspace, onEvent = () => {}, requireChanges = false, hasChanges = null, baseUrl = API_URL }) {
  const { execute, changedFiles } = createToolExecutor(workspace);
  system = system + TOOL_EFFICIENCY_NOTE;
  let messages = [{ role: 'user', content: userMessage }];
  let finalText = '';
  let nudges = 0;
  let pruneAt = PRUNE_AT;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  // Reasoning models (Kimi K2.x) return `thinking` blocks; replaying them in
  // history is unnecessary and can be rejected — keep only text/tool_use.
  const replayable = (content) => {
    const kept = content.filter((b) => b.type === 'text' || b.type === 'tool_use');
    return kept.length ? kept : [{ type: 'text', text: '(no output)' }]; // API rejects empty content
  };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Pruning rewrites the conversation prefix, which costs one prompt-cache
    // miss on the next request — that is why it fires at coarse thresholds
    // (every PRUNE_AT chars of growth) instead of on every iteration.
    const size = messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
    if (size > pruneAt) {
      messages = pruneHistory(messages);
      const after = messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
      onEvent({ type: 'context_pruned', before: size, after });
      pruneAt += PRUNE_AT;
    }
    const resp = await callClaude({ apiKey, model, system, messages, baseUrl });
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
        messages.push({ role: 'assistant', content: replayable(resp.content) });
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

    messages.push({ role: 'assistant', content: replayable(resp.content) });

    const results = [];
    for (const tu of toolUses) {
      onEvent({ type: 'tool_call', tool: tu.name, input: tu.input });
      const output = await execute(tu.name, tu.input);
      onEvent({ type: 'tool_result', tool: tu.name, output: String(output).slice(0, 2000) });
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

async function callClaude({ apiKey, model, system, messages, baseUrl }) {
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
    // 8192 chokes big single-file outputs (a full OpenAPI spec is 20k+ tokens).
    // Models that cap lower reject with a max_tokens 400 — handled below.
    max_tokens: 32_000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: msgs,
    tools: TOOL_DEFS,
  };

  // Retry on 429/5xx with backoff.
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(baseUrl || API_URL, {
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
    const apiName = /kimi/i.test(baseUrl || '') ? 'Kimi API' : 'Claude API';
    lastErr = new Error(`${apiName} ${res.status}: ${errText.slice(0, 500)}`);
    // Older/smaller models cap max_tokens below 32k — drop to 8192 and retry once.
    if (res.status === 400 && /max_tokens/i.test(errText) && body.max_tokens > 8192) {
      body.max_tokens = 8192;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    throw lastErr; // 4xx other than 429 — do not retry
  }
  throw lastErr;
}
