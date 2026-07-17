#!/usr/bin/env node
// Mobile (Expo/React Native) smoke test helper for QA agents.
//
// Usage:
//   node mobile-smoke.mjs <path-to-expo-app-dir>          # static checks (L1)
//   node mobile-smoke.mjs <path-to-expo-app-dir> --sim    # + boot iOS simulator,
//                                                          load the app in Expo Go,
//                                                          screenshot, Metro errors (L2)
//
// Prints a JSON report and always exits 0 (report-only tool).
// With --sim it LEAVES Metro and the simulator running so the QA agent can
// drive Maestro flows (appId: host.exp.Exponent) against the live app —
// kill the reported metroPid when done.
import { execFile, spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const appDir = process.argv[2];
const withSim = process.argv.includes('--sim');

// Pick a genuinely free port — a fixed one can silently collide with another
// app on IPv4 (seen live: CapCut on 8901) and Expo Go then hits the wrong server.
async function freePort(start) {
  for (let p = start; p < start + 30; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '0.0.0.0');
    });
    if (ok) return p;
  }
  return start + 31;
}
const EXPO_PORT = Number(process.env.MOBILE_SMOKE_PORT || await freePort(8911));

function out(obj) {
  console.log(JSON.stringify(obj, null, 1));
  process.exit(0);
}

const report = { appDir, node: process.version, checks: {}, sim: null, maestro: null, hints: [] };

if (!appDir) out({ error: 'Usage: node mobile-smoke.mjs <expo-app-dir> [--sim]' });
if (Number(process.version.slice(1).split('.')[0]) < 18) {
  out({ error: `Node ${process.version} je prestar za Expo — pokreni sa Node 18+ (npr. "source ~/.nvm/nvm.sh && nvm use 20" pa ponovo).` });
}

const dir = path.resolve(appDir);
let pkg;
try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); }
catch { out({ skipped: true, reason: `Nema package.json u ${dir}` }); }
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
if (!deps.expo) out({ skipped: true, reason: 'Nije Expo projekat (nema "expo" u dependencies) — koristi browser-smoke.mjs za web.' });

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: opts.cwd || dir,
      timeout: opts.timeout || 240_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
    }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), code: err ? (err.code ?? 1) : 0 }));
  });

const tail = (s, n = 25) => String(s || '').trim().split('\n').slice(-n).join('\n');

// ---------- L1: static checks ----------
// 1) TypeScript
if (existsSync(path.join(dir, 'tsconfig.json'))) {
  const r = await run('npx', ['tsc', '--noEmit']);
  report.checks.tsc = { passed: r.ok, output: r.ok ? 'bez grešaka' : tail(r.out + r.err) };
} else {
  report.checks.tsc = { skipped: 'nema tsconfig.json' };
}

// 2) expo-doctor (config/version health)
{
  const r = await run('npx', ['expo-doctor'], { timeout: 180_000 });
  report.checks.expoDoctor = { passed: r.ok, output: tail(r.out + r.err, 15) };
}

// 3) production bundle build — catches import/babel/module errors without a device
{
  const outDir = path.join(os.tmpdir(), `expo-export-${Date.now()}`);
  const r = await run('npx', ['expo', 'export', '--platform', 'ios', '--output-dir', outDir], { timeout: 420_000 });
  report.checks.bundleExport = { passed: r.ok, output: r.ok ? 'bundle se gradi' : tail(r.out + r.err, 30) };
  await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
}

// ---------- maestro availability (L3 is driven by the QA agent itself) ----------
{
  const which = await run('bash', ['-lc', 'command -v maestro || ls "$HOME/.maestro/bin/maestro" 2>/dev/null']);
  report.maestro = which.ok && which.out.trim()
    ? { available: true, path: which.out.trim().split('\n')[0] }
    : { available: false, hint: 'curl -Ls https://get.maestro.mobile.dev | bash (traži Java 17+)' };
}

// ---------- L2: simulator run ----------
if (withSim) {
  const sim = { booted: false, screenshot: null, metroErrors: [], metroPid: null };
  report.sim = sim;
  const simctl = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeout: 30_000 });
  if (!simctl.ok) {
    sim.skipped = 'xcrun simctl nedostupan (nema Xcode?)';
  } else {
    let udid = null;
    try {
      const devices = Object.values(JSON.parse(simctl.out).devices).flat();
      const booted = devices.find((d) => d.state === 'Booted');
      const pick = booted
        || devices.find((d) => /iPhone 1[5-9]/.test(d.name))
        || devices.find((d) => /iPhone 14 Pro$/.test(d.name))
        || devices.find((d) => /iPhone/.test(d.name));
      udid = pick?.udid || null;
      sim.device = pick?.name || null;
      if (udid && !booted) await run('xcrun', ['simctl', 'boot', udid], { timeout: 120_000 });
      if (udid) { sim.booted = true; sim.udid = udid; }
    } catch { sim.skipped = 'ne mogu da parsiram listu simulatora'; }

    if (udid) {
      // Make the Simulator window visible (best effort — headless still works).
      await run('open', ['-a', 'Simulator'], { timeout: 15_000 }).catch(() => {});
      // If Expo Go is already on the simulator we open the app via simctl openurl
      // (no AppleScript involved); otherwise let `expo start --ios` install it.
      const apps = await run('xcrun', ['simctl', 'listapps', udid], { timeout: 30_000 });
      const hasExpoGo = apps.out.includes('host.exp.Exponent');
      sim.expoGoInstalled = hasExpoGo;

      const metroLog = [];
      const args = hasExpoGo
        ? ['expo', 'start', '--port', String(EXPO_PORT)]
        : ['expo', 'start', '--ios', '--port', String(EXPO_PORT)];
      const child = spawn('npx', args, {
        cwd: dir, detached: true,
        env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
      });
      sim.metroPid = child.pid;
      child.stdout.on('data', (d) => metroLog.push(String(d)));
      child.stderr.on('data', (d) => metroLog.push(String(d)));
      child.unref();

      if (hasExpoGo) {
        // give Metro a moment to come up, then deep-link the app into Expo Go
        await new Promise((r) => setTimeout(r, 7000));
        await run('xcrun', ['simctl', 'openurl', udid, `exp://127.0.0.1:${EXPO_PORT}`], { timeout: 30_000 });
      }

      // Wait for the bundle to build (or errors), max ~3 min (first Expo Go install can be slow).
      const deadline = Date.now() + 180_000;
      let bundled = false;
      while (Date.now() < deadline) {
        const log = metroLog.join('');
        if (/Bundled\s|iOS Bundled/.test(log)) { bundled = true; break; }
        if (/error: |Unable to resolve|Failed to|FATAL/i.test(log)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      // give the app a moment to render after bundling
      if (bundled) await new Promise((r) => setTimeout(r, 8000));

      const log = metroLog.join('');
      sim.bundled = bundled;
      sim.metroErrors = [...new Set(
        log.split('\n').filter((l) => /error|exception|unable to resolve|failed|redbox/i.test(l)).map((l) => l.trim().slice(0, 250))
      )].slice(0, 15);
      if (/osascript/.test(log) && !hasExpoGo) {
        sim.metroErrors = sim.metroErrors.filter((l) => !/osascript/.test(l));
        report.hints.push(
          'Expo Go nije instaliran na simulatoru, a automatska instalacija nije mogla (osascript). ' +
          'Jednokratno u svom terminalu pokreni: cd <app-dir> && npx expo start --ios  (instalira Expo Go) — posle toga ovaj skript koristi direktan openurl.'
        );
      }

      const shot = path.join(os.tmpdir(), `mobile-smoke-${Date.now()}.png`);
      const sc = await run('xcrun', ['simctl', 'io', udid, 'screenshot', shot], { timeout: 30_000 });
      if (sc.ok) sim.screenshot = shot;

      report.hints.push(
        `Metro i simulator su OSTAVLJENI da rade (metroPid ${child.pid}, port ${EXPO_PORT}) — možeš da pokrećeš Maestro flow-ove (appId: host.exp.Exponent). Kad završiš: kill ${child.pid}`,
        'Screenshot pogledaj svojim Read alatom da proceniš da li se ekran ispravno renderuje.'
      );
    }
  }
}

report.verdictHint =
  Object.values(report.checks).some((c) => c && c.passed === false) || (report.sim && (report.sim.metroErrors || []).length)
    ? 'IMA PROBLEMA — vidi checks/metroErrors iznad'
    : 'statičke provere čiste' + (report.sim?.bundled ? ' + aplikacija se učitava na simulatoru' : '');

out(report);
