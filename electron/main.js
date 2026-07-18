// Electron main process for Agent Harness.
//
// Responsibilities:
//   1. Find a free TCP port (net server on port 0 → read port → close).
//   2. Load API keys from <userData>/keys.json ({"anthropicKey":"...","kimiKey":"..."}).
//   3. Spawn server/index.js as a child (process.execPath + ELECTRON_RUN_AS_NODE=1)
//      with PORT=<free port> and HARNESS_DATA_DIR=<userData>, forwarding the whole
//      existing process.env (so CLAUDE_CODE_OAUTH_TOKEN passes through untouched).
//   4. Open a BrowserWindow loading the running UI, or the setup screen when no keys
//      are configured (neither in keys.json nor in the environment).
//
// Key values are NEVER logged (console or file).
import { app, BrowserWindow, ipcMain } from 'electron';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const SETUP_HTML = path.join(__dirname, 'setup.html');

let serverProcess = null;
let serverPort = 0;
let mainWindow = null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- (1) Free port: bind on 0, read the assigned port, release it.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---- (2) Keys stored at <userData>/keys.json, written with mode 0600.
function keysPath() {
  return path.join(app.getPath('userData'), 'keys.json');
}

// Returns { anthropicKey, kimiKey } — empty strings when absent. Never logs values.
function readKeys() {
  try {
    const raw = fs.readFileSync(keysPath(), 'utf8');
    const j = JSON.parse(raw) || {};
    return {
      anthropicKey: (j.anthropicKey || '').trim(),
      kimiKey: (j.kimiKey || '').trim(),
    };
  } catch {
    return { anthropicKey: '', kimiKey: '' };
  }
}

function writeKeys({ anthropicKey, kimiKey }) {
  const data = JSON.stringify({
    anthropicKey: (anthropicKey || '').trim(),
    kimiKey: (kimiKey || '').trim(),
  });
  const file = keysPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode: 0o600 });
  // writeFile's mode only applies on creation — force perms on existing files too.
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

// True when at least one Anthropic/Kimi key is available from keys.json OR the env.
function hasAnyKey() {
  const keys = readKeys();
  const envAnthropic = (process.env.ANTHROPIC_API_KEY || '').trim();
  const envKimi = (process.env.KIMI_API_KEY || '').trim();
  return !!(keys.anthropicKey || keys.kimiKey || envAnthropic || envKimi);
}

// ---- (3) Spawn the server child with the proper env, wait until it listens.
async function startServer() {
  serverPort = await getFreePort();
  const keys = readKeys();

  // Forward the whole existing env (keeps CLAUDE_CODE_OAUTH_TOKEN, PATH, etc.),
  // run the server bundle as plain Node, and point it at the userData dir.
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(serverPort),
    HARNESS_DATA_DIR: app.getPath('userData'),
  };
  // Only inject keys when non-empty; empty values must not clobber env-provided keys.
  if (keys.anthropicKey) env.ANTHROPIC_API_KEY = keys.anthropicKey;
  if (keys.kimiKey) env.KIMI_API_KEY = keys.kimiKey;

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    env,
    stdio: 'inherit',
  });
  serverProcess.on('exit', () => { serverProcess = null; });

  await waitForServer(serverPort);
}

function killServer() {
  if (serverProcess) {
    const proc = serverProcess;
    serverProcess = null;
    try { proc.kill(); } catch { /* already gone */ }
  }
}

// Poll GET http://127.0.0.1:<port>/ until the server answers.
function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(port, tries = 150) {
  for (let i = 0; i < tries; i++) {
    if (await ping(port)) return true;
    await delay(100);
  }
  return false;
}

// ---- (4) Window: main UI from localhost, or the setup screen.
function loadMain() {
  if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}
function loadSetup() {
  if (mainWindow) mainWindow.loadFile(SETUP_HTML);
}

function createWindow() {
  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
  };
  // preload.js is delivered by another task — main must work without it too.
  if (fs.existsSync(PRELOAD_PATH)) webPreferences.preload = PRELOAD_PATH;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences,
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (hasAnyKey()) loadMain();
  else loadSetup();
}

// ---- IPC handlers. Key values are never logged.
ipcMain.handle('keys:get', () => readKeys());

ipcMain.handle('keys:save', async (_e, { anthropicKey, kimiKey } = {}) => {
  writeKeys({ anthropicKey, kimiKey });
  killServer();
  await startServer();
  loadMain();
  return { ok: true };
});

ipcMain.on('setup:open', () => loadSetup());

// ---- App lifecycle.
app.whenReady().then(async () => {
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the last window quits and takes the server child with it.
app.on('window-all-closed', () => {
  killServer();
  app.quit();
});

app.on('before-quit', killServer);
process.on('exit', killServer);
