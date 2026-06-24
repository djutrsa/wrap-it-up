# Wrap It Up

**Save your place when your brain quits.**

You're deep in a coding session with an AI assistant. Then a meeting, the end of the day, or plain mental fatigue pulls you away — and the next time you sit down you're staring at a half-finished mess thinking *…what was I even doing?*

Wrap It Up fixes that. One click writes a short, trustworthy note of **where you were** — so you can walk away guilt-free and pick it right back up in about ten seconds.

> Auto-save and git keep your *files*. They don't keep the *story* — what you changed, what's working, what's broken, and what to do next. **Wrap It Up keeps the story.**

*Early and experimental. Runs on your machine. No tracking, ever.*

---

## What you get

Click **Wrap it up**, and you get a tidy little note with:

- **▶ Here's where to pick up** — your one next move, in plain language
- **A paste-ready prompt** you can hand straight back to your AI to keep going
- **What changed · what's working · what's broken** — based on what actually happened, not guesses
- a quick status and a draft commit message

Come back later, tap **Where was I?**, and it reopens your files and hands you the note. You're back in the flow before the coffee's poured.

## Where it lives

Mainly as a small **floating widget** on your desktop — always on top, never in the way, and it works no matter which AI tool you're coding in. One warm little pill:

- **Wrap it up** saves your place.
- **Where was I?** appears once you have something to come back to. Tap it and you're back — your paste-ready prompt is copied and your note reopens. Once you've returned, it tucks itself away, so the widget rests at a single calm button until your next wrap.
- **Drag** it anywhere by the grip on the left. **Right-click the widget — or its system-tray icon —** to switch which project it's watching, add a Claude API key, toggle start-at-login, choose whether picking a note back up reopens it in your editor, or quit.
- Once installed, it **starts with your computer** and waits quietly in the **system tray** — close the little widget and it just tucks away there, ready when you need it (it only quits when you tell it to).
- When you come back, it quietly asks whether the note actually got you back in. Your answer never leaves your machine — it just helps the notes get better over time.

Prefer to stay inside your IDE? There's also a lighter **button for VS Code / Cursor** — convenient if you never leave the editor, though it only sees what happens there. The widget does more (see below).

## Why you can trust it

It only tells you things it actually saw. When it isn't sure, it *says so* — an honest "not sure" beats a confident wrong guess that marches you down the wrong path. And it does **nothing** on your behalf: it never commits, pushes, or sends your work off somewhere. It just writes you a note.

## Private by default

- Everything stays **on your machine**.
- It scrubs obvious secrets — keys, tokens, passwords — before writing anything down (best-effort, not a guarantee).
- No analytics, no telemetry, nothing phoned home.
- The only thing that ever leaves your computer is one optional, consented request to an AI to polish the wording — and you can skip it and keep the plain version.

## How it works — and why

A few deliberate choices under the hood:

- **It watches as you go; it doesn't reconstruct at the last second.** A lightweight recorder logs what actually happens — edits, errors that appear and clear, command results — and grounds the note in that. The **desktop widget** is the fuller experience: **with your okay, it also reads your AI session's transcript — a local file on your machine, never a running app** — so the note knows what you were *trying* to do, whichever AI tool you used. The in-editor button is lighter — it reads only editor evidence, not your AI chat. Either way, the **truth** comes from what actually happened, so it can't claim something the work doesn't back up. No signal? It says "Unknown" instead of bluffing — an honest blank beats a confident wrong turn.
- **The button waits; it never guesses you're back.** Wrapping up sets a quiet marker, and "Where was I?" lights up beside it — there's no fragile "are they back yet?" detection to get wrong. The marker clears only when *you* act (pick it up, wrap again, or dismiss), never on a stray keystroke — because mis-guessing "was that a real edit?" is exactly how a safety net vanishes at the worst moment. ("Where was I?" also stays hidden until there's actually something to return to.)
- **The truth comes from artifacts, not vibes.** Status and "what works / what broke" are grounded in real captured signals — a passed or failed run, an error that appeared or cleared, a diff hunk — so the note can't claim something the work doesn't back up.

## Try it (from source)

```bash
npm install
npm run dev
```

`npm run dev` builds the engine, watches it for changes, and launches the **desktop widget** (the main surface). Right-click the widget — or its tray icon — to choose which project it watches (it also asks the first time you wrap). Your notes land in a local `.wrap-it-up/` folder.

Prefer the in-editor button? Open the folder in VS Code / Cursor and press **F5**, then click **Wrap it up**.

## Install it as a real app

Run it like any other desktop app — **auto-starting on login, living in your system tray, no terminal needed.**

**Windows — just download it:** grab the latest **installer `.exe`** (or the no-install **portable `.exe`**) from the [**Releases page**](https://github.com/djutrsa/wrap-it-up/releases/latest) and run it.

**Or build it yourself (any OS):**

```bash
npm run dist:win    # on Windows → dist/ : an installer .exe and a portable .exe
npm run dist:mac    # on macOS   → dist/ : a .dmg
```

Install it and it stays out of your way: it comes up quietly in the tray when you log in, and a single running copy is enough no matter how many times you launch it. No `claude` CLI? Right-click the tray → **Set Claude API key…** and the AI wraps work from your key alone (stored encrypted on your machine; the plain, no-AI wrap always works too).

These builds aren't code-signed yet, so your OS warns you once on first run:

- **Windows:** *"Windows protected your PC"* → **More info → Run anyway**.
- **macOS:** right-click the app → **Open → Open** (or *System Settings → Privacy & Security → Open Anyway*). If it's flagged as "damaged," clear the download flag once: `xattr -dr com.apple.quarantine "/Applications/Wrap It Up.app"`.

## License

MIT — see [LICENSE](LICENSE).
