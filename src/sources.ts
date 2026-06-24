// Session-source registry. Each adapter locates a first-party local transcript the agent
// CLI already wrote to disk and translates it into the WrapEvent[]/Turn[] the engine
// consumes. Adding the next agent CLI is one more entry in SOURCES — the engine
// (reduce → wrap → enrich) needs no changes.

import * as fs from "fs";
import { WrapEvent, Turn } from "./core/types";
import * as claudeCode from "./claudeCode";
import * as kiro from "./kiro";
import * as kiroIde from "./kiroIde";

export interface SessionSource {
  name: string; // the canonical label recorded as the wrap's usedSource
  aliases?: string[]; // extra --source values that also select this adapter (e.g. "kiro" for both Kiro tools)
  findTranscript(folder: string): string | null;
  transcriptToEvents(file: string, folder?: string): WrapEvent[];
  transcriptToConversation(file: string): Turn[];
}

const claudeCodeSource: SessionSource = {
  name: "claude-code",
  findTranscript: claudeCode.findTranscript,
  transcriptToEvents: claudeCode.transcriptToEvents,
  transcriptToConversation: claudeCode.transcriptToConversation,
};

const kiroCliSource: SessionSource = {
  name: "kiro-cli",
  aliases: ["kiro"],
  findTranscript: kiro.findTranscript,
  transcriptToEvents: kiro.transcriptToEvents,
  transcriptToConversation: kiro.transcriptToConversation,
};

const kiroIdeSource: SessionSource = {
  name: "kiro-ide",
  aliases: ["kiro"],
  findTranscript: kiroIde.findTranscript,
  transcriptToEvents: kiroIde.transcriptToEvents,
  transcriptToConversation: kiroIde.transcriptToConversation,
};

export const SOURCES: SessionSource[] = [claudeCodeSource, kiroCliSource, kiroIdeSource];

// Resolve which source to read for `folder`, honoring an explicit `--source`:
//   "auto"   -> probe ALL adapters; the most RECENTLY-written transcript wins (i.e. the
//               session you just finished, in whichever tool). This is the default.
//   "<name>" -> only adapters matching that name or alias. "kiro" selects BOTH Kiro tools
//               (kiro-cli + kiro-ide, newest wins); "claude-code" / "kiro-cli" / "kiro-ide"
//               pick exactly one. usedSource is always the precise name.
//   "git"    -> handled by the caller before it gets here.
// Returns null when no adapter finds a relevant session (caller falls back to git-only).
export function resolveSource(folder: string, requested: string): { src: SessionSource; file: string } | null {
  const matches = (s: SessionSource) => s.name === requested || (s.aliases || []).includes(requested);
  const named = requested && requested !== "auto" ? SOURCES.filter(matches) : [];
  const pool = named.length ? named : SOURCES; // unknown/auto ⇒ probe everything

  let best: { src: SessionSource; file: string; mtime: number } | null = null;
  for (const s of pool) {
    let file: string | null = null;
    try { file = s.findTranscript(folder); } catch { file = null; }
    if (!file) continue;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* keep 0 */ }
    if (!best || mtime > best.mtime) best = { src: s, file, mtime };
  }
  return best ? { src: best.src, file: best.file } : null;
}
