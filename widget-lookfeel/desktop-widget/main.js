const { app, BrowserWindow, ipcMain, globalShortcut, screen, dialog, shell, clipboard, Menu, Tray, nativeImage, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Single instance: a second launch (e.g. the login-item AND a manual click) must NOT open a second
// widget — it just reveals the one already running. requestSingleInstanceLock() returns false in the
// second process; quit it immediately. Top-level return is legal in a CommonJS main module.
if (!app.requestSingleInstanceLock()) {
  if (process.argv.some((a) => a.startsWith('--smoke'))) { try { process.stdout.write('\n' + JSON.stringify({ ok: true, check: 'second-instance-exits', pid: process.pid }) + '\n'); } catch { /* ignore */ } }
  app.quit();
  return;
}
app.on('second-instance', () => revealWidget());

// Distinguishes "user hid the widget" (keep running in the tray) from "user really wants to quit".
// Without it, the first window close would end the app.
app.isQuitting = false;

// recorder_version = the ENGINE version (the thing that produces the wrap), not the widget shell —
// that's the version contrast that makes "are new notes better?" meaningful. Root package.json is
// two levels up from this widget folder. Best-effort current version (the wrap doesn't yet stamp its own).
const APP_VERSION = (() => {
  try {
    // Packaged: the app's own version (canonical API). Dev (`electron <path>`): app.getVersion()
    // can report Electron's version, so read the repo package.json to keep the real product version.
    return app.isPackaged ? app.getVersion() : require(path.join(__dirname, '..', '..', 'package.json')).version;
  } catch { try { return app.getVersion(); } catch { return null; } }
})();

let win;
let didFinishCount = 0;   // increments on each widget did-finish-load (used by the crash-recreate smoke)

// ---- feedback card: a passive, PERSISTENT re-entry card ----
// One at a time. The card STAYS until you vote or close it — no auto-dismiss (it must never vanish
// before you can answer). main writes exactly one feedback row per press via the engine.
let card = null;            // the card BrowserWindow
let cardCtx = null;         // { folder, wrapId, eventId, pressTs, prevEventId }
let cardResolved = false;   // Clock-1 row is written exactly once
let cardX = 0, cardBottomY = 0;   // bottom-anchored so height changes grow the card upward
const CARD_W = 360, CARD_H0 = 150;

function createWindow() {
  const W = 300, H = 184;                       // window includes a transparent margin for the soft shadow
  const area = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(area.width - W - 40),         // start bottom-right, above the taskbar
    y: Math.round(area.height - H - 56),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,                           // the widget draws its own warm shadow
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,                                // shown explicitly after load (unless launched --hidden)
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.setAlwaysOnTop(true, 'screen-saver');     // float above normal app windows
  win.loadFile(path.join(__dirname, 'widget.html')); // robust regardless of launch cwd

  // Start fully click-through; the renderer flips this on/off as the cursor enters/leaves the widget,
  // so the transparent area around the widget never blocks clicks to the apps underneath.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Rehydrate "Where was I?" from disk once the UI is ready: if the remembered project
  // already has a wrap, enable the resume button on launch instead of only after a fresh
  // wrap this session.
  win.webContents.on('did-finish-load', () => {
    didFinishCount++;
    if (!launchedHidden()) win.show();          // reveal now; a login-launch with --hidden stays in the tray
    const folder = targetFolder();
    // Show "Where was I?" on launch only if there's a wrap AND it hasn't already been resumed
    // (reentryConsumed). A consumed re-entry stays collapsed across relaunch until the next wrap.
    if (folder && hasExistingWrap(folder) && !readCfg().reentryConsumed) win.webContents.send('hydrate', { hasSave: true, theme: readCfg().colorTheme || 'honey' });
    win.webContents.send('set-theme', readCfg().colorTheme || 'honey');
  });

  // Right-click on the body flows through the renderer ('contextmenu' → 'show-menu'). The grip is the
  // one -webkit-app-region:drag surface (a window caption), so a right-click THERE is a non-client
  // click the renderer never sees — this catches it and shows the same menu. Covers both surfaces.
  win.on('system-context-menu', (e) => { e.preventDefault(); popupWidgetMenu(); });

  // Keep the feedback card pinned to the widget as it moves (incl. native-grip drag) so it never
  // drifts away, and so a card that opened clipped at a screen edge follows the widget back into
  // view. No-op when no card is open. 'move' fires continuously during the OS drag.
  win.on('move', () => { placeCard(); signalCardMoving(); });

  // Closing the widget (✕ / Esc / OS) HIDES it — the app keeps running in the tray. Only an explicit
  // quit (quitApp) lets the window actually close. Without this, the first close would end the app.
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); hideWidget(); } });
}

// ---- headless lifecycle smoke (no clicking; driven by lifecycle-smoke.js). Each sub-check prints a
// single last-line JSON object — same discipline as the engine — so the driver can parse it. ----
function smokeMode() { const a = process.argv.find((x) => x.startsWith('--smoke')); return a ? (a.split('=')[1] || 'boot') : null; }
function smokeLog(o) { try { process.stdout.write('\n' + JSON.stringify(o) + '\n'); } catch { /* ignore */ } }
function runSmoke(mode) {
  if (mode === 'hold') { smokeLog({ ok: true, check: 'hold', pid: process.pid }); return; }   // stay alive; the driver kills us
  if (mode === 'trayprobe') {
    // Verify the tray icon actually decodes to a non-empty image (this Electron's PNG codec is broken,
    // so trayImage() uses raw-pixel createFromBitmap). Writes to a file so a Start-Process launch can read it.
    let result;
    try { const im = trayImage(); result = { ok: !im.isEmpty(), check: 'trayprobe', empty: im.isEmpty(), size: im.getSize() }; }
    catch (e) { result = { ok: false, check: 'trayprobe', err: String((e && e.message) || e) }; }
    try { fs.writeFileSync(path.join(app.getPath('temp'), 'wiu-trayprobe.json'), JSON.stringify(result)); } catch { /* ignore */ }
    smokeLog(result);
    quitApp();
    return;
  }
  if (mode === 'menudump') {
    // Headless check of the right-click / tray menu: dump each item's label + checkbox state AND prove
    // Electron accepts the template — so a driver can assert the toggles (e.g. "Open wrap-up in editor")
    // are present and well-formed without a human right-clicking. Writes to a file like trayprobe does.
    let result;
    try {
      const items = buildMenuTemplate().map((i) => ({ label: i.label, type: i.type || 'normal', checked: i.checked }));
      Menu.buildFromTemplate(buildMenuTemplate());
      result = { ok: true, check: 'menudump', items };
    } catch (e) { result = { ok: false, check: 'menudump', err: String((e && e.message) || e) }; }
    try { fs.writeFileSync(path.join(app.getPath('temp'), 'wiu-menudump.json'), JSON.stringify(result)); } catch { /* ignore */ }
    smokeLog(result);
    quitApp();
    return;
  }
  if (mode === 'crash') {
    const start = Date.now();
    const iv = setInterval(() => {
      if (didFinishCount >= 2) { clearInterval(iv); smokeLog({ ok: true, check: 'window-recreated', crashCount }); quitApp(); }
      else if (Date.now() - start > 9000) { clearInterval(iv); smokeLog({ ok: false, check: 'window-recreated', crashCount, didFinishCount }); quitApp(); }
    }, 150);
    setTimeout(() => { try { if (win && win.webContents) win.webContents.forcefullyCrashRenderer(); } catch { /* ignore */ } }, 1000);
    return;
  }
  let trayImg = null;
  try { const im = trayImage(); trayImg = { empty: im.isEmpty(), size: im.getSize() }; } catch (e) { trayImg = { err: String((e && e.message) || e) }; }
  smokeLog({ ok: true, check: 'boot', tray: !!tray, trayImg, pid: process.pid });   // 'boot': we got here ⇒ nothing threw
  quitApp();
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  installCrashRecovery();
  firstRunInit();
  globalShortcut.register('CommandOrControl+Shift+Q', () => quitApp());
  const sm = smokeMode();
  if (sm) runSmoke(sm);
});

// Reopening from the macOS dock (or a re-`open`) shows the widget instead of doing nothing.
app.on('activate', () => showWidget());

ipcMain.on('set-interactive', (_e, interactive) => {
  if (win) win.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on('quit', () => hideWidget());   // Esc / ✕ from the renderer hides; Ctrl+Shift+Q quits

// Window dragging is native now: the grip (left handle) is the only -webkit-app-region:drag surface,
// so the OS moves the window itself — buttery, with none of the trailing that JS/IPC-driven dragging
// had. The rest of the body stays no-drag so 'contextmenu' fires there for right-click. No manual drag
// IPC is needed; right-clicks that land on the grip caption are handled by win.on('system-context-menu').

// Right-click the widget → re-point the target project (same picker as first-run) or quit.
async function changeFolder() {
  const folder = await pickFolder();                 // reuse the onboarding picker
  if (!folder) return;
  setTarget(folder);
  // New project: drop stale Clock-2 context so it can't leak across repos, and close any card.
  // Also clear the consumed flag so a wrapped new project re-offers "Where was I?".
  writeCfg({ lastResumedWrapId: null, lastFeedbackEventId: null, reentryConsumed: false });
  closeCard();
  // Light up / grey out "Where was I?" for the new project (hydrate now toggles both ways).
  if (win) win.webContents.send('hydrate', { hasSave: hasExistingWrap(folder) });
}
// ---- window lifecycle: HIDE vs QUIT ----
// The widget is tray-resident: closing it / Esc HIDES it (the app keeps running); only quitApp()
// truly exits. revealWidget is also the second-instance response (a 2nd launch surfaces the running
// widget instead of opening another).
function showWidget() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  refreshTray();
}
function hideWidget() {
  if (win && !win.isDestroyed()) win.hide();
  closeCard();                                   // don't leave a feedback card floating over the desktop
  refreshTray();
}
function toggleWidget() {
  if (win && !win.isDestroyed() && win.isVisible()) hideWidget(); else showWidget();
}
function revealWidget() {
  showWidget();
  try {
    if (win && !win.isDestroyed()) {
      win.focus();
      if (process.platform === 'win32') { win.flashFrame(true); setTimeout(() => { try { if (win && !win.isDestroyed()) win.flashFrame(false); } catch { /* ignore */ } }, 1200); }
    }
  } catch { /* ignore */ }
}
function quitApp() { app.isQuitting = true; app.quit(); }

// True when started by the login-item (registered with a `--hidden` arg) → come up in the tray
// WITHOUT popping the widget in front of whatever the user opens at boot.
function launchedHidden() {
  if (process.argv.includes('--hidden')) return true;
  if (process.argv.some((a) => a.startsWith('--smoke'))) return true;   // smoke runs never flash a window
  try { return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden === true; } catch { return false; }
}

// ---- the shared menu (ONE source for both the tray context menu and the right-click menu) ----
function buildMenuTemplate() {
  const cfg = readCfg();
  const folder = targetFolder();
  const visible = !!(win && !win.isDestroyed() && win.isVisible());
  const hasKey = !!(cfg.apiKeyEnc || cfg.apiKeyPlain);
  const ai = aiStatus();
  const aiLabel = ai === 'cli' ? 'AI: Claude CLI' : ai === 'key' ? 'AI: API key' : ai === 'kiro' ? 'AI: Kiro' : 'AI: off (local only)';
  const items = [
    { label: folder ? `Wrapping: ${path.basename(folder)}` : 'No project — pick one…', enabled: !folder, click: folder ? undefined : () => changeFolder() },
    { type: 'separator' },
    { label: visible ? 'Hide widget' : 'Show widget', click: () => toggleWidget() },
    { label: 'Change project folder…', click: () => changeFolder() },
    { type: 'separator' },
    { label: 'Set Claude API key…', click: () => openKeyPrompt() },
  ];
  if (hasKey) items.push({ label: 'Clear API key', click: () => clearKey() });
  items.push(
    { label: aiLabel, enabled: false },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: cfg.openAtLogin === true, click: (it) => setOpenAtLogin(it.checked) },
    { label: 'Open wrap-up in editor', type: 'checkbox', checked: cfg.openWrapInEditor !== false, click: (it) => setOpenWrapInEditor(it.checked) },
    { label: 'Share anonymous usage data', type: 'checkbox', checked: cfg.telemetryConsent === true, click: (it) => setTelemetryConsent(it.checked) },
    { label: 'Color Theme', submenu: [
      { label: 'Honey (default)', type: 'radio', checked: (cfg.colorTheme || 'honey') === 'honey', click: () => setColorTheme('honey') },
      { label: 'Purple',         type: 'radio', checked: cfg.colorTheme === 'purple',              click: () => setColorTheme('purple') },
      { label: 'Space Blue',     type: 'radio', checked: cfg.colorTheme === 'space-blue',          click: () => setColorTheme('space-blue') },
    ]},
    // Which AI session to read. 'Auto' uses the most-recent session across tools — convenient, but it
    // can grab the wrong one when two agents share a folder. Pin Claude Code or Kiro to be unambiguous.
    { label: 'Session source', submenu: [
      { label: 'Auto (newest)', type: 'radio', checked: (cfg.wrapSource || 'auto') === 'auto',  click: () => setWrapSource('auto') },
      { label: 'Claude Code',   type: 'radio', checked: cfg.wrapSource === 'claude-code',        click: () => setWrapSource('claude-code') },
      { label: 'Kiro',          type: 'radio', checked: cfg.wrapSource === 'kiro',               click: () => setWrapSource('kiro') },
    ]},
    { type: 'separator' },
    { label: 'Quit Wrap It Up', click: () => quitApp() }
  );
  return items;
}
function popupWidgetMenu() {
  if (!win) return;
  Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: win });
}

// ---- system tray: the management home (the widget is skipTaskbar + frameless, so without this its
// only controls are right-click + a global shortcut). IMPORTANT: this Electron build's main-process PNG
// DECODER is broken — createFromDataURL/createFromBuffer/createFromPath all return an EMPTY image (HTML/
// SVG rendering in a BrowserWindow is a different path and works fine, which is why the widget itself
// looks right). So the tray is fed RAW PIXELS via createFromBitmap (no decode): the honey "present" art
// as 32×32 straight BGRA (Windows/Linux native order). Regenerate from build/icon.png if the art changes. ----
let tray = null;
const TRAY_W = 32, TRAY_H = 32;
function trayImage() {
  // createFromBitmap stores pixel data directly — the ONLY image path that works in this Electron build
  // (its main-process PNG codec is broken). The art ships as raw 32×32 BGRA pixels (assets/tray.bgra),
  // which fs reads straight from disk — or transparently from inside app.asar when packaged.
  try {
    return nativeImage.createFromBitmap(fs.readFileSync(path.join(__dirname, 'assets', 'tray.bgra')), { width: TRAY_W, height: TRAY_H });
  } catch { return nativeImage.createEmpty(); }
}
function tooltipText() {
  const folder = targetFolder();
  return 'Wrap It Up — ' + (folder ? path.basename(folder) : 'no project');
}
function refreshTray() {
  if (!tray) return;
  try { tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate())); tray.setToolTip(tooltipText()); } catch { /* ignore */ }
}
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(trayImage());
    tray.setToolTip(tooltipText());
    tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
    // Win/Linux: left-click toggles the widget. macOS convention is left-click → menu (already wired
    // by setContextMenu), so don't bind a toggle there.
    if (process.platform !== 'darwin') tray.on('click', () => toggleWidget());
  } catch { /* a tray is best-effort; the app still works without it */ }
}

// ---- auto-start on login (decision #5) ----
// Only registers the OS login item when PACKAGED — running from source would otherwise register a
// dev electron.exe. The preference is persisted either way so the tray checkbox is consistent.
function setOpenAtLogin(on) {
  try {
    if (app.isPackaged) {
      const opts = { openAtLogin: !!on };
      if (process.platform === 'win32') { opts.path = process.execPath; opts.args = ['--hidden']; }
      app.setLoginItemSettings(opts);
    }
  } catch { /* ignore */ }
  writeCfg({ openAtLogin: !!on });
  refreshTray();
}
// ---- auto-open the wrap-up note in the default .md editor on "pick up" ----
// ON by default (preserves the original behavior). A user who finds the editor popping to the front
// intrusive can switch it off and just take the paste-ready prompt + the feedback card; the note is
// still written to disk either way. Persisted so the checkbox sticks across relaunch.
function setOpenWrapInEditor(on) { writeCfg({ openWrapInEditor: !!on }); refreshTray(); }
// Persisted choice of which AI session the engine reads (auto | claude-code | kiro). Passed to
// `cli.js wrap --source` on the next press. Default 'auto' preserves newest-session-wins.
function setWrapSource(src) { writeCfg({ wrapSource: src }); refreshTray(); }
function setColorTheme(theme) {
  writeCfg({ colorTheme: theme });
  if (win && !win.isDestroyed())   win.webContents.send('set-theme', theme);
  if (card && !card.isDestroyed()) card.webContents.send('set-theme', theme);
  if (keyWin && !keyWin.isDestroyed()) keyWin.webContents.send('set-theme', theme);
  refreshTray();
}
// Once per install: default auto-start ON (packaged only), plus a one-time, NON-BLOCKING nudge to add
// an API key when neither the CLI nor a key is present. Skipped entirely under --smoke (hermetic runs).
function firstRunInit() {
  if (process.argv.some((a) => a.startsWith('--smoke'))) return;
  const cfg = readCfg();
  if (app.isPackaged && cfg.openAtLogin === undefined) setOpenAtLogin(true);
  if (!cfg.aiNudgeShown && aiStatus() === 'off') {
    writeCfg({ aiNudgeShown: true });
    if (process.platform === 'win32' && tray) {
      try { tray.displayBalloon({ title: 'Wrap It Up', content: 'Tip: add a Claude API key (right-click the tray) for AI wraps — it also works local-only.' }); } catch { /* ignore */ }
    }
  }
}

// ---- crash resilience (in-app only; no external watchdog — decision #7) ----
let crashCount = 0, crashWindowStart = Date.now();
const CRASH_MAX = 3, CRASH_WINDOW_MS = 60_000;
function recreateAfterCrash() {
  if (app.isQuitting) return;
  const now = Date.now();
  if (now - crashWindowStart > CRASH_WINDOW_MS) { crashWindowStart = now; crashCount = 0; }
  if (++crashCount > CRASH_MAX) return;                 // stop after a tight crash loop; the tray stays alive
  const delay = Math.min(4000, 250 * 2 ** (crashCount - 1));
  setTimeout(() => { try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ } win = null; createWindow(); }, delay);
}
function installCrashRecovery() {
  app.on('render-process-gone', (_e, wc, details) => {
    if (app.isQuitting || !details || details.reason === 'clean-exit') return;
    if (card && wc === card.webContents) { closeCard(); return; }   // a card-renderer crash is ephemeral
    if (win && wc === win.webContents) recreateAfterCrash();
  });
  // Engine spawns are plain Node children (NOT Electron children), so they're covered by runEngine's
  // own guards, not this event. GPU/utility deaths usually self-recover; stay conservative.
  app.on('child-process-gone', () => { /* logged by Electron; no action */ });
}

// ---- BYO Claude API key (decision #8): a machine with NO `claude` CLI still gets AI wraps from a key.
// Stored encrypted-at-rest via safeStorage (DPAPI/Keychain); plaintext only as a last resort. The key
// lives in the widget config and is injected into the engine spawn as ANTHROPIC_API_KEY — it is NEVER
// part of a feedback event, so the telemetry allowlist structurally can't carry it off the machine. ----
function saveKey(plain) {
  const k = (plain || '').trim();
  if (!k) return;
  try {
    if (safeStorage.isEncryptionAvailable()) writeCfg({ apiKeyEnc: safeStorage.encryptString(k).toString('base64'), apiKeyPlain: null });
    else writeCfg({ apiKeyEnc: null, apiKeyPlain: k });
  } catch { writeCfg({ apiKeyEnc: null, apiKeyPlain: k }); }
  refreshTray();
}
function loadKey() {
  const c = readCfg();
  try {
    if (c.apiKeyEnc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(c.apiKeyEnc, 'base64')).trim() || null;
  } catch { return null; }            // fail closed → engine falls back to CLI/local
  return (c.apiKeyPlain || '').trim() || null;
}
function clearKey() { writeCfg({ apiKeyEnc: null, apiKeyPlain: null }); refreshTray(); }

// Cheap PATH probe mirroring the engine's hasClaudeCli() (cli.ts) — drives the tray AI-status line.
function hasClaudeCliInPath() {
  if (process.env.WRAPITUP_CLAUDE_BIN) return true;
  const exts = process.platform === 'win32' ? ['', '.cmd', '.ps1', '.exe'] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) { try { if (fs.existsSync(path.join(d, 'claude' + e))) return true; } catch { /* ignore */ } }
  }
  return false;
}
// kiro-cli can run the enrichment headlessly on the user's Kiro login (no API key) — so a Kiro user
// is NOT "AI: off". Detect it on PATH or at its known install location (its installer doesn't add PATH).
function hasKiroCliInPath() {
  if (process.env.WRAPITUP_KIRO_BIN) return true;
  const exe = process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli';
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try { if (fs.existsSync(path.join(d, exe))) return true; } catch { /* ignore */ }
  }
  try {
    if (process.platform === 'win32') {
      const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
      if (la && fs.existsSync(path.join(la, 'Kiro-Cli', 'kiro-cli.exe'))) return true;
    } else {
      const home = process.env.HOME || '';
      if (home && (fs.existsSync(path.join(home, '.local', 'bin', 'kiro-cli')) || fs.existsSync('/usr/local/bin/kiro-cli'))) return true;
    }
  } catch { /* ignore */ }
  return false;
}
// Provider priority MIRRORS the engine's enrichment chain: Claude CLI > API key > Kiro CLI > off.
function aiStatus() { return hasClaudeCliInPath() ? 'cli' : (loadKey() ? 'key' : (hasKiroCliInPath() ? 'kiro' : 'off')); }

// The env for every engine spawn. Injects the stored key as ANTHROPIC_API_KEY ONLY when one isn't
// already in the environment — so the `claude` CLI stays the preferred provider (cli.ts tries CLI
// first, the key second).
function spawnEnv() {
  const e = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const k = loadKey();
  if (k && !e.ANTHROPIC_API_KEY) e.ANTHROPIC_API_KEY = k;
  return e;
}

// Electron has no native text prompt, so reuse the frameless-window pattern (like the card) for a tiny
// key-entry surface. Unlike the card it MUST be focusable — you type into it.
let keyWin = null;
function openKeyPrompt() {
  if (keyWin && !keyWin.isDestroyed()) { try { keyWin.focus(); } catch { /* ignore */ } return; }
  const W = 400, H = 214;
  const area = screen.getPrimaryDisplay().workAreaSize;
  keyWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round(area.width / 2 - W / 2), y: Math.round(area.height / 2 - H / 2),
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
    focusable: true, fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  keyWin.setAlwaysOnTop(true, 'screen-saver');
  keyWin.on('closed', () => { keyWin = null; });
  keyWin.webContents.on('did-finish-load', () => {
    if (keyWin) { keyWin.webContents.send('key-data', { present: !!loadKey(), status: aiStatus() }); keyWin.webContents.send('set-theme', readCfg().colorTheme || 'honey'); keyWin.show(); keyWin.focus(); }
  });
  keyWin.loadFile(path.join(__dirname, 'prompt.html'));
}
ipcMain.on('apikey-save', (_e, v) => { saveKey(v); if (keyWin && !keyWin.isDestroyed()) keyWin.close(); });
ipcMain.on('apikey-clear', () => { clearKey(); if (keyWin && !keyWin.isDestroyed()) keyWin.close(); });
ipcMain.on('apikey-cancel', () => { if (keyWin && !keyWin.isDestroyed()) keyWin.close(); });
// Opt-in anonymous telemetry (OFF by default). On first enable, mint a random per-install id (NOT
// identifying — it only groups one install's rows). Only metadata feedback rows are ever sent
// (perceived rating, reason chip, re-entry outcome, versions, session flags) — NEVER wrap text/code.
function setTelemetryConsent(on) {
  const patch = { telemetryConsent: !!on };
  if (on && !readCfg().telemetryClientId) patch.telemetryClientId = require('crypto').randomUUID();
  writeCfg(patch);
}
// The block attached to a feedback event ONLY when consent is on AND a collector is configured.
// Its presence in the piped event is what tells the engine the developer consented.
function telemetryBlock() {
  const c = readCfg();
  if (!c.telemetryConsent || !c.telemetryUrl || !c.telemetryAnonKey) return null;
  return { url: c.telemetryUrl, anonKey: c.telemetryAnonKey, clientId: c.telemetryClientId || '' };
}
ipcMain.on('show-menu', () => popupWidgetMenu());            // from the no-drag buttons (renderer)

// ---- engine wiring: the buttons spawn the headless broker CLI on the target project ----
// (spawn-per-trigger). Runs the CLI via Electron-as-Node, so no separate
// node install is needed. The target project is remembered between runs; first run prompts.
// Resolve the compiled engine (out/cli.js), spawned per click via Electron-as-Node. Dev:
// <repo>/out/cli.js, kept fresh by the background `tsc -w` during `npm run dev`. Packaged:
// out/ is asarUnpack'd, so it lives beside app.asar as a REAL file — a path INSIDE app.asar
// can't be spawned as a child process. No on-the-fly compile anymore (the engine is frozen).
function enginePath() {
  if (!app.isPackaged) return path.join(__dirname, '..', '..', 'out', 'cli.js');
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'cli.js');
}
const ENGINE = enginePath();
const CFG = path.join(app.getPath('userData'), 'wrapitup-widget.json');

function targetFolder() {
  try { const f = JSON.parse(fs.readFileSync(CFG, 'utf8')).folder; return f && fs.existsSync(f) ? f : null; } catch { return null; }
}
// Does the remembered project already have a saved wrap on disk? Lets a freshly launched
// widget light up "Where was I?" for an existing wrap instead of waiting for a new one
// (the has-save state used to be in-memory only, so it was lost on every relaunch).
function hasExistingWrap(folder) {
  try { return fs.readdirSync(path.join(folder, '.wrap-it-up', 'wrapups')).some((f) => f.endsWith('.md')); }
  catch { return false; }
}
function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')) || {}; } catch { return {}; }
}
function writeCfg(patch) {
  try { fs.mkdirSync(path.dirname(CFG), { recursive: true }); fs.writeFileSync(CFG, JSON.stringify({ ...readCfg(), ...patch })); } catch { /* ignore */ }
}
function setTarget(folder) { writeCfg({ folder }); }

// One-time consent before we read the Claude Code session file
// (read first-party local files the user owns, with explicit consent).
const hasConsent = () => readCfg().sessionConsent === true;
async function askConsent() {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Allow', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Wrap It Up — read this session?',
    message: 'Read your Claude Code session for a richer wrap?',
    detail:
      'To tell you what actually worked and broke, Wrap It Up reads this project’s ' +
      'Claude Code session file (the commands it ran and the files it changed). It is a ' +
      'local file on your machine — nothing is scraped from a running app. The only thing ' +
      'that can leave your machine is the optional AI summary, with secrets best-effort ' +
      'redacted first. If you decline, it falls back to a git-only wrap.',
  });
  return r.response === 0;
}
async function pickFolder() {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Wrap It Up — pick the project to wrap' });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
}
async function runEngine(cmd, folder, source, extraArgs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(ENGINE)) return resolve({ ok: false, reason: 'engine missing' });
    let out = '';
    const args = [ENGINE, cmd, '--cwd', folder];
    if (source) args.push('--source', source);
    if (extraArgs) args.push(...extraArgs);
    const p = spawn(process.execPath, args,
      { cwd: folder, env: spawnEnv() });
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').filter(Boolean).pop())); } catch { resolve({ ok: false }); } });
    p.on('error', () => resolve({ ok: false, reason: 'spawn failed' }));
  });
}

// Fire-and-forget feedback write: pipe one JSON event to `cli.js feedback` on stdin (no
// arg-quoting). The engine owns the schema + ledger files (core/feedback.ts); main just sends.
function runFeedback(folder, event) {
  const t = telemetryBlock();                       // null unless consented + collector configured
  const payload = t ? { ...event, _telemetry: t } : event;
  let p;
  try {
    p = spawn(process.execPath, [ENGINE, 'feedback', '--cwd', folder],
      { cwd: folder, env: spawnEnv() });
  } catch { return; }
  p.on('error', () => { /* ignore */ });
  p.stdin.on('error', () => { /* ignore EPIPE */ });
  p.stdin.write(JSON.stringify(payload));
  p.stdin.end();
}

ipcMain.on('wrap', async () => {
  let folder = targetFolder();
  if (!folder) {
    folder = await pickFolder();
    if (!folder) return win.webContents.send('wrap-result', { ok: false, reason: 'no folder' });
    setTarget(folder);
  }
  // Read the session for a rich wrap once consented; otherwise fall back to git-only.
  // Source = the user's menu pick (default 'auto' = newest across Claude Code + Kiro). Pinning
  // Claude Code / Kiro avoids 'auto' grabbing the wrong session when two agents share a folder.
  let source = readCfg().wrapSource || 'auto';
  if (!hasConsent()) {
    if (await askConsent()) writeCfg({ sessionConsent: true });
    else source = 'git';
  }
  const res = await runEngine('wrap', folder, source);
  if (res && res.ok) writeCfg({ reentryConsumed: false });   // a fresh wrap re-arms "Where was I?"
  win.webContents.send('wrap-result', res);
});

ipcMain.on('resume', async () => {
  const folder = targetFolder();
  if (!folder) return win.webContents.send('resume-result', { ok: false, reason: 'no folder' });
  const cfg = readCfg();
  // --prev surfaces the PRIOR note for the Clock-2 retrospective (the last note we resumed).
  const prevArgs = cfg.lastResumedWrapId ? ['--prev', cfg.lastResumedWrapId] : undefined;
  const res = await runEngine('resume', folder, undefined, prevArgs);
  let copied = false;
  if (res && res.ok) {
    if (res.nextPrompt) { clipboard.writeText(res.nextPrompt); copied = true; } // paste-ready into Claude Code
    if (res.file && readCfg().openWrapInEditor !== false) shell.openPath(res.file); // open the wrap to read (unless the user turned this off)
    // Open the passive feedback card — INDEPENDENT of the copy/open above (it never gates re-entry).
    const eventId = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const showReentry = !!(res.prev && cfg.lastFeedbackEventId); // a genuinely earlier note + a row to patch
    openCard(
      { nextMove: res.nextMove, copied, reentry: showReentry ? { title: res.prev.title } : null },
      { folder, wrapId: res.wrapId, eventId, pressTs: new Date().toISOString(),
        prevEventId: showReentry ? cfg.lastFeedbackEventId : null, modelUsed: res.modelUsed || null }
    );
    // Remember this press as the next re-entry's Clock-2 target. Mark the re-entry consumed so the
    // widget collapses to 1 button and STAYS collapsed across relaunch until the next wrap re-arms it.
    writeCfg({ lastResumedWrapId: res.wrapId, lastFeedbackEventId: eventId, reentryConsumed: true });
  }
  win.webContents.send('resume-result', { ...res, copied });
});

// ---- the feedback card window + its IPC ----
function closeCard() {
  if (card) { try { card.close(); } catch { /* ignore */ } card = null; }
}

// Write exactly one Clock-1 feedback row for this card (guarded so resolve + backstop can't double-write).
function writePerceived(r) {
  if (cardResolved || !cardCtx) return;
  cardResolved = true;
  runFeedback(cardCtx.folder, {
    kind: 'perceived',
    event_id: cardCtx.eventId,
    wrap_id: cardCtx.wrapId,
    wrs_score: null,
    event_ts: cardCtx.pressTs,
    perceived_useful: r.perceived_useful,
    perceived_delay_sec: typeof r.perceived_delay_sec === 'number' ? r.perceived_delay_sec : null,
    respond_vs_dismiss: r.respond_vs_dismiss,
    reason_chip: r.reason_chip || null,
    recorder_version: APP_VERSION,
    model_version: cardCtx.modelUsed || null,   // the model that ACTUALLY wrote this wrap (read back via resume); null if unknown — never a hardcoded guess
    session_context: {},                     // dogfood: little known at capture; log what we can later
  });
}

// Position the card relative to the widget — right-aligned to the widget window, bottom edge just
// above the widget glyph — recomputed from the widget's CURRENT bounds. Called on open, on resize,
// and on every widget move, so the card FOLLOWS the widget when it's dragged. That also means a card
// that spawned partly off-screen at an edge can be un-clipped just by dragging the widget back into
// view. Bottom-anchored (height grows upward). Pass a height to set it; omit to keep the current one.
function placeCard(h) {
  if (!card || !win) return;
  let height = (h | 0);
  if (!height) { try { height = card.getBounds().height; } catch { height = CARD_H0; } }
  height = Math.max(90, Math.min(360, height || CARD_H0));
  const wb = win.getBounds();
  cardX = Math.round(wb.x + wb.width - CARD_W - 6);
  cardBottomY = Math.round(wb.y + wb.height / 2 - 64);
  try { card.setBounds({ x: cardX, y: cardBottomY - height, width: CARD_W, height }); } catch { /* ignore */ }
}

// Tell the card it's mid-move so it can shed its blur (same trick as the widget), then flip it back
// shortly after the last move event — 'move' fires continuously during the drag, so a trailing timer
// is how we detect "drag stopped".
let cardMoveTimer = null;
function signalCardMoving() {
  if (!card) return;
  try { card.webContents.send('card-moving', true); } catch { /* ignore */ }
  clearTimeout(cardMoveTimer);
  cardMoveTimer = setTimeout(() => { try { if (card) card.webContents.send('card-moving', false); } catch { /* ignore */ } }, 180);
}

function openCard(payload, ctx) {
  closeCard();
  cardCtx = ctx; cardResolved = false;
  const wb = win.getBounds();
  cardX = Math.round(wb.x + wb.width - CARD_W - 6); // right-aligned with the widget window
  cardBottomY = Math.round(wb.y + wb.height / 2 - 64); // bottom edge sits just above the widget glyph
  card = new BrowserWindow({
    width: CARD_W, height: CARD_H0, x: cardX, y: cardBottomY - CARD_H0,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
    focusable: false,                        // NEVER steal focus from the editor (anti-toast)
    fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  card.setAlwaysOnTop(true, 'screen-saver');
  card.on('closed', () => { card = null; });
  card.webContents.on('did-finish-load', () => {
    if (card) { card.webContents.send('card-data', payload); card.webContents.send('set-theme', readCfg().colorTheme || 'honey'); card.showInactive(); } // show WITHOUT activating
  });
  card.loadFile(path.join(__dirname, 'card.html'));
}

// Bottom-anchored resize so revealing chips / the Clock-2 line grows the card upward, not down.
ipcMain.on('card-size', (_e, { height }) => placeCard(height));

// Clock 1: the card decided the final rating + dismiss type. Write the row; the card shows its
// own "thanks" then asks us to close.
ipcMain.on('feedback-resolve', (_e, r) => writePerceived(r));
ipcMain.on('card-close', () => closeCard());

// Clock 2: lazy retrospective on the PRIOR note — patch that earlier row (separate column).
ipcMain.on('feedback-reentry', (_e, r) => {
  if (!cardCtx || !cardCtx.prevEventId || !r || !r.reentry_outcome) return;
  runFeedback(cardCtx.folder, {
    kind: 'reentry',
    target_event_id: cardCtx.prevEventId,
    reentry_outcome: r.reentry_outcome,
    reentry_outcome_ts: new Date().toISOString(),
    reentry_delay_sec: typeof r.reentry_delay_sec === 'number' ? r.reentry_delay_sec : null,
  });
});

// ---- chip-triggered "regenerate with a nudge" (Epic #1) ----
// Cost guard for testers' BYO-key: one regen per wrap (per widget session) + a soft daily cap, so a
// runaway can't burn a tester's tokens.
const regeneratedWraps = new Set();
const REGEN_DAILY_CAP = 20;
function regenAllowed(wrapId) {
  if (!wrapId || regeneratedWraps.has(wrapId)) return false;     // already fixed this one
  const cfg = readCfg();
  const today = new Date().toISOString().slice(0, 10);
  const count = cfg.regenDate === today ? (cfg.regenCount || 0) : 0;
  return count < REGEN_DAILY_CAP;
}
function noteRegen(wrapId) {
  regeneratedWraps.add(wrapId);
  const cfg = readCfg();
  const today = new Date().toISOString().slice(0, 10);
  const count = cfg.regenDate === today ? (cfg.regenCount || 0) : 0;
  writeCfg({ regenDate: today, regenCount: count + 1 });
}
// The card sends this when a "fix-it" reason chip is tapped. Re-do the wrap steered by the chip (the
// engine overwrites the .md in place), re-copy the improved next-prompt, and hand the result back to
// the card for a silent swap.
ipcMain.on('regenerate-request', async (_e, r) => {
  if (!card || !cardCtx || !r || !r.reason) return;
  const wrapId = cardCtx.wrapId;
  if (!regenAllowed(wrapId)) {
    try { card.webContents.send('regenerate-result', { ok: false, reason: 'skipped (already regenerated / daily cap)' }); } catch { /* ignore */ }
    return;
  }
  noteRegen(wrapId);
  const res = await runEngine('regenerate', cardCtx.folder, null, ['--wrap-id', wrapId, '--reason', r.reason]);
  if (res && res.ok && res.nextPrompt) clipboard.writeText(res.nextPrompt); // re-copy the improved prompt
  try { card.webContents.send('regenerate-result', res || { ok: false }); } catch { /* ignore */ }
});

// Tray-resident: closing the widget window does NOT quit. Quitting is explicit (quitApp / tray / shortcut).
app.on('window-all-closed', () => { /* no-op: the tray keeps the app alive */ });
app.on('before-quit', () => { app.isQuitting = true; if (tray) { try { tray.destroy(); } catch { /* ignore */ } tray = null; } });
app.on('will-quit', () => globalShortcut.unregisterAll());
