const { app, BrowserWindow, ipcMain, globalShortcut, screen, dialog, shell, clipboard, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// recorder_version = the ENGINE version (the thing that produces the wrap), not the widget shell —
// that's the version contrast that makes "are new notes better?" meaningful. Root package.json is
// two levels up from this widget folder. Best-effort current version (the wrap doesn't yet stamp its own).
const APP_VERSION = (() => { try { return require(path.join(__dirname, '..', '..', 'package.json')).version; } catch { return null; } })();

let win;

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
    const folder = targetFolder();
    // Show "Where was I?" on launch only if there's a wrap AND it hasn't already been resumed
    // (reentryConsumed). A consumed re-entry stays collapsed across relaunch until the next wrap.
    if (folder && hasExistingWrap(folder) && !readCfg().reentryConsumed) win.webContents.send('hydrate', { hasSave: true });
  });

  // Right-click on the body flows through the renderer ('contextmenu' → 'show-menu'). The grip is the
  // one -webkit-app-region:drag surface (a window caption), so a right-click THERE is a non-client
  // click the renderer never sees — this catches it and shows the same menu. Covers both surfaces.
  win.on('system-context-menu', (e) => { e.preventDefault(); popupWidgetMenu(); });

  // Keep the feedback card pinned to the widget as it moves (incl. native-grip drag) so it never
  // drifts away, and so a card that opened clipped at a screen edge follows the widget back into
  // view. No-op when no card is open. 'move' fires continuously during the OS drag.
  win.on('move', () => { placeCard(); signalCardMoving(); });
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
});

ipcMain.on('set-interactive', (_e, interactive) => {
  if (win) win.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on('quit', () => app.quit());

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
function popupWidgetMenu() {
  if (!win) return;
  const cfg = readCfg();
  Menu.buildFromTemplate([
    { label: 'Change project folder…', click: () => changeFolder() },
    { type: 'separator' },
    {
      label: 'Share anonymous usage data',
      type: 'checkbox',
      checked: cfg.telemetryConsent === true,
      click: (item) => setTelemetryConsent(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit Wrap It Up', click: () => app.quit() },
  ]).popup({ window: win });   // no x/y → pops at the cursor (the system-context-menu point is in
                               // SCREEN coords, but popup x/y are window-relative; cursor is correct)
}
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
const REPO = path.join(__dirname, '..', '..');                  // <repo>
const ENGINE = path.join(REPO, 'out', 'cli.js');                // <repo>/out/cli.js (compiled per build)
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
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
// Auto-build before the engine runs: the engine is plain compiled JS spawned per click, so an
// edit to the TS source won't take effect until it's recompiled. Rebuild on demand — but ONLY
// when the source is actually newer than out/cli.js, so a normal click (nothing changed) pays
// only a few stat() calls. A full `tsc -p` re-emits every out/*.js, so out/cli.js's mtime is a
// reliable "last build" stamp to compare against.
function newestTsMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(path.join(d, e.name)); }
      else if (e.name.endsWith('.ts')) {
        try { const m = fs.statSync(path.join(d, e.name)).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
      }
    }
  }
  return newest;
}
function engineIsStale() {
  let outM;
  try { outM = fs.statSync(ENGINE).mtimeMs; } catch { return true; }   // not built yet → must build
  return newestTsMtime(path.join(REPO, 'src')) > outM;
}
function compileEngine() {
  return new Promise((resolve) => {
    if (!fs.existsSync(TSC)) return resolve(false);                     // no local tsc → run the existing engine
    const p = spawn(process.execPath, [TSC, '-p', REPO],
      { cwd: REPO, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}
// Rebuild if stale; never block the wrap on a compile failure — fall back to the last good engine.
async function ensureBuilt() {
  try { if (engineIsStale()) await compileEngine(); } catch { /* run whatever exists */ }
}

async function runEngine(cmd, folder, source, extraArgs) {
  await ensureBuilt();                                                  // auto-compile when the TS source changed
  return new Promise((resolve) => {
    let out = '';
    const args = [ENGINE, cmd, '--cwd', folder];
    if (source) args.push('--source', source);
    if (extraArgs) args.push(...extraArgs);
    const p = spawn(process.execPath, args,
      { cwd: folder, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
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
      { cwd: folder, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
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
  let source = 'claude-code';
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
    if (res.file) shell.openPath(res.file);                                      // and open the wrap to read
    // Open the passive feedback card — INDEPENDENT of the copy/open above (it never gates re-entry).
    const eventId = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const showReentry = !!(res.prev && cfg.lastFeedbackEventId); // a genuinely earlier note + a row to patch
    openCard(
      { nextMove: res.nextMove, copied, reentry: showReentry ? { title: res.prev.title } : null },
      { folder, wrapId: res.wrapId, eventId, pressTs: new Date().toISOString(),
        prevEventId: showReentry ? cfg.lastFeedbackEventId : null }
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
    model_version: process.env.WRAPITUP_MODEL || 'claude-sonnet-4-6',
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
    if (card) { card.webContents.send('card-data', payload); card.showInactive(); } // show WITHOUT activating
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

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
