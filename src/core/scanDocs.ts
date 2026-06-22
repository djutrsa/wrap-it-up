// Doc-structure / open-thread scanner — the WRITING-mode "oracle" (the analog of
// the run/compile pass coding gets for free). Deterministic, pure, dependency-free
// (no vscode, no npm deps — same constraint as reduce.ts/wrap.ts). Runs ONLY when
// WRAPITUP_MODE=writing (gated in cli.ts), AFTER reduce/reconcile and BEFORE
// buildLocalWrap. Reads text the pipeline already captured (changedFileContents +
// dirtyBuffers + git.diffVsHead). No new event kinds, no WrapUp schema change.
//
// What it grounds: a heading-tree pass classifies each section empty/thin/drafted
// (so "what's unfinished" is real, not a guess); a line-scan finds explicit open-work
// markers (TODO/TK/placeholder/empty checkbox…); a diff walk attributes "what changed
// this session" to prose. False-positive guards (fenced code, inline code, blockquotes,
// table cells, front-matter, prose ellipsis, self-ingestion) are MUST-HAVE, not polish —
// a writing tool that cried wolf on every "draft" or "for now" in prose would be useless.

import { DocStructure } from "./types";
import { redact } from "./redact";

const PROSE_EXT = /\.(md|markdown|mdx|txt|rst)$/i;
// Never scan the tool's OWN emitted wraps (they contain "## What is broken" headers and
// TODO-laden prompts) — that is an infinite-feedback false-positive source.
const SELF = /(^|[\\/])\.wrap-it-up([\\/]|$)|wrapups[\\/]/i;

// Convention markers are written UPPERCASE when used as markers; the lowercase words
// ("draft", "hack", "wip") are normal prose, so the alpha set is CASE-SENSITIVE on
// purpose (precision over recall — the trust red-team's first-slice posture).
const MARK_CS = /\b(TODO|TKTK|TBD|FIXME|XXX|WIP|HACK)\b|\?\?\?|\[\s*\]|\[\s*\?\s*\]/;
const MARK_CI = /\[citation needed\]|\[\s*todo[^\]]*\]/i;
const TK_BARE = /\bTK\b/; // standalone uppercase TK only (avoid "Tk", "atk")
// Deliberately EXCLUDES "for now" / "temporarily" — far too common as ordinary prose
// connectives to flag in a writing tool. Only unambiguous editorial placeholders remain.
const PHRASE = /\b(fix later|come back to this|placeholder|lorem ipsum|fill (this )?in|to be written|to be added|rewrite this|expand (on )?this)\b/i;

const ATX = /^(#{1,6})\s+(.+?)\s*#*$/;
const MIN_BODY = 12; // non-whitespace word count below which a section reads as a stub
const baseOf = (u: string) => u.split(/[\\/]/).pop() || u;
const oneLine = (s: string) => redact(s).replace(/\s+/g, " ").trim().slice(0, 100);

// Strip inline-code spans so a literal `TODO` example in prose doesn't fire.
const stripInline = (line: string) => line.replace(/`[^`]*`/g, " ");

interface FileScan {
  empty: DocStructure["emptyHeadings"];
  threads: DocStructure["openThreads"];
  coverage: DocStructure["coverage"][number];
}

function scanFile(uri: string, text: string): FileScan {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const empty: DocStructure["emptyHeadings"] = [];
  const threads: DocStructure["openThreads"] = [];
  const sections: { section: string; level: number; line: number; words: number; kind: "empty" | "thin" | "drafted" }[] = [];

  // --- Pass 1: heading tree + per-section body word counts ---
  let inFence = false, fenceTok = "";
  let inFront = false;
  let cur: { section: string; level: number; line: number; words: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const kind = cur.words === 0 ? "empty" : cur.words < MIN_BODY ? "thin" : "drafted";
    sections.push({ section: cur.section, level: cur.level, line: cur.line, words: cur.words, kind });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") { inFront = true; continue; } // YAML front-matter
    if (inFront) { if (line.trim() === "---") inFront = false; continue; }
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) { const tok = f[1][0]; if (!inFence) { inFence = true; fenceTok = tok; } else if (fenceTok === tok) inFence = false; continue; }
    if (inFence) continue;
    const h = line.match(ATX);
    if (h) { flush(); cur = { section: h[2].trim(), level: h[1].length, line: i + 1, words: 0 }; continue; }
    if (cur) {
      if (/^(\s{4,}|\t)/.test(line)) continue; // indented code block — not prose body
      cur.words += (line.match(/\S+/g) || []).length;
    }
  }
  flush();
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.kind === "drafted") continue;
    // A heading that contains deeper subheadings is a CONTAINER (e.g. an H1 title above H2
    // sections, or an H2 with an empty intro above H3s), not a stub — its content lives in
    // its children, which are flagged on their own. Don't cry wolf on the document title.
    if (sections[i + 1] && sections[i + 1].level > s.level) continue;
    empty.push({ uri, section: s.section, level: s.level, line: s.line, kind: s.kind, words: s.words });
  }

  // --- Pass 2: open-work markers (guarded) ---
  inFence = false; fenceTok = ""; inFront = false;
  let curSection: string | null = null;
  for (let i = 0; i < lines.length && threads.length < 200; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") { inFront = true; continue; }
    if (inFront) { if (line.trim() === "---") inFront = false; continue; }
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) { const tok = f[1][0]; if (!inFence) { inFence = true; fenceTok = tok; } else if (fenceTok === tok) inFence = false; continue; }
    if (inFence) continue;
    const h = line.match(ATX);
    if (h) {
      curSection = h[2].trim();
      if (/(\.\.\.|…)\s*$/.test(line)) threads.push({ uri, section: curSection, marker: "...", line: i + 1, excerpt: oneLine(line) });
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith(">")) continue;     // blockquote — quoting a TODO, not tracking one
    if (t.startsWith("|")) continue;     // table cell — "TBD" there is content, not a stub
    const scan = stripInline(line);
    let hit: string | null = null;
    const comment = scan.match(/<!--([\s\S]*?)-->/);
    if (comment) {
      const body = comment[1].replace(/\s+/g, " ").trim();
      const directive = /^(prettier|eslint|markdownlint|toc|more|\/|#)/i.test(body) || /-ignore|:\s*(on|off)/i.test(body);
      if (!directive && (MARK_CS.test(body) || MARK_CI.test(body) || PHRASE.test(body) || body.length >= 10)) hit = "<!-- " + body.slice(0, 40) + " -->";
    }
    if (!hit) {
      const noComment = scan.replace(/<!--[\s\S]*?-->/g, " ");
      const m = noComment.match(MARK_CS) || noComment.match(MARK_CI) || noComment.match(PHRASE) || (TK_BARE.test(noComment) ? (["TK"] as unknown as RegExpMatchArray) : null);
      if (m) hit = m[0];
      else if (/^\s*[-*]\s.*(\.\.\.|…)\s*$/.test(line)) hit = "..."; // list-item ellipsis with no body
    }
    if (hit) threads.push({ uri, section: curSection, marker: hit.slice(0, 30), line: i + 1, excerpt: oneLine(t) });
  }

  const total = sections.length;
  const drafted = sections.filter((s) => s.kind === "drafted").length;
  const coverage = { uri, total, drafted, sections: sections.slice(0, 30).map((s) => ({ section: s.section, words: s.words })) };
  return { empty, threads, coverage };
}

// What CHANGED this session, attributed to prose, straight from the diff (no run needed).
// Mirrors the `diff --git a/… b/…` block walk in reduce.ts:reconcileGitStatus (copied
// locally on purpose — refactoring the shared coding walk is out of this slice's scope).
function proseDeltas(diff: string): DocStructure["prose"] {
  const out = new Map<string, DocStructure["prose"][number]>();
  const lines = diff.split("\n");
  let cur: string | null = null;
  for (const raw of lines) {
    const m = raw.match(/^diff --git a\/.+? b\/(.+)$/);
    if (m) { const file = m[1]; cur = PROSE_EXT.test(file) && !SELF.test(file) ? file : null; if (cur && !out.has(cur)) out.set(cur, { uri: cur, addedWords: 0, removedWords: 0, addedHeadings: [], removedHeadings: [] }); continue; }
    if (!cur) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const rec = out.get(cur)!;
    if (raw.startsWith("+")) { const c = raw.slice(1); const hh = c.match(/^(#{1,6})\s+(.+)/); if (hh) rec.addedHeadings.push(hh[2].trim()); rec.addedWords += (c.match(/\S+/g) || []).length; }
    else if (raw.startsWith("-")) { const c = raw.slice(1); const hh = c.match(/^(#{1,6})\s+(.+)/); if (hh) rec.removedHeadings.push(hh[2].trim()); rec.removedWords += (c.match(/\S+/g) || []).length; }
  }
  return [...out.values()];
}

export function scanDocs(
  changedFileContents: { uri: string; text: string }[],
  dirtyBuffers: { uri: string; text: string }[],
  git?: { diffVsHead?: string },
): DocStructure {
  // Source of truth = on-disk ∪ dirty, keyed by uri; the unsaved buffer (freshest) wins.
  const byUri = new Map<string, string>();
  for (const f of changedFileContents) if (PROSE_EXT.test(f.uri) && !SELF.test(f.uri)) byUri.set(f.uri, f.text);
  for (const b of dirtyBuffers) if (PROSE_EXT.test(b.uri) && !SELF.test(b.uri)) byUri.set(b.uri, b.text);

  const emptyHeadings: DocStructure["emptyHeadings"] = [];
  const openThreads: DocStructure["openThreads"] = [];
  const coverage: DocStructure["coverage"] = [];
  let n = 0;
  for (const [uri, text] of byUri) {
    if (n++ >= 30) break; // hard cap on files scanned
    const r = scanFile(uri, text);
    emptyHeadings.push(...r.empty);
    openThreads.push(...r.threads);
    coverage.push(r.coverage);
  }

  return {
    emptyHeadings: emptyHeadings.slice(0, 12),
    openThreads: openThreads.slice(0, 20),
    missingSections: [], // 1c doc-skeleton gaps DEFERRED (behind WRAPITUP_DOC_SKELETON; off by default)
    coverage,
    prose: proseDeltas(git?.diffVsHead || ""),
  };
}

export const MARKER_DENSE_BASENAME = /^(todo|roadmap|backlog|changelog|notes)\b/i;
export { baseOf };
