// Mode registry — the "mode switch" that lets one engine serve more than coding.
// Kept deliberately LEAN (the scope red-team's call): it selects the enrich module per
// DOMAIN mode and nothing more. Speculative slots (per-mode redaction add-ons, status
// relabels) and AUTO-DETECTION are intentionally NOT here yet — auto-detect can silently
// re-route a coding session through the wrong enricher, so selection stays an explicit
// opt-in (WRAPITUP_MODE, read in cli.ts) until it is proven safe on the existing test suite.
//
// Adding a domain (data, infra, finance, authoring) is then a one-line MODES entry +
// one enrich.<mode>.ts module — nothing downstream moves.

import * as enrichBlind from "./enrich";
import * as enrichChat from "./enrich.northstar";
import * as enrichWriting from "./enrich.writing";
import { SessionContext, WrapUp, WrapMode } from "./types";

// The stable 3-symbol enrich surface every enricher exposes (matches enrich.ts exactly).
export interface EnrichModule {
  buildEnrichInput(ctx: SessionContext, local: WrapUp): { system: string; user: string };
  WRAP_TOOL: { name: string; description: string; input_schema: any };
  applyEnrichmentObj(local: WrapUp, p: any): WrapUp;
}

export interface ModeEntry {
  id: WrapMode;
  label: string;
  // Returns the enrich module for this mode, or undefined to DEFER to the presence-based
  // chat-aware/chat-blind fallback — which is exactly how "code" stays byte-identical to today.
  enrich(ctx: SessionContext): EnrichModule | undefined;
}

export const MODES: Record<WrapMode, ModeEntry> = {
  code: { id: "code", label: "Code", enrich: () => undefined },
  writing: { id: "writing", label: "Writing", enrich: () => enrichWriting },
};

export const DEFAULT_MODE: WrapMode = "code";

export function modeOf(mode: WrapMode | undefined): ModeEntry {
  return MODES[mode ?? DEFAULT_MODE] ?? MODES[DEFAULT_MODE];
}

// Resolve the enrich module for a session: a mode override if it provides one, else the
// presence-based chat-aware vs chat-blind fallback (today's behavior, byte-identical when
// ctx.mode is "code"/undefined). The DOMAIN axis (mode) and the VISIBILITY axis (is there a
// transcript?) are orthogonal: a mode receives ctx so it could honor both, but writing mode
// keeps that axis inside its own prompt, so it just returns its module here.
export function selectEnrich(ctx: SessionContext): EnrichModule {
  const override = modeOf(ctx.mode).enrich(ctx);
  if (override) return override;
  return ctx.conversation && ctx.conversation.length ? enrichChat : enrichBlind;
}
