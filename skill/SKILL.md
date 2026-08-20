---
name: recording-product-demos
description: Record a silent product demo video of a web app with Retake. Use when the user asks for a demo video, screen recording, or product walkthrough of an app — or asks what demos would be worth recording. Works through Retake's MCP tools (preferred) or its CLI.
---

# Recording product demos with Retake

Retake turns a small YAML manifest into a 1080p silent demo video (MP4 +
one still per scene + a proof log). The demo lives as code, so when the UI
changes you edit one line and re-run — nobody re-records by hand.

You drive it; the person watches at http://localhost:4310 if the Retake
window is open. Prefer the MCP tools (`retake` server). If they are not
available, the CLI equivalents are in the table at the end.

## If the person asks what Retake is or how to use it

Explain it from this file, briefly, in their language — do not send them to
docs. The short version: "Describe the demo in a sentence and I'll record it
as a real browser walkthrough — video plus a still per scene. You can direct
it like a videographer: no zooms, hide the cursor, shorter captions, square
for X. Say it once and I'll remember it for this project." Then offer the
first concrete step: suggest ideas from their app, or record the flow they
name.

## The order that wins

1. **`read_project`** (if you have the source folder) — routes, start
   command, sign-in fields, stable selectors, things that animate forever.
2. **`scout <url>`** — what is really on the page: unique selectors, text.
   If the URL refuses, check `ports`; dev servers often sit one port over.
   Do not start the app yourself unless the person says to.
3. **What to record?** If the person asked for suggestions, call `ideas` —
   do not invent ideas blind. For a batch, `plan_set` the list first and
   `plan_mark` each item as you go; an unfinished plan survives into the
   next session (`plan` shows it).
4. **`draft`** the manifest from the person's sentence, then read it and fix
   the obvious with `edit`: wait for results instead of timers, unique
   selectors, logins under `auth.setup` with `${ENV}` placeholders and
   `secret: true`, `reducedMotion: true` if things animate forever, scrolls
   before anything below the fold.
5. **`dry`** — ALWAYS before `run`. Seconds, no camera, strict; failures
   include what was on screen. Fix and repeat until it passes. Never record
   a manifest whose dry run fails.
6. **`run` with `preview=true`**, then read the `receipts`. Wrong story or
   failed step → `edit`, run again. More than four rounds → ask the person.
7. When it is right: `run` with `preview=false` once (full quality), then
   `done` with one sentence. Outputs: `demo.mp4`, `stills/` (one PNG per
   scene), `proof-log.md`.

## Style — how the person wants their videos to look

Anything they would tell a videographer maps to a knob, in plain English:

- "no zooms" / "keep the camera still" → `camera: static` on scenes
- "hide the cursor" → `cursor: false`
- "no captions" / "shorter captions" → captions off, or rewrite them
- "slower" / "hold the ending" → `pauseAfter`, scene `holdMs`, end waits
- "square" / "vertical" / "for X" → preset `post-square` / `post-vertical`

The default is already calm: still camera, cursor shown, plain captions.
The first time the person expresses taste, save it with the `style` tool
(or write `demos/style.md`) — every later draft in the project reads it, so
they never have to say it twice. Their stated taste always beats defaults.

## Rules

- Real interactions read as real: type actual text, scroll to what you use,
  hold on the result. No zoom tricks unless asked.
- Secrets never go in a manifest. `${ENV_VAR}` + `secret: true`, and tell
  the person which variable to set.
- Never invent selectors — only what scout/read_project returned.
- If the backend is down, prefer a `stub:` block over giving up.
- Starting the person's app needs their explicit say-so, every time.

## CLI fallback

| MCP tool | CLI |
|---|---|
| draft | `retake describe <name> <url> "<story>" -P <folder>` |
| dry | `retake dry demos/<name>.yaml` |
| run | `retake run demos/<name>.yaml` (`--preset preview-fast` for previews) |
| render | `retake render outputs/<name>` |
| receipts | read `outputs/<name>/proof-log.md` |
| ideas | `retake ideas <url> -P <folder>` |
