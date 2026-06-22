// VS Code ADAPTER: subscribes to stable editor events and appends them to
// .wrap-it-up/session.log.jsonl. The only `vscode`-dependent capture code.
// Never throws (a recorder must not interrupt the user).

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { WrapEvent } from "./core/types";
import { redact, clip } from "./core/redact";

export class Recorder {
  private disposables: vscode.Disposable[] = [];
  private pending = new Map<string, { churn: number; lang: string; dirty: boolean }>();
  private diagBase = new Map<string, { e: number; w: number }>();
  private lastFocus = "";
  private fsRecent = new Map<string, number>();
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(private folder: string, private logPath: string, private doRedact: () => boolean) {}

  private rel(uri: vscode.Uri): string {
    try { return path.relative(this.folder, uri.fsPath) || uri.fsPath; } catch { return uri.fsPath; }
  }
  private red(s: string): string { return this.doRedact() ? redact(s) : s; }

  private write(ev: WrapEvent): void {
    try { fs.appendFileSync(this.logPath, JSON.stringify(ev) + "\n", "utf8"); } catch { /* never throw */ }
  }

  start(): void {
    this.write({ t: Date.now(), kind: "session.mark", reason: "workspace-open" });

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== "file") return;
        const churn = e.contentChanges.reduce((a, c) => a + c.text.length + c.rangeLength, 0);
        if (!churn) return;
        const uri = this.rel(e.document.uri);
        const p = this.pending.get(uri) || { churn: 0, lang: e.document.languageId, dirty: e.document.isDirty };
        p.churn += churn; p.dirty = e.document.isDirty;
        this.pending.set(uri, p);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme !== "file") return;
        this.flush();
        this.write({ t: Date.now(), kind: "file.save", uri: this.rel(doc.uri), lang: doc.languageId });
      }),
      vscode.workspace.onDidCreateFiles((e) => e.files.forEach((u) => this.write({ t: Date.now(), kind: "file.create", uri: this.rel(u) }))),
      vscode.workspace.onDidDeleteFiles((e) => e.files.forEach((u) => this.write({ t: Date.now(), kind: "file.delete", uri: this.rel(u) }))),
      vscode.workspace.onDidRenameFiles((e) => e.files.forEach((f) => this.write({ t: Date.now(), kind: "file.rename", from: this.rel(f.oldUri), to: this.rel(f.newUri) }))),
      vscode.languages.onDidChangeDiagnostics((e) => this.onDiagnostics(e)),
      vscode.tasks.onDidEndTaskProcess((e) => this.write({ t: Date.now(), kind: "task.end", name: e.execution.task.name, exitCode: e.exitCode })),
      vscode.debug.onDidStartDebugSession((s) => this.write({ t: Date.now(), kind: "debug.start", name: s.name })),
      vscode.debug.onDidTerminateDebugSession((s) => this.write({ t: Date.now(), kind: "debug.end", name: s.name })),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (!ed || ed.document.uri.scheme !== "file") return;
        const uri = this.rel(ed.document.uri);
        if (uri === this.lastFocus) return;
        this.lastFocus = uri;
        this.write({ t: Date.now(), kind: "focus.editor", uri, lang: ed.document.languageId });
      }),
    );

    // FILE SYSTEM WATCHER — fires on disk create/change/delete regardless of who
    // wrote the file (editor, Cursor Agent, or an external CLI like Claude Code).
    // This is what makes the Claude-Code-in-terminal workflow visible.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    watcher.onDidCreate((u) => this.onFs(u, "create"));
    watcher.onDidChange((u) => this.onFs(u, "change"));
    watcher.onDidDelete((u) => this.onFs(u, "delete"));
    this.disposables.push(watcher);

    // Terminal shell execution — STABLE since VS Code 1.93. Feature-detect for Cursor compat.
    const anyWin = vscode.window as any;
    if (typeof anyWin.onDidEndTerminalShellExecution === "function") {
      this.disposables.push(
        anyWin.onDidEndTerminalShellExecution(async (e: any) => {
          try {
            const cmd: string = e?.execution?.commandLine?.value || "";
            let out = "";
            if (e?.execution?.read) {
              for await (const chunk of e.execution.read()) { out += chunk; if (out.length > 20000) break; }
            }
            out = out.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colour codes
            this.write({
              t: Date.now(), kind: "shell.exec",
              cmd: this.red(cmd), exitCode: typeof e?.exitCode === "number" ? e.exitCode : undefined,
              outHead: this.red(clip(out, 1500, 0)), outTail: this.red(clip(out, 0, 600)),
            });
          } catch { /* ignore */ }
        }),
      );
    }

    this.flushTimer = setInterval(() => this.flush(), 3000);
  }

  private flush(): void {
    for (const [uri, p] of this.pending) {
      this.write({ t: Date.now(), kind: "doc.change", uri, lang: p.lang, churn: p.churn, dirty: p.dirty });
    }
    this.pending.clear();
  }

  private static IGNORE = /(^|[\\/])(node_modules|\.git|\.wrap-it-up|dist|out|build|\.next|\.cache|\.vscode|coverage)([\\/]|$)|\.(log|map|lock)$/i;

  private onFs(uri: vscode.Uri, op: "create" | "change" | "delete"): void {
    if (uri.scheme !== "file") return;
    const key = this.rel(uri);
    if (Recorder.IGNORE.test(key)) return;
    const now = Date.now();
    const last = this.fsRecent.get(key + op);
    if (last && now - last < 800) return; // de-dupe rapid repeats
    this.fsRecent.set(key + op, now);
    this.write({ t: now, kind: "fs.change", uri: key, op });
  }

  private onDiagnostics(e: vscode.DiagnosticChangeEvent): void {
    for (const uri of e.uris) {
      if (uri.scheme !== "file") continue;
      const diags = vscode.languages.getDiagnostics(uri);
      let errs = 0, warns = 0;
      const msgs: string[] = [];
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) { errs++; if (msgs.length < 3) msgs.push(d.message); }
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warns++;
      }
      const key = this.rel(uri);
      const prev = this.diagBase.get(key) || { e: 0, w: 0 };
      if (errs === prev.e && warns === prev.w) continue;
      this.write({
        t: Date.now(), kind: "diag.delta", uri: key,
        errors: errs, warnings: warns, deltaErrors: errs - prev.e, deltaWarnings: warns - prev.w,
        topMessages: msgs.map((m) => this.red(m)),
      });
      this.diagBase.set(key, { e: errs, w: warns });
    }
  }

  dispose(): void {
    this.flush();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

// Read back the CURRENT session slice (from the last session.mark to EOF).
export function readSessionSlice(logPath: string): WrapEvent[] {
  let lines: string[] = [];
  try { lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean); } catch { return []; }
  const events: WrapEvent[] = [];
  for (const ln of lines) { try { events.push(JSON.parse(ln) as WrapEvent); } catch { /* skip */ } }
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) { if (events[i].kind === "session.mark") { start = i; break; } }
  return events.slice(start);
}
