const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// ── Dedicated data location — do NOT share with other crucible builds ────────
// Default userData would be ~/Library/Application Support/crucible, which every
// crucible build on this machine collides on. Pin a unique name + path so this
// app owns its cookies/cache/storage exclusively.
app.setName('crucible-local');
app.setPath('userData', path.join(app.getPath('appData'), 'crucible-local'));

// 1.2 — All server user-data (corpus DB, learned state, history under .crucible/)
// relocates to the standard app-data dir by spawning the server with this as cwd.
// Every server path keys off process.cwd(), so this one lever moves all of it and
// it survives app updates / reinstalls. Code (the frontend bundle) stays in the
// app dir — server.ts pins FRONTEND_BUILD to its own script dir (CODE_DIR).
const DATA_DIR = app.getPath('userData');

let mainWindow;
let loadingWindow;
let tray = null;
let serverProc;
let viteProc;
let buildProc;
let healProc;
let serverReady = false;

// ── Server entry resolution (1.1) ─────────────────────────────────────────────
// Prefer the pre-compiled bundle (server-dist/server.js) for ~2s cold start.
// Fall back to `npx tsx server.ts` for source/dev runs (20s+ start).
const BUNDLE = path.join(__dirname, 'server-dist', 'server.js');
const SERVER_TS = path.join(__dirname, 'server.ts');
// Use the precompiled bundle ONLY when packaged (no tsx/source available). In a
// source run a leftover server-dist/ must NOT hijack the launch — always run the
// fresh server.ts via tsx so the running code matches the repo. (A stale bundle was
// failing with "Dynamic require of fs is not supported" and wedging server startup.)
const USE_BUNDLE = app.isPackaged && fs.existsSync(BUNDLE);

// In production the express server serves the built frontend on :3001.
// In dev, Vite serves it on :5173 with HMR.
const FRONTEND_URL = app.isPackaged ? 'http://localhost:3001' : 'http://localhost:5173';

function waitForPort(port, retries = 60, delay = 1000) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://localhost:${port}`, () => resolve()).on('error', () => {
        if (n <= 0) return reject(new Error(`Port ${port} never ready`));
        setTimeout(() => attempt(n - 1), delay);
      });
    };
    attempt(retries);
  });
}

function spawnBackend() {
  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
    FORCE_COLOR: '0',
    CRUCIBLE_DATA_DIR: DATA_DIR,
  };

  if (USE_BUNDLE) {
    // Run the bundle through Electron's own Node (no system node dependency).
    serverProc = spawn(process.execPath, [BUNDLE], {
      cwd: DATA_DIR,
      shell: false,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } else {
    // Dev/source path — absolute server.ts path because cwd is the data dir.
    serverProc = spawn('/opt/homebrew/bin/npx', ['tsx', SERVER_TS], {
      cwd: DATA_DIR,
      shell: false,
      env,
    });
  }
  serverProc.stdout.on('data', d => console.log('[server]', d.toString().trim()));
  serverProc.stdout.on('error', () => {});
  serverProc.stderr.on('data', d => console.error('[server:err]', d.toString().trim()));
  serverProc.on('exit', () => { serverReady = false; updateTray(); });

  // Vite is only needed when NOT packaged (dev frontend with HMR).
  if (!app.isPackaged) {
    viteProc = spawn('/opt/homebrew/bin/npx', ['vite'], { cwd: __dirname, shell: false, env });
    viteProc.stdout.on('data', d => console.log('[vite]', d.toString().trim()));
    viteProc.stdout.on('error', () => {});
    viteProc.stderr.on('data', d => console.error('[vite:err]', d.toString().trim()));
  }
}

function killBackend() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  if (viteProc) { viteProc.kill(); viteProc = null; }
  if (buildProc) { try { buildProc.kill(); } catch (e) {} buildProc = null; }
  if (healProc) { try { healProc.kill(); } catch (e) {} healProc = null; }
}

function restartBackend() {
  console.log('[electron] restarting backend…');
  killBackend();
  serverReady = false;
  updateTray();
  spawnBackend();
  waitForPort(3001).then(() => { serverReady = true; updateTray(); }).catch(() => {});
}

// ── Self-authored status-dot icon (1.4) ───────────────────────────────────────
// No external/stock images (UI rule): the menu-bar dot is generated in-process as
// a real 16x16 RGBA PNG — green when the server is up, red when it's down.
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}
function makeDot(r, g, b) {
  const W = 16, H = 16;
  const rgba = Buffer.alloc(W * H * 4);
  const cx = 7.5, cy = 7.5, rad = 6.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = inside ? 255 : 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  return nativeImage.createFromBuffer(png);
}
const DOT_GREEN = () => makeDot(34, 197, 94);
const DOT_RED = () => makeDot(239, 68, 68);

function updateTray() {
  if (!tray) return;
  tray.setImage(serverReady ? DOT_GREEN() : DOT_RED());
  tray.setToolTip(`Crucible — server ${serverReady ? 'running' : 'stopped'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: serverReady ? 'Server: running' : 'Server: stopped', enabled: false },
    { type: 'separator' },
    { label: 'Open Crucible', click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else if (serverReady) { createWindow(); }
        else if (loadingWindow) { loadingWindow.show(); loadingWindow.focus(); }
        else { createLoadingWindow().then(boot); }
      } },
    { label: 'Restart Server', click: restartBackend },
    { type: 'separator' },
    { label: 'Quit Crucible', click: () => { killBackend(); app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(serverReady ? DOT_GREEN() : DOT_RED());
  updateTray();
}

// ── Loading / status window ────────────────────────────────────────────────────
// Shown immediately on launch so the user sees the app come alive — never a terminal.
// Clean Crucible wordmark + a status line; on a build failure it shows the error and
// a Retry button (no terminal dump). Self-authored HTML, no external assets (UI rule).
function loadingHTML() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#09090b;color:#e7e7ea;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-user-select:none;cursor:default}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:0 28px}
    .mark{font-size:30px;font-weight:600;letter-spacing:.34em;padding-left:.34em;color:#f4f4f6}
    .bar{width:170px;height:2px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden}
    .bar>i{display:block;height:100%;width:38%;border-radius:2px;
      background:linear-gradient(90deg,#4db89e,#7c7cf8);animation:slide 1.15s cubic-bezier(.4,0,.2,1) infinite}
    @keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(340%)}}
    .status{font-size:12px;letter-spacing:.06em;color:rgba(200,205,215,.55);min-height:16px;text-align:center}
    .err{display:none;flex-direction:column;align-items:center;gap:14px;max-width:100%}
    .err .t{font-size:13px;font-weight:600;color:#f2b8b8}
    .err pre{max-width:520px;max-height:180px;overflow:auto;text-align:left;font-size:10.5px;line-height:1.5;
      color:#f2b8b8;background:rgba(255,90,90,.06);border:1px solid rgba(255,90,90,.18);
      border-radius:8px;padding:10px 12px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace}
    .btn{cursor:pointer;border:1px solid rgba(124,124,248,.4);background:rgba(124,124,248,.14);
      color:#cfd0ff;font:inherit;font-size:12px;font-weight:600;padding:7px 20px;border-radius:8px}
    .hidden{display:none!important}
  </style></head><body><div class="wrap">
    <div class="mark">CRUCIBLE</div>
    <div id="live" class="bar"><i></i></div>
    <div id="status" class="status">Starting…</div>
    <div id="err" class="err">
      <div class="t">Build failed</div>
      <pre id="errmsg"></pre>
      <button class="btn" onclick="document.title='RETRY'">Retry</button>
    </div>
  </div><script>
    window.setStatus=t=>{var s=document.getElementById('status');if(s)s.textContent=t};
    window.setError=m=>{document.getElementById('live').classList.add('hidden');
      document.getElementById('status').classList.add('hidden');
      document.getElementById('errmsg').textContent=m;document.getElementById('err').style.display='flex'};
    window.clearError=()=>{document.getElementById('live').classList.remove('hidden');
      document.getElementById('status').classList.remove('hidden');
      document.getElementById('err').style.display='none';document.title='Crucible'};
  </script></body></html>`;
}

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 460, height: 320, resizable: false, frame: false, center: true,
    backgroundColor: '#09090b', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // Retry button signals the main process via the page title (no preload needed).
  loadingWindow.webContents.on('page-title-updated', (e, title) => {
    if (title === 'RETRY' && !mainWindow) { loadingSay('Retrying…'); boot(); }
  });
  loadingWindow.on('closed', () => { loadingWindow = null; });
  const ready = new Promise(res => loadingWindow.webContents.once('did-finish-load', res));
  loadingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loadingHTML()));
  loadingWindow.once('ready-to-show', () => loadingWindow && loadingWindow.show());
  return ready;
}

function loadingSay(text) {
  if (!loadingWindow || loadingWindow.isDestroyed()) return;
  loadingWindow.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)})`).catch(() => {});
}
function loadingError(text) {
  if (!loadingWindow || loadingWindow.isDestroyed()) return;
  loadingWindow.webContents.executeJavaScript(`window.clearError();window.setError(${JSON.stringify(text)})`).catch(() => {});
}
function closeLoading() {
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
  loadingWindow = null;
}

// ── Auto-build / self-heal (source runs only; packaged apps ship prebuilt) ───────
function bin(name) {
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return name;
}
const BUILD_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'app', 'release', '.crucible', 'server-dist', '.turbo', '.cache']);
function newestMtime(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.mtimeMs;
    let m = st.mtimeMs;
    for (const e of fs.readdirSync(p)) { if (!BUILD_SKIP.has(e) && !e.startsWith('.')) m = Math.max(m, newestMtime(path.join(p, e))); }
    return m;
  } catch (e) { return 0; }
}
// Rebuild only if a frontend source is newer than the last build output (app/index.html).
function sourcesChanged() {
  let builtAt;
  try { builtAt = fs.statSync(path.join(__dirname, 'app', 'index.html')).mtimeMs; } catch (e) { return true; }
  const srcs = ['src', 'index.html', 'vite.config.ts', 'package.json'].map(s => newestMtime(path.join(__dirname, s)));
  return Math.max.apply(null, srcs) > builtAt;
}

function buildEnv() {
  return {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
    FORCE_COLOR: '0',
  };
}

function runBuild() {
  return new Promise(resolve => {
    let out = '';
    buildProc = spawn(bin('npm'), ['run', 'build'], { cwd: __dirname, shell: false, env: buildEnv() });
    buildProc.stdout.on('data', d => { out += d.toString(); });
    buildProc.stderr.on('data', d => { out += d.toString(); });
    buildProc.on('error', err => { buildProc = null; resolve({ ok: false, out: out + '\n' + err.message }); });
    buildProc.on('close', code => { buildProc = null; resolve({ ok: code === 0, out }); });
  });
}

function runHeal(buildOut) {
  return new Promise(resolve => {
    healProc = spawn(bin('npx'), ['tsx', path.join('scripts', 'selfHeal.ts')], { cwd: __dirname, shell: false, env: buildEnv() });
    healProc.stdout.on('data', d => console.log('[heal]', d.toString().trim()));
    healProc.stderr.on('data', d => console.error('[heal:err]', d.toString().trim()));
    healProc.on('error', () => { healProc = null; resolve(false); });
    healProc.on('close', code => { healProc = null; resolve(code === 0); });
    try { healProc.stdin.write(buildOut || ''); healProc.stdin.end(); } catch (e) {}
  });
}

// Returns true to proceed to launch, false if a fatal build error is being shown.
async function ensureBuilt() {
  // Only source runs with the app-mode flag auto-build. Packaged apps ship prebuilt;
  // plain `npm run electron` keeps its existing (no-gate) behavior — no regression.
  if (app.isPackaged || process.env.CRUCIBLE_APP_MODE !== '1') return true;
  if (!fs.existsSync(path.join(__dirname, 'server.ts'))) return true; // not a source checkout
  loadingSay('Checking build…');
  if (!sourcesChanged()) return true;

  loadingSay('Building…');
  let r = await runBuild();
  if (!r.ok) {
    loadingSay('Build failed — self-healing…');
    await runHeal(r.out);
    loadingSay('Rebuilding…');
    r = await runBuild();
  }
  if (!r.ok) {
    const lines = r.out.split('\n').filter(l => /error TS\d+|error:|Error:/.test(l));
    loadingError((lines.length ? lines.slice(0, 14).join('\n') : r.out.slice(-1200)).trim() || 'Unknown build error.');
    return false;
  }
  return true;
}

// ── Boot sequence: build (if needed) → server → window. All inside the app. ──────
async function boot() {
  loadingSay('Starting…');
  if (!serverReady) {
    const okToLaunch = await ensureBuilt();
    if (!okToLaunch) return; // error screen + Retry is showing

    loadingSay('Starting server…');
    if (!serverProc) spawnBackend();
    try {
      const ports = app.isPackaged ? [waitForPort(3001)] : [waitForPort(3001), waitForPort(5173)];
      await Promise.all(ports);
      serverReady = true;
      updateTray();
    } catch (err) {
      loadingError('Server did not start on port 3001.\n' + err.message);
      return;
    }
  }
  loadingSay('Ready');
  // Brief settle so the React app paints before we reveal it (avoids a white flash).
  await new Promise(r => setTimeout(r, app.isPackaged ? 400 : 1500));
  createWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#09090b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  // Hand off from the loading window only once the React app has actually painted.
  mainWindow.webContents.once('did-finish-load', closeLoading);
  setTimeout(closeLoading, 8000); // safety net so the loader never lingers
  mainWindow.loadURL(FRONTEND_URL);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    // 1.4 — auto-start at login (packaged app only; never hijack a dev machine).
    if (app.isPackaged) {
      try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) { console.error('[electron] login item failed', e.message); }
    }

    // 4.5 — background auto-update from GitHub Releases (packaged only). Guarded so
    // a missing electron-updater dep degrades gracefully instead of crashing boot.
    if (app.isPackaged) {
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = true;
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
        setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
      } catch (e) { console.log('[electron] auto-update unavailable:', e.message); }
    }

    createTray();
    // Show the loading window immediately, then run the full boot sequence inside the
    // app: build-if-needed → self-heal → server → main window. Zero terminal interaction.
    await createLoadingWindow();
    console.log(`[electron] boot${app.isPackaged ? '' : ' (source)'}… (${USE_BUNDLE ? 'bundle' : 'tsx'})`);
    boot().catch(err => {
      console.error('[electron] boot failed:', err.message);
      loadingError('Startup failed.\n' + (err && err.message ? err.message : String(err)));
    });
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray (menu-bar presence). Quit only via the tray menu.
    if (process.platform !== 'darwin') { killBackend(); app.quit(); }
  });

  app.on('before-quit', killBackend);

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
}
