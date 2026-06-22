# Wrap-It-Up — Floating Widget · Design Exploration Log

**Date:** 2026-06-20
**Status:** v1 look & feel **locked & approved as the MVP** — "Honey" theme, **Medium** size (226 × 104), buttons = **bow-box** ("Wrap it up") + **footprints** ("Where was I?"). A **runnable always-on-top desktop widget** (Electron) is **built and working** — see [How to run it](#how-to-run-it-re-trigger). Buttons look/feel done but don't *do* anything yet (no real save/reload).
**Purpose:** Capture *how we got here and why* so no decision context is lost. Each section records the decision **and** the reasoning behind it. Fidelity was explored as interactive HTML prototypes (see [File map](#file-map)).

---

## TL;DR — the current decision

A small, **warm, calm** floating desktop widget for people with ADHD ("catch the crash" tool):

- **Look:** "Honey" — warm, **near-opaque caramel** body (so it looks identical on any wallpaper), an **amber accent disc**, a subtle hover **sheen**, a **tiny-pop** hover (not a glaring highlight), **white labels**.
- **Size:** **Medium — 226 × 104** (~2.2 : 1). Taller than a thin bar so the icons are legible; trimmed in width so it reads like a calm rounded object, not a stretched strip.
- **Buttons:** circular icon discs with a tiny label beneath.
  - **"Wrap it up"** = 🎁 **bow-box** (gift box, simple two-loop bow).
  - **"Where was I?"** = 👣 **footprints** (retrace your steps). Label wraps two lines: WHERE / WAS I?.
- **Interaction:** a **single centered "Wrap it up"** button by default. Click it → an **amber progress line travels around the border** (in lieu of a spinner) → a **checkmark** confirms → **"Where was I?"** slides in. Crucially, **prominence follows the action**: once a save exists, "Where was I?" takes the **primary (left, accent) spot** and "Wrap it up" **steps aside to the right** as secondary.

---

## The brief (what we set out to do)

Explore **top-notch, extremely polished** look & feel for a floating desktop widget that is:
- **draggable** via mouse,
- **non-invasive** — roughly the width & height of **3 horizontally-stitched desktop icons** (~240 × 84 to start),
- has space for **2 buttons**: a "save"-equivalent always available, and a "load"-equivalent available only when conditions are met (e.g., a save exists).

Three framing decisions were made up front:
1. **Variations on one style** (not 5 wildly different directions) — we wanted to pick a *vibe* and refine, not choose between unrelated worlds.
2. **Interactive HTML gallery** as the fidelity medium — lets us feel hover/press/drag and the conditional states, at true pixel size, for free.
3. **Span the personality range** quiet → characterful, so the user could locate their taste.

---

## Decision log (chronological, with the *why*)

### 1. Five variations of one house style
Built a single house style (a small frosted bar, soft-rounded, grip + two icon buttons) and produced 5 variations spanning quiet→characterful, via a multi-agent design workflow (deep-spec → adversarial polish critique → family-coherence pass):
- **Whisper** (quietest, near-invisible), **Slate** (quiet/pro), **Aero** (balanced acrylic), **Pebble** (tactile), **Spark** (most characterful).
- *Why a workflow:* parallel divergent specs + an adversarial critique catch craft flaws and keep the 5 a coherent family (it flagged & fixed radius/letter-cap drift so they read as one object).

### 2. Interaction model correction — "squish to make room"
**Original (wrong):** two buttons always present, the second locked/dimmed until conditions met.
**Corrected (user):** only **one centered button** by default; when conditions are met it **"squishes"** and **makes room** for the second to slide in (1 button → 2).
- *Why:* the locked-second-button reads as clutter; the squish-and-reveal is cleaner and makes the second action feel *earned*. This became each variation's signature unlock beat.

### 3. Real product strings + circular icon buttons
- Strings: **"WRAP IT UP"** (save) and **"WHERE WAS I?"** (load).
- Buttons changed from rounded-rect to a **circle holding only the icon, with the label beneath** — this lets the **accent live in the disc** (cleaner accent discipline) and reads as a friendlier object.
- **"WHERE WAS I?"** wraps to two lines (WHERE / WAS I?); both buttons reserve equal label height so the two discs stay vertically aligned. Disc sizes trimmed slightly so the two-line label fits in the bar.

### 4. Prominence + position transfer
When a save exists, **"Where was I?" becomes the primary action** — it takes the **left/primary position and the accent disc**, and **"Wrap it up" steps aside to the right** as secondary.
- *Why:* if you have a stashed session, **resuming is the thing that matters most**, so the accent should follow the most relevant action. (Mechanically: the accent/primary styling is bound to "Save when no save exists, else Load.")

### 5. "Wrap it up" progress meter (promoted from Whisper's perimeter line)
Whisper's signature was a line that travels **around** the widget on save. We promoted it to a **real feature**: clicking "Wrap it up" runs that line as a **progress meter (in lieu of a spinner)** until the save completes, then a **checkmark** confirms, then "Where was I?" reveals. Unified across all variations.
- *Why:* the real "wrap it up" (summarize + commit + draft a note) takes time; a perimeter progress meter is a calm, on-brand alternative to a spinner, and folds three liked details (line-as-progress, faded reveal, checkmark) into one flow.
- **Open question:** the demo uses a **determinate** fill (~1.25 s). Real save time is *unknown*, so a fixed fill is technically a fake progress bar. The honest version is **indeterminate** — a short segment **chases around the loop** until the async save resolves, then snaps to a full ring + checkmark. **Decide this when building for real.**

### 6. Hover = a *tiny pop*, not a glare
Toned hover down to a subtle scale "pop" with a minimal background change.
- *Why (user):* other variations over-highlighted on mouse-over; for an ADHD tool the hover should be inviting, not shouty.

### 7. Finalists: #3 Aero and #5 Spark
User picked **Aero** (acrylic, sheen, checkmark, tiny-pop hover) and **Spark** (non-glossy, characterful). Liked-but-not-chosen bits noted (e.g., Slate's clean background); Pebble dropped.

### 8. Palette pivot — warm, not cool
**Cool tones won't work** for an ADHD "catch the crash" tool — they recede. We want **noticeable but not screaming "FOCUS ON MEEEE."**
- *Why:* warm hues optically **advance** (catch the eye at the crash moment) but, kept at moderate saturation on a calm body, they don't alarm. No pure red, no neon.
- Re-toned the two finalists warm: **#3 → "Honey"** (warm light, amber) and **#5 → "Ember"** (warm dark, terracotta).

### 9. Chose **Honey** (warm light) as v1.

### 10. Wallpaper-independence fix
Honey looked perfect on a dark wallpaper but **broke on light** (translucent glass washed out, white labels lost contrast). Fix: make the body **near-opaque warm caramel** so it carries its own tone on **any** wallpaper, baking in the look that worked over dark.
- **Tradeoff:** white labels need a tone *this deep* to stay legible, so "constant" means Honey commits to **caramel**, not pale cream. (A genuinely pale version would require switching labels to warm-brown.)

### 11. Icon evaluation — replace floppy & lightbulb
Ran a 4-lens evaluation workflow (literal / metaphor / ADHD cognitive-load / brand-warmth) + synthesis. Verdicts:
- **Floppy ("Wrap it up"):** legible but **cold and too small a metaphor** — says "save *this file*," not "package & stash the *whole session*"; a dying glyph for younger users.
- **Lightbulb ("Where was I?"):** **semantically backwards** — a bulb means *"new idea / inspiration,"* but the action is *"resume / re-orient."* At re-entry it nudges toward a *new* distraction (the exact failure the tool prevents). **Most urgent fix.**
- **Recommended pair (chosen):** 🎁 **bow-box** ("put a bow on it" = finish & package, warm, a *gift to future-you*) + 👣 **footprints** ("retrace your steps," warm, says *you're not lost*). Their silhouettes share nothing, so they never blur at small size; both are concrete real-world objects (fast decode).
- Collisions deliberately avoided: checkmark (reserved for the confirm), lightbulb, and a both-icons-are-a-place-marker trap.

### 12. Size — relax height, trim width, enlarge the icon
Footprints weren't perfectly legible at the original height. Fix: **grow the disc + icon** (where legibility comes from) by adding vertical room, and **trim width** so it squares up a touch (less "bar," more "calm object"). Compared three sizes; chose **Medium**.

| Size | Dimensions | Ratio | Disc / icon |
|---|---|---|---|
| Compact (original) | 240 × 84 | ~2.9 : 1 | 45 / 23px |
| **Medium (chosen)** | **226 × 104** | **~2.2 : 1** | **54 / 28px** |
| Tall | 212 × 122 | ~1.7 : 1 | 62 / 32px |

- *Why Medium:* buys most of the footprints legibility while staying compact and non-invasive; Tall was the fallback if true-size still felt tight.

### 13. Real desktop widget built (Electron) — MVP approved
Stood up the chosen Honey/Medium widget as an **actual frameless, transparent, always-on-top window** you can drag over real apps (the true "non-invasive" test). Lives in `desktop-widget/`. Key behaviours:
- **Always-on-top** (`screen-saver` level), **frameless + transparent**, no taskbar entry, draws its own warm shadow.
- **Click-through everywhere except the widget itself** — the renderer hit-tests the cursor and toggles `setIgnoreMouseEvents`, so the transparent area never blocks clicks to the apps underneath. *This is what makes it genuinely non-invasive.*
- **Dragged by its body** via `-webkit-app-region: drag` (buttons are `no-drag`); the OS moves the window, so no custom drag code.
- User verdict: **"looks perfect for an MVP."**

### 14. Hover-clip fix on "Where was I?"
Bug: on hover the "Where was I?" circle had its **top sliced off** (no longer a circle), while "Wrap it up" was fine.
- *Cause:* the load button keeps `overflow:hidden` (needed to hide it while collapsed to zero width); when its disc scales up on hover, the top gets clipped. "Wrap it up" never collapses, so it has no clip.
- *Fix:* clip **only while revealing** — `overflow:visible` once open (`.has-save`), `overflow:hidden` only during the reveal animation (`.has-save.unlocking`). Applied to the live widget and all prototype pages.

---

## Final v1 spec (as decided)

- **Theme "Honey":** body `linear-gradient(180deg, rgba(158,134,104,.96), rgba(144,120,92,.95), rgba(126,100,74,.96))` (near-opaque warm caramel), subtle blur for a premium edge, top-origin light, soft warm drop shadow.
- **Accent (primary disc):** amber `#F4AC42 → #E68A22`, white icon. **Secondary disc:** cream `rgba(255,250,243,.92)`, warm-brown icon.
- **Size Medium:** 226 × 104, radius 20, disc 54 (solo) / 48 (duo), icon 28px, label 9.5px (two-line "WHERE / WAS I?"), grip dots ~2.7px.
- **Buttons:** circular disc + label below. Wrap it up = bow-box; Where was I? = footprints.
- **Interaction:** single centered Wrap it up → click → amber perimeter **progress** sweep → **checkmark** → Where was I? slides into **primary (left, amber)**, Wrap it up demotes to **secondary (right, cream)**. Hover = tiny scale pop + warm sheen. Draggable by body; grip affordance at left.
- **Wallpaper-independent** (near-opaque), respects `prefers-reduced-motion`.

---

## File map

All under `C:\Users\you\WrapItUp\widget-lookfeel\`:

- **`gallery.html`** — all 5 original (cool) variations: Whisper, Slate, Aero, Pebble, Spark. The full exploration field, with the squish-reveal, progress sweep, prominence transfer, dark/light wallpaper, zoom.
- **`finalists.html`** — the two finalists re-toned warm: **Honey** (warm light) vs **Ember** (warm dark). Honey here is the near-opaque, wallpaper-constant version.
- **`icons.html`** — icon-pair comparison on the Honey widget: bow-box + **footprints** vs bow-box + **map-pin** (footprints won).
- **`sizes.html`** — Honey + bow-box + footprints at three sizes (Compact / **Medium** / Tall).
- **`desktop-widget/`** — the **runnable always-on-top desktop widget** (Electron). The live MVP: `main.js` (window: frameless, transparent, always-on-top, click-through), `widget.html` (the Honey/Medium widget). See [How to run it](#how-to-run-it-re-trigger).
- **`widget-design-log.md`** — this file.

Each browser prototype is self-contained (double-click to open). Controls: "A save exists" toggle (flip the reveal), inspect zoom (1× = true size), dark/light wallpaper, captions, re-center.

---

## How to run it (re-trigger)

### The browser prototypes (gallery / finalists / icons / sizes)
Just open the file — double-click it, or:
```
start C:\Users\you\WrapItUp\widget-lookfeel\sizes.html
```

### The real desktop widget (the live MVP)
Lives in `C:\Users\you\WrapItUp\widget-lookfeel\desktop-widget\`.

**Run it** (PowerShell):
```
cd C:\Users\you\WrapItUp\widget-lookfeel\desktop-widget
npm start
```
…or launch the binary directly without npm:
```
C:\Users\you\WrapItUp\widget-lookfeel\desktop-widget\node_modules\electron\dist\electron.exe C:\Users\you\WrapItUp\widget-lookfeel\desktop-widget
```
It appears **bottom-right**, floats on top of everything, and is click-through except over the widget.

**Quit it:** press **Ctrl + Shift + Q** (or **Esc** while it's focused). It does **not** auto-start after a reboot.

**After editing `widget.html` or `main.js`:** there's no hot-reload — **quit and relaunch** (`taskkill /F /IM electron.exe` then run again).

**One-time setup, only if `node_modules/` is missing** (e.g., fresh clone — though the whole folder is git-excluded, so this normally won't happen):
```
cd C:\Users\you\WrapItUp\widget-lookfeel\desktop-widget
npm install
node node_modules\electron\install.js   # IMPORTANT: fast npm installs skip the Electron runtime download (~232 MB); this fetches it
```
*(That `install.js` step is the gotcha we hit — `npm install` reported success but didn't download the actual Electron binary; running `install.js` pulled it.)*

---

## Open questions / next steps

1. **Real always-on-top desktop widget — ✅ DONE & approved as MVP.** Built and running (Electron) at `desktop-widget/`. The remaining work is to **make the buttons actually do something** — wire "Wrap it up" to a real save/capture and "Where was I?" to a real reload. (Today is look-and-feel only; the buttons animate but are inert.)
2. **Progress meter: determinate vs indeterminate** — switch the perimeter line to an indeterminate "chase" loop for the real (unknown-duration) save, snapping to a full ring + checkmark on completion.
3. **Ember** remains a viable warm-dark alternative if a dark-mode variant is ever wanted.
4. **Bow simplification** — keep the bow to two loops + knot (no tails) so it holds at small size; revisit if it muddies at true scale.
5. **Real recipient/destination logic, crash detection, etc.** are product concerns tracked elsewhere (this log is UI/UX look-and-feel only).

---

## Process note

The 5-variation craft and the icon evaluation were run as **multi-agent design workflows** (parallel specialist lenses → adversarial critique → synthesis), then hand-implemented so the un-renderable pixel craft stayed under single-author control. That's why the family coheres and the icon recommendation is backed by four independent design lenses rather than one opinion.
