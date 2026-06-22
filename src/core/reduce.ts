// Reduce a raw event log into grounded facts (the `derived` block). No vscode.
// This is where the "what works / what broke" GROUNDING lives:
// every fact here traces to a real captured event, never a guess.

import { WrapEvent, Derived } from "./types";

export function reduceEvents(events: WrapEvent[]): Derived {
  const churn = new Map<string, { churn: number; last: number }>();
  const diag = new Map<string, { errs: number; cleared: number; top: string[] }>();
  const created = new Set<string>();
  const deleted = new Set<string>();
  const changed = new Set<string>();
  const runs = new Map<string, { exitCode: number; outTail: string; t: number }>(); // last outcome per command wins (time-ordered)
  const everFailed = new Set<string>(); // any command that failed at least once this session
  let debuggedActive = false;
  let saves = 0;

  for (const e of events) {
    switch (e.kind) {
      case "doc.change": {
        const c = churn.get(e.uri) || { churn: 0, last: 0 };
        c.churn += e.churn;
        c.last = Math.max(c.last, e.t);
        churn.set(e.uri, c);
        break;
      }
      case "file.save":
        saves++;
        break;
      case "file.create":
        created.add(e.uri);
        break;
      case "file.delete":
        deleted.add(e.uri);
        break;
      case "fs.change":
        if (e.op === "create") created.add(e.uri);
        else if (e.op === "delete") deleted.add(e.uri);
        else changed.add(e.uri);
        break;
      case "diag.delta": {
        const d = diag.get(e.uri) || { errs: 0, cleared: 0, top: [] };
        if (e.deltaErrors < 0) d.cleared += -e.deltaErrors;
        d.errs = e.errors;
        if (e.topMessages && e.topMessages.length) d.top = e.topMessages;
        diag.set(e.uri, d);
        break;
      }
      case "shell.exec":
        if (typeof e.exitCode === "number") {
          if (e.exitCode !== 0) everFailed.add(e.cmd);
          const prev = runs.get(e.cmd);
          if (!prev || e.t >= prev.t) runs.set(e.cmd, { exitCode: e.exitCode, outTail: e.outTail || "", t: e.t });
        }
        break;
      case "task.end":
        if (typeof e.exitCode === "number") {
          if (e.exitCode !== 0) everFailed.add(e.name);
          const prev = runs.get(e.name);
          if (!prev || e.t >= prev.t) runs.set(e.name, { exitCode: e.exitCode, outTail: "", t: e.t });
        }
        break;
      case "debug.start":
        debuggedActive = true;
        break;
    }
  }

  // Collapse repeated runs of the SAME command to its FINAL outcome (a fail later
  // superseded by a pass = passed). Without this, a fix-in-flight leaves both a PASS
  // and a FAIL on record, dropping status to "Partially working" and making the LLM
  // hedge a session that actually ended green.
  const passedRuns: Derived["passedRuns"] = [];
  const failedRuns: Derived["failedRuns"] = [];
  const recoveredRuns: Derived["recoveredRuns"] = [];
  for (const [cmd, r] of runs) {
    if (r.exitCode === 0) {
      passedRuns.push({ cmd });
      if (everFailed.has(cmd)) recoveredRuns.push({ cmd }); // failed earlier, green now = fixed in-flight
    } else {
      failedRuns.push({ cmd, exitCode: r.exitCode, outTail: r.outTail });
    }
  }

  const hotFiles = [...churn.entries()]
    .map(([uri, c]) => ({ uri, churn: c.churn, lastTouched: c.last }))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, 8);

  const fixedSignals = [...diag.entries()]
    .filter(([, d]) => d.cleared > 0 && d.errs === 0)
    .map(([uri, d]) => ({ uri, clearedErrors: d.cleared }));

  const brokenSignals = [...diag.entries()]
    .filter(([, d]) => d.errs > 0)
    .map(([uri, d]) => ({ uri, openErrors: d.errs, topMessages: d.top }));

  const deadEnds = [...created].filter((u) => deleted.has(u)).map((uri) => ({ uri }));
  const touched = [...changed].filter((u) => !created.has(u) && !deleted.has(u));

  return {
    hotFiles,
    fixedSignals,
    brokenSignals,
    failedRuns,
    passedRuns,
    recoveredRuns,
    deadEnds,
    debuggedActive,
    saves,
    created: [...created],
    deleted: [...deleted],
    touched,
  };
}

// Reconcile the EVENT-derived created/touched sets against git's authoritative
// "vs HEAD" truth. The fs/editor watcher fires "create" for files that already
// existed at HEAD (re-initialized scaffolds, files created then committed in the
// same session), so a chat-blind recorder must NOT call a git-modified or
// already-committed file "created this session" — that contradicts the diff.
// A file is "created" only if it is
// genuinely new vs HEAD; an existing file that changed is a modification.
// No-op when there is no git (the vibe/non-git case keeps event classification).
export function reconcileGitStatus(
  d: Derived,
  git?: { diffVsHead?: string; changedFiles?: string[]; committedFiles?: string[] },
): Derived {
  if (!git) return d;
  const norm = (s: string) => s.replace(/\\/g, "/");
  const baseOf = (s: string) => norm(s).split("/").pop() || s;

  const newF = new Set<string>(), modF = new Set<string>(), delF = new Set<string>();
  const lines = (git.diffVsHead || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^diff --git a\/.+? b\/(.+)$/);
    if (!m) continue;
    const look = lines.slice(i + 1, i + 5);
    if (look.some((l) => l.startsWith("new file mode"))) newF.add(norm(m[1]));
    else if (look.some((l) => l.startsWith("deleted file mode"))) delF.add(norm(m[1]));
    else modF.add(norm(m[1]));
  }
  const committed = new Set((git.committedFiles || []).map(norm));
  // "Existed at HEAD" = anything git already tracks, or shows as a modification/deletion.
  const existedBase = new Set<string>([...committed, ...modF, ...delF].map(baseOf));
  const modBase = new Set([...modF].map(baseOf));
  const deletedBase = new Set(d.deleted.map(baseOf));

  const created = d.created.filter((f) => !existedBase.has(baseOf(f)) && !deletedBase.has(baseOf(f)));
  const moved = d.created.filter((f) => modBase.has(baseOf(f)) && !deletedBase.has(baseOf(f)));

  const seen = new Set(created.map((f) => baseOf(f)));
  const touched: string[] = [];
  for (const f of [...d.touched, ...moved]) {
    const b = baseOf(f);
    if (seen.has(b) || deletedBase.has(b)) continue;
    seen.add(b);
    touched.push(f);
  }
  return { ...d, created, touched };
}
