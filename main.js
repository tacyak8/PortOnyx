const { app, BrowserWindow, WebContentsView, ipcMain, session, powerMonitor, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFile } = require('child_process');
const createNotes = require('./notes');

// The app's display name. Change it here and the window and every screen pick it up.
const APP_NAME = 'Port Onyx';

const ROOT = __dirname;
const APPS_DIR = path.join(ROOT, 'apps');
const BAR = 40;                 // height of the tab strip in px
const IDLE_LOCK_MINUTES = 15;   // auto-lock after this much system idle time; 0 disables
const DEFAULT_ACCENT = '#6ea8ff';
const LAUNCH_EXTS = ['.exe', '.bat', '.cmd'];

// Keep all Electron data inside the Shell folder so it stays portable.
app.setPath('userData', path.join(ROOT, 'userdata'));
const AUTH_FILE = path.join(ROOT, 'userdata', 'auth.json');
const SETTINGS_FILE = path.join(ROOT, 'userdata', 'settings.json');
const DEFAULT_NOTES_DIR = path.join(ROOT, 'notes');
const NOTES_KEY = '__notes';     // tab id for the built-in notes view (app ids can't start with "_")

let win;
let active = 'home';
let unlocked = false;
let failures = 0;
let retryAt = 0;
let quitting = false;
let lastStatus = '';
let lastExternal = null;   // file the notes view last opened read-only (never taken from the page)
const tabs = new Map();          // appId -> { view, title }
const procs = new Map();         // appId -> { id, child, alive }  (programs started by the shell)
const waiters = new Map();       // appId -> { cancelled }         (waiting for a URL to answer)
const lockedSessions = new WeakSet();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the wall (localhost only, applies to tabs) ----------
function isLocal(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

function lockSession(ses) {
  if (lockedSessions.has(ses)) return;
  lockedSessions.add(ses);
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, cb) => cb({ cancel: !isLocal(details.url.replace(/^ws/, 'http')) })
  );
}

// ---------- password gate ----------
const hasPassword = () => fs.existsSync(AUTH_FILE);
const authState = () => (!hasPassword() ? 'setup' : unlocked ? 'unlocked' : 'locked');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });

function setPassword(pw) {
  const salt = crypto.randomBytes(16);
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify({
    v: 1, salt: salt.toString('hex'), hash: hashPw(pw, salt).toString('hex'),
  }));
}

function checkPassword(pw) {
  try {
    const { salt, hash } = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const got = hashPw(pw, Buffer.from(salt, 'hex'));
    const want = Buffer.from(hash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

function sendAuth() { win.webContents.send('auth', authState()); }

function lock() {
  unlocked = false;
  for (const t of tabs.values()) t.view.setVisible(false);   // apps keep running, just hidden
  sendAuth();
}

function unlock() {
  unlocked = true;
  failures = 0;
  activate(active);
  sendAuth();
}

const guarded = (fn) => (...a) => {
  if (!unlocked) throw new Error(`${APP_NAME} is locked`);
  return fn(...a);
};

// ---------- manifests ----------
function loadApps(withIcons = false) {
  if (!fs.existsSync(APPS_DIR)) return [];
  return fs.readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(APPS_DIR, d.name, 'app.json'), 'utf8'));
        const out = { id: d.name, ...m };
        if (withIcons && m.icon) {
          try {
            const buf = fs.readFileSync(path.join(APPS_DIR, d.name, path.basename(m.icon)));
            out.iconData = 'data:image/png;base64,' + buf.toString('base64');
          } catch { /* missing icon file: fall back to the letter badge */ }
        }
        return [out];
      } catch { return []; }
    });
}
const findApp = (id) => loadApps().find((a) => a.id === id);
const isKnownApp = (id) => !!findApp(id);

function uniqueSlug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  let id = base, i = 2;
  while (fs.existsSync(path.join(APPS_DIR, id))) id = base + '-' + (i++);
  return id;
}

function writeIcon(src, dest) {
  let img = nativeImage.createFromPath(src);
  if (img.isEmpty()) throw new Error('Could not read that image. Use PNG, JPG, BMP or ICO.');
  const { width, height } = img.getSize();
  const s = 256 / Math.max(width, height);
  if (s < 1) img = img.resize({ width: Math.round(width * s), height: Math.round(height * s), quality: 'best' });
  fs.writeFileSync(dest, img.toPNG());
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

async function saveApp(d) {
  const name = String(d.name || '').trim();
  const url = String(d.url || '').trim();
  const launch = String(d.launch || '').trim();
  const args = String(d.args || '').trim();
  const cwd = String(d.cwd || '').trim();
  const accent = /^#[0-9a-f]{6}$/i.test(d.accent || '') ? d.accent : DEFAULT_ACCENT;

  if (!name) return { ok: false, error: 'Give the app a name.' };
  if (!url && !launch) return { ok: false, error: 'Add a launch file, a URL, or both.' };
  if (url && !isLocal(url)) return { ok: false, error: `${APP_NAME} only opens localhost addresses (127.0.0.1 or localhost).` };
  if (launch) {
    if (!path.isAbsolute(launch) || !isFile(launch)) return { ok: false, error: 'Launch file not found. Use the full path.' };
    if (!LAUNCH_EXTS.includes(path.extname(launch).toLowerCase())) return { ok: false, error: 'Launch file must be .exe, .bat or .cmd.' };
  }
  if (cwd && !isDir(cwd)) return { ok: false, error: 'Working folder not found.' };

  let id = d.id;
  if (id) { if (!isKnownApp(id)) return { ok: false, error: 'That app no longer exists.' }; }
  else id = uniqueSlug(name);

  const dir = path.join(APPS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new app */ }

  const m = { ...existing, name, url, launch, args, cwd, accent };
  if (!m.clear) m.clear = { policy: 'never', scope: 'cache' };
  for (const k of ['url', 'launch', 'args', 'cwd']) if (!m[k]) delete m[k];

  try {
    if (d.iconPath) { writeIcon(d.iconPath, path.join(dir, 'icon.png')); m.icon = 'icon.png'; }
    else if (d.removeIcon) { fs.rmSync(path.join(dir, 'icon.png'), { force: true }); delete m.icon; }
  } catch (e) { return { ok: false, error: e.message }; }

  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  pushStatus();
  return { ok: true, id };
}

async function removeApp(id, eraseProfile) {
  if (!isKnownApp(id)) return { ok: false, error: 'Unknown app.' };
  const rec = procs.get(id);
  if ((rec && rec.alive) || waiters.has(id)) return { ok: false, error: 'Stop it first, then remove it.' };
  if (tabs.has(id)) closeTab(id);
  if (eraseProfile) await clearApp(id, ['all']);
  const dir = path.join(APPS_DIR, id);
  for (const f of ['app.json', 'icon.png', 'launch.log']) fs.rmSync(path.join(dir, f), { force: true });
  try { fs.rmdirSync(dir); } catch { /* folder still holds other files: leave them */ }
  procs.delete(id);
  pushStatus();
  return { ok: true };
}

// ---------- tabs ----------
function layout() {
  const { width, height } = win.getContentBounds();
  for (const t of tabs.values()) {
    t.view.setBounds({ x: 0, y: BAR, width, height: Math.max(0, height - BAR) });
  }
}

function sendState() {
  win.webContents.send('state', {
    active,
    tabs: [...tabs.entries()].map(([id, t]) => ({ id, title: t.title })),
  });
}

function activate(id) {
  active = tabs.has(id) ? id : 'home';
  for (const [tid, t] of tabs) t.view.setVisible(unlocked && tid === active);
  layout();
  sendState();
}

function openTab(appId) {
  if (tabs.has(appId)) return activate(appId);
  const meta = findApp(appId);
  if (!meta || !meta.url || !isLocal(meta.url)) return;

  const ses = session.fromPartition('persist:' + appId);
  lockSession(ses);

  const view = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!isLocal(url)) e.preventDefault(); });

  win.contentView.addChildView(view);
  tabs.set(appId, { view, title: meta.name });
  wc.loadURL(meta.url);
  activate(appId);
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);
  activate('home');
}

// ---------- built-in notes view ----------
function loadSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
const notesDir = () => loadSettings().notesDir || DEFAULT_NOTES_DIR;
const notesLib = createNotes(notesDir);

function openNotes() {
  if (tabs.has(NOTES_KEY)) return activate(NOTES_KEY);
  const ses = session.fromPartition('persist:' + NOTES_KEY);
  // The notes page never needs the network: refuse every request outright.
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_d, cb) => cb({ cancel: true })
  );
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, 'notes-preload.js'), session: ses,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  win.contentView.addChildView(view);
  tabs.set(NOTES_KEY, { view, title: 'Notes' });
  wc.loadFile(path.join(ROOT, 'notes.html'));
  activate(NOTES_KEY);
}

// Notes IPC only answers the notes view itself, and only while unlocked.
function notesCheck(e) {
  if (!unlocked) throw new Error(`${APP_NAME} is locked`);
  const t = tabs.get(NOTES_KEY);
  if (!t || e.sender !== t.view.webContents) throw new Error('Not allowed');
}
const nh = (fn) => async (e, ...a) => {
  notesCheck(e);
  try { return { ok: true, ...(await fn(...a)) }; }
  catch (err) { return { ok: false, error: err.message === 'NOFOLDER' ? 'NOFOLDER' : err.message }; }
};

// ---------- clearing (per app, per data type) ----------
const CLEAR_TYPES = new Set(['cache', 'cookies', 'localstorage', 'all']);

async function clearApp(appId, what) {
  if (!isKnownApp(appId) || !Array.isArray(what)) return;
  const w = new Set(what.filter((x) => CLEAR_TYPES.has(x)));
  if (!w.size) return;
  const ses = session.fromPartition('persist:' + appId);

  if (w.has('all')) {
    await ses.clearCache();
    await ses.clearStorageData();
    await ses.clearCodeCaches({});
  } else {
    if (w.has('cache')) {
      await ses.clearCache();
      await ses.clearCodeCaches({});
    }
    const storages = [];
    if (w.has('cookies')) storages.push('cookies');
    if (w.has('localstorage')) storages.push('localstorage', 'indexdb', 'websql', 'filesystem');
    if (storages.length) await ses.clearStorageData({ storages });
  }

  const t = tabs.get(appId);
  if (t && [...w].some((x) => x !== 'cache')) t.view.webContents.reloadIgnoringCache();
}

// ---------- launching programs ----------
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function tcp(host, port) {
  return new Promise((res) => {
    const s = net.connect({ host, port, timeout: 800 });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('timeout', () => { s.destroy(); res(false); });
    s.once('error', () => res(false));
  });
}

function portOf(u) {
  const url = new URL(u);
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

// "Is something listening at this address?" A plain connection test, so it never shows up in an app's request log.
async function probe(u) {
  try {
    const url = new URL(u);
    const hosts = url.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [url.hostname.replace(/^\[|\]$/g, '')];
    for (const h of hosts) if (await tcp(h, portOf(u))) return true;
    return false;
  } catch { return false; }
}

const killTree = (pid) => new Promise((res) => {
  if (!pid) return res();
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => res());
});

function listenerPid(port) {
  return new Promise((res) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return res(null);
      for (const line of out.split(/\r?\n/)) {
        const p = line.trim().split(/\s+/);
        if (p[0] === 'TCP' && p[3] === 'LISTENING' && p[1].endsWith(':' + port)) return res(Number(p[4]));
      }
      res(null);
    });
  });
}

function notify(id, text) { if (win) win.webContents.send('notice', { id, text }); }

// returns an error message, or null when the program started
function spawnApp(meta) {
  const launch = meta.launch;
  if (!launch || !isFile(launch)) return 'Launch file not found: ' + (launch || '(none)');
  const ext = path.extname(launch).toLowerCase();
  if (!LAUNCH_EXTS.includes(ext)) return 'Launch file must be .exe, .bat or .cmd.';
  const cwd = meta.cwd && isDir(meta.cwd) ? meta.cwd : path.dirname(launch);

  let fd = 'ignore';
  try { fd = fs.openSync(path.join(APPS_DIR, meta.id, 'launch.log'), 'w'); } catch { /* no log, fine */ }
  const base = { cwd, stdio: ['ignore', fd, fd], windowsHide: ext !== '.exe' };

  let child;
  try {
    if (ext === '.exe') {
      child = spawn(launch, splitArgs(meta.args || ''), base);
    } else {
      const inner = '"' + launch + '"' + (meta.args ? ' ' + meta.args : '');
      child = spawn('cmd.exe', ['/d', '/s', '/c', '"' + inner + '"'], { ...base, windowsVerbatimArguments: true });
    }
  } catch (e) {
    if (typeof fd === 'number') fs.closeSync(fd);
    return 'Could not start: ' + e.message;
  }
  if (typeof fd === 'number') fs.closeSync(fd);

  const rec = { id: meta.id, child, alive: true };
  procs.set(meta.id, rec);
  child.on('exit', () => {
    rec.alive = false;
    if (!meta.url && procs.get(meta.id) === rec) procs.delete(meta.id);
    pushStatus();
  });
  child.on('error', (err) => {
    rec.alive = false;
    if (procs.get(meta.id) === rec) procs.delete(meta.id);
    notify(meta.id, 'Could not start: ' + err.message);
    pushStatus();
  });
  pushStatus();
  return null;
}

async function waitAndOpen(meta) {
  const w = { cancelled: false };
  waiters.set(meta.id, w);
  pushStatus();
  let exitedAt = 0;
  while (!w.cancelled) {
    if (await probe(meta.url)) {
      if (waiters.get(meta.id) === w) waiters.delete(meta.id);
      openTab(meta.id);
      pushStatus();
      return;
    }
    const rec = procs.get(meta.id);
    if (!rec || !rec.alive) {
      // Some launchers start the real app and exit, so give the server a minute before giving up.
      exitedAt = exitedAt || Date.now();
      if (Date.now() - exitedAt > 60000) {
        notify(meta.id, 'The program exited and nothing answered at the URL.');
        break;
      }
    } else exitedAt = 0;
    await sleep(1000);
  }
  if (waiters.get(meta.id) === w) waiters.delete(meta.id);
  pushStatus();
}

async function startApp(id) {
  const meta = findApp(id);
  if (!meta) return;
  if (tabs.has(id)) return activate(id);
  if (waiters.has(id)) return;
  const up = meta.url ? await probe(meta.url) : false;
  if (up) { openTab(id); return; }
  if (!meta.launch) {
    notify(id, 'Nothing is answering at ' + meta.url + '. Start the app, or add a launch file with Edit.');
    return;
  }
  const rec = procs.get(id);
  if (!(rec && rec.alive)) {
    const err = spawnApp(meta);
    if (err) { notify(id, err); return; }
  } else if (!meta.url) {
    notify(id, 'Already running.');
    return;
  }
  if (meta.url) await waitAndOpen(meta);
}

async function stopApp(id) {
  const w = waiters.get(id);
  if (w) w.cancelled = true;
  waiters.delete(id);
  const rec = procs.get(id);
  const meta = findApp(id);
  if (rec && rec.alive) await killTree(rec.child.pid);
  // Launchers that hand off to another process: also stop whatever listens on the app's port,
  // but only for programs this shell started.
  if (rec && meta && meta.url) {
    await sleep(800);
    if (await probe(meta.url)) {
      const pid = await listenerPid(portOf(meta.url));
      if (pid && pid !== process.pid) await killTree(pid);
    }
  }
  procs.delete(id);
  pushStatus();
}

async function computeStatus(meta) {
  const up = meta.url ? await probe(meta.url) : false;
  let rec = procs.get(meta.id);
  if (rec && !rec.alive && meta.url && !up && !waiters.has(meta.id)) { procs.delete(meta.id); rec = null; }
  const alive = !!rec && rec.alive;
  const waiting = waiters.has(meta.id) && !up;
  return {
    state: waiting ? 'waiting' : (alive || up) ? 'running' : 'stopped',
    canStop: !!rec && (alive || up || waiting),
  };
}

async function getStatuses() {
  const out = {};
  await Promise.all(loadApps().map(async (m) => { out[m.id] = await computeStatus(m); }));
  return out;
}

async function pushStatus() {
  if (!win || win.isDestroyed()) return;
  const out = await getStatuses();
  const s = JSON.stringify(out);
  if (s !== lastStatus) { lastStatus = s; win.webContents.send('status', out); }
}

// ---------- window ----------
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#08090b', title: APP_NAME,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('page-title-updated', (e) => e.preventDefault());   // keep our window title
  win.loadFile(path.join(ROOT, 'index.html'));
  win.on('resize', layout);
  win.webContents.on('did-finish-load', () => { sendState(); sendAuth(); });

  // Closing the window: ask what to do with programs the shell started.
  win.on('close', (e) => {
    if (quitting) return;
    const running = [...procs.values()].filter((p) => p.alive);
    if (!running.length) return;
    e.preventDefault();
    dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Stop them and quit', 'Leave them running', 'Cancel'],
      defaultId: 2, cancelId: 2, title: 'Programs still running',
      message: running.length === 1 ? '1 program started by ' + APP_NAME + ' is still running.'
        : running.length + ' programs started by ' + APP_NAME + ' are still running.',
      detail: 'Stopping them closes the programs and any work in progress.',
    }).then(async ({ response }) => {
      if (response === 2) return;
      if (response === 0) await Promise.all(running.map((p) => stopApp(p.id)));
      quitting = true;
      win.close();
    });
  });

  ipcMain.handle('app:name', () => APP_NAME);

  // auth (always available)
  ipcMain.handle('auth:status', () => authState());
  ipcMain.handle('auth:setup', (_e, pw) => {
    if (hasPassword()) return { ok: false, error: 'A password is already set.' };
    if (typeof pw !== 'string' || pw.length < 6) return { ok: false, error: 'Use at least 6 characters.' };
    setPassword(pw);
    unlock();
    return { ok: true };
  });
  ipcMain.handle('auth:unlock', (_e, pw) => {
    const now = Date.now();
    if (now < retryAt) return { ok: false, error: `Wait ${Math.ceil((retryAt - now) / 1000)}s and try again.` };
    if (typeof pw === 'string' && checkPassword(pw)) { unlock(); return { ok: true }; }
    failures++;
    retryAt = now + Math.min(failures, 10) * 1000;
    return { ok: false, error: 'Wrong password.' };
  });
  ipcMain.handle('auth:lock', () => { if (hasPassword()) lock(); });

  // everything else requires being unlocked
  ipcMain.handle('apps:list', guarded(() => loadApps(true)));
  ipcMain.handle('status:get', guarded(async () => { const s = await getStatuses(); lastStatus = JSON.stringify(s); return s; }));
  ipcMain.handle('tab:activate', guarded((_e, id) => activate(id)));
  ipcMain.handle('tab:close', guarded((_e, id) => closeTab(id)));
  ipcMain.handle('app:start', guarded((_e, id) => { startApp(id).catch(() => {}); }));
  ipcMain.handle('app:stop', guarded((_e, id) => stopApp(id)));
  ipcMain.handle('app:save', guarded((_e, d) => saveApp(d || {})));
  ipcMain.handle('app:remove', guarded((_e, id, erase) => removeApp(id, !!erase)));
  ipcMain.handle('cache:clear', guarded((_e, id, what) => clearApp(id, what)));
  ipcMain.handle('cache:size', guarded((_e, id) =>
    isKnownApp(id) ? session.fromPartition('persist:' + id).getCacheSize() : 0));
  ipcMain.handle('pick', guarded(async (_e, kind) => {
    const opts = kind === 'launch'
      ? { title: 'Choose a program or script', properties: ['openFile'], filters: [{ name: 'Programs and scripts', extensions: ['exe', 'bat', 'cmd'] }] }
      : kind === 'icon'
        ? { title: 'Choose an icon', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'ico'] }] }
        : { title: 'Choose a folder', properties: ['openDirectory'] };
    const r = await dialog.showOpenDialog(win, opts);
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (kind !== 'icon') return p;
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return { path: p, preview: null };
    return { path: p, preview: img.resize({ width: 96, quality: 'good' }).toDataURL() };
  }));

  // notes
  ipcMain.handle('notes:openTab', guarded(() => openNotes()));
  ipcMain.handle('notes:info', nh(() => {
    const d = notesDir();
    if (d === DEFAULT_NOTES_DIR) fs.mkdirSync(d, { recursive: true });
    const exists = isDir(d);
    if (exists) notesLib.purgeTrash();
    return { dir: d, exists };
  }));
  ipcMain.handle('notes:list', nh((q) => ({ items: notesLib.list(q), cats: notesLib.categories() })));
  ipcMain.handle('notes:read', nh((r) => ({ text: notesLib.read(r) })));
  ipcMain.handle('notes:save', nh((r, t) => { notesLib.save(r, t); }));
  ipcMain.handle('notes:create', nh((t, c) => ({ ref: notesLib.create(t, c) })));
  ipcMain.handle('notes:rename', nh((r, t) => ({ ref: notesLib.rename(r, t) })));
  ipcMain.handle('notes:move', nh((r, c) => ({ ref: notesLib.move(r, c) })));
  ipcMain.handle('notes:delete', nh((r) => { notesLib.remove(r); }));
  ipcMain.handle('notes:catCreate', nh((n) => ({ name: notesLib.catCreate(n) })));
  ipcMain.handle('notes:catRename', nh((o, n) => ({ name: notesLib.catRename(o, n) })));
  ipcMain.handle('notes:catDelete', nh((n) => { notesLib.catDelete(n); }));
  ipcMain.handle('notes:chooseDir', nh(async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose notes folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { cancelled: true };
    const s = loadSettings(); s.notesDir = r.filePaths[0]; saveSettings(s);
    return { dir: r.filePaths[0], exists: true };
  }));
  ipcMain.handle('notes:openFile', nh(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open a text file', properties: ['openFile'],
      filters: [{ name: 'Text files', extensions: ['txt', 'md', 'log', 'json', 'csv'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { cancelled: true };
    lastExternal = r.filePaths[0];
    const { text, truncated } = notesLib.readExternal(lastExternal);
    return { name: path.basename(lastExternal), text, truncated };
  }));
  ipcMain.handle('notes:import', nh(() => {
    if (!lastExternal) throw new Error('Open a file first.');
    return { ref: notesLib.importText(lastExternal) };
  }));

  setInterval(() => { if (unlocked) pushStatus(); }, 2000);

  if (IDLE_LOCK_MINUTES > 0) {
    setInterval(() => {
      if (unlocked && hasPassword() && powerMonitor.getSystemIdleTime() >= IDLE_LOCK_MINUTES * 60) lock();
    }, 15000);
  }
});

app.on('window-all-closed', () => app.quit());
