#!/usr/bin/env node
// Browser smoke test helper for QA agents.
// Usage: node browser-smoke.mjs <path-to-index.html | URL> [screenshot.png]
// Prints a JSON report: page title, console errors, uncaught exceptions,
// failed requests, screenshot path. Always exits 0 (report-only tool).
import path from 'node:path';
import { existsSync } from 'node:fs';

const arg = process.argv[2];
const shot = process.argv[3] || 'browser-smoke.png';

function out(obj) {
  console.log(JSON.stringify(obj, null, 1));
  process.exit(0);
}

if (!arg) out({ error: 'Usage: node browser-smoke.mjs <path-or-url> [screenshot.png]' });

let pw;
try {
  pw = await import('playwright');
} catch {
  out({
    skipped: true,
    reason:
      'playwright nije instaliran — browser test preskočen. Instalacija (jednokratno, u agent-harness folderu): ' +
      'npm i playwright && npx playwright install chromium',
  });
}

const url = /^https?:\/\//.test(arg) ? arg : 'file://' + path.resolve(arg);
if (url.startsWith('file://') && !existsSync(path.resolve(arg))) out({ error: `Fajl ne postoji: ${arg}` });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await pw.chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url().slice(0, 200)} — ${r.failure()?.errorText}`));

  await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
  await page.waitForTimeout(4000); // let app JS run (games, async init)
  await page.screenshot({ path: shot, fullPage: false });

  out({
    url,
    title: await page.title(),
    consoleErrors,
    pageErrors,
    failedRequests: failedRequests.slice(0, 10),
    screenshot: path.resolve(shot),
    verdictHint: consoleErrors.length || pageErrors.length ? 'GREŠKE POSTOJE — pogledaj gore' : 'nema JS grešaka',
  });
} catch (err) {
  out({ error: String(err).slice(0, 300), consoleErrors, pageErrors });
} finally {
  await browser.close();
}
