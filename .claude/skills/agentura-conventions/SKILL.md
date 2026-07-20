---
name: agentura-conventions
description: Hard project rules for working on the Agentura codebase (zero-dependency multi-agent harness) — read before changing anything.
---

## Stack & commands

- Pure Node.js >= 18, ESM (`"type": "module"`). The server (`server/`) and UI (`public/`) have ZERO runtime dependencies — adding an npm package to them is a rejected change. devDependencies exist only for the Electron shell (`electron`, `electron-builder`).
- Run: `npm start` (port 4400). Never start a dev/test server on the default port — a live instance may already run there. For testing use `PORT=<other> HARNESS_DATA_DIR=<tmp dir> node server/index.js` so real sessions in `data/` are untouched.
- Tests: `node --test server/*.test.mjs` (Node 20 via `source ~/.nvm/nvm.sh && nvm use 20`). The mock engine (no API keys in env) simulates the full plan→review→QA→merge pipeline — use it to e2e-test orchestrator changes without spending tokens.

## i18n (mandatory for every user-facing string)

- Server: English string IS the catalog key — write `t('English text {x}', { x })` from `server/i18n.js` and add the English→Serbian pair to the `SR` map in the same commit. UI (`public/index.html`): same pattern with the `SR_UI` map + `t()`; static markup uses English text plus `data-i18n` attributes.
- NEVER translate or reword machine-compared strings: `VERDICT: PASSED|FAILED|APPROVED|CHANGES_REQUESTED`, task statuses (`queued`, `coding`, `in_review`, `in_qa`, `done`, `stuck`, `needs_fix`, `awaiting_merge`), phases, engine ids (`api`, `claude-code`, `kimi`), branch names `harness/task-N`, git commit message prefixes (`baseline`, `pre-harness snapshot`, `mid-run workspace snapshot`, `task #N:`, `solo:`).
- In `server/orchestrator.js` and `public/index.html`, `t` is the translation function — never name a loop variable or callback parameter `t` (this has caused shadowing bugs; use `task`, `tk`, `x`).

## Security rules (non-negotiable)

- API keys live ONLY in `.env` (server) or Electron `userData/keys.json` (written mode 0600). Keys must never appear in: git history, console logs, run snapshots (`saveSnapshot` destructures them OUT of config — keep it that way), emails, or error messages.
- The HTTP server binds `127.0.0.1` by default; agents run with `--dangerously-skip-permissions`, so exposing the port = remote code execution. Never change the default bind.
- `data/`, `.env`, `keys.json`, `HARNESS-NOTES.md`, `dist/`, `workspace-*/`, `.hwt-*/` are gitignored on purpose — never force-add them.

## Architecture invariants

- Engine paths: `api`/`kimi` go through `runAgentEpisode` (server/agent.js, Messages API + tools.js toolset); `claude-code` goes through `runClaudeCodeEpisode` (server/claude-code.js, headless `claude -p`, system prompt via `--append-system-prompt`); no key → `server/mock.js`. A feature touching episodes must work on ALL of them (mock may no-op).
- Kimi For Coding is Anthropic-compatible: same Messages format, `x-api-key` + `anthropic-version` headers, base URL `https://api.kimi.com/coding/v1/messages`. Thinking blocks from reasoning models are filtered out on history replay (`replayable()` in agent.js) — do not replay them.
- Claude Code child env: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are deliberately DELETED so the CLI bills the subscription, while `CLAUDE_CODE_OAUTH_TOKEN` passes through. Do not "fix" this.
- Pipeline tasks run in git worktrees (`.hwt-*`, branch `harness/task-N`) and merge into the main branch after QA; project-level reads (skills, notes) must use `config.workspacePath` (main checkout), never the worktree.
- Errors are classified as rate-limit/auth ONLY when the CLI result itself failed (`is_error || subtype !== 'success'`) — never regex-match agent prose for "401"/"limit" (caused false positives before).
- Episode timeouts are idle-based (`EPISODE_IDLE_MS` 10 min without output) + hard cap 90 min — do not reintroduce short wall-clock timeouts; healthy QA runs exceed 20 min.
- All SSE events carry `sessionId`; every new event type must be emitted through the orchestrator's emit callback so multi-session tabs stay isolated. Snapshots (`data/active/*.json`) are debounced (tmp+rename) and restored on boot — new run state belongs in the snapshot too, minus secrets.
- Electron: `electron/main.js` spawns the same `server/index.js` as a child with `ELECTRON_RUN_AS_NODE=1`, a free port, and `HARNESS_DATA_DIR=<userData>`; `npm start` must keep working unchanged without Electron.
