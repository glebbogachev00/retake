# Using Retake from Claude Code, Codex, or any coding agent

Retake records product demos of web apps from a small YAML manifest. Its CLI
is deliberately agent-shaped: every command prints plain text, exits non-zero
on failure, and the cheap checks come before the expensive recording. An agent
can drive the whole loop — write, check, record, inspect, fix — without ever
opening the UI.

This file is also what Claude Code and Codex read when you point them at this
folder, so it doubles as the tool's own instructions to them.

## The loop an agent should run

```
write demos/<name>.yaml
  → npm run retake -- validate demos/<name>.yaml      schema + warnings (instant)
  → npm run retake -- dry demos/<name>.yaml           every selector & wait, no camera (~30–60s)
  → fix what dry reports, repeat until "all N steps resolved"
  → npm run retake -- run demos/<name>.yaml --preset preview-fast   first take (~2 min)
  → read outputs/<name>/proof-log.md                  what actually happened, per step
  → npm run retake -- check outputs/<name>             pass/fail on the result
  → adjust, then: npm run retake -- run demos/<name>.yaml          final quality
```

Rule of thumb: **never go straight to `run`.** `dry` catches most failures in
seconds; a failed `run` costs two minutes and a confusing video. When `dry`
fails it prints the step, the error, and the text that was on screen — read
that before changing anything.

## How to tell Claude Code / Codex to use it

From the Retake folder:

```
claude "Record a demo of http://localhost:3000 that shows a user creating
        their first project. Use Retake: draft demos/first-project.yaml,
        dry-run it until it passes, record a preview, then check it.
        Show me the proof log."
```

or with Codex:

```
codex "Using Retake (see AGENTS.md), make a 30-second demo of the sign-up
       flow at http://localhost:3000. Dry-run before recording."
```

Both CLIs read this file automatically when run in this directory, so the
loop above is already in their context. If the agent works from *another*
folder (your app's repo), add the Retake folder: `claude --add-dir ~/Documents/Retake`.

## Letting the agent draft with Retake's own scouting

The agent does not have to write the manifest from nothing:

```bash
npm run retake -- describe <name> <url> "<one sentence of what to show>" -P <path-to-app-source>
npm run retake -- ideas <url> -P <path-to-app-source>        # 5–7 demo ideas, saved to ideas/
```

`describe` scouts the live page for real, unique selectors, reads the app's
source for routes / sign-in fields / things that animate, and drafts the YAML.
`-P` is optional but makes drafts much better. The model is whichever is set in
`.env` (`RETAKE_MODEL=claude-code|codex|groq|mistral|local`) — so an agent can
use Retake's drafting, or draft itself; both are fine.

## What the agent must know about manifests

Full reference: `README.md` → "Demo-as-code". The short version:

- **Wait for results, not timers.** After any click that loads or computes
  something, `{ action: waitFor, selector: <thing that appears> }`. A fixed
  `wait` is for pacing only.
- **Selectors must be unique.** Playwright runs strict: a selector matching two
  elements fails. Prefer ids, `data-testid`, `aria-label`, then
  `button:has-text("…")`; append `>> nth=0` only when duplicates are intended.
- **Scenes carry the story.** `{ action: scene, label, caption }` at each beat;
  captions burn into the video; the camera eases toward the last thing touched
  (or `camera: { focus: <selector>, zoom: 1.3 }` / `camera: static`).
- **Logins go in `auth.setup`**, never in `steps` — they run before the camera
  and are trimmed off. Secrets are `${ENV_VARS}` with `secret: true`; never
  literal passwords in YAML.
- **Backend not available?** `stub:` answers API calls with canned JSON for the
  take, and a `stub` step swaps the answer mid-demo. Every stub is named in the
  proof log.
- **Long forms:** `{ action: scroll, to: <selector>, align: center }` before
  filling them, so the viewer sees the whole thing.

## Reading the results

- `outputs/<name>/proof-log.md` — per-step ✓/✗ with timings, the shot list,
  quality facts, and which endpoints were stubbed. This is the file to read
  when something looks wrong.
- `outputs/<name>/take.json` — the same, machine-readable.
- `outputs/<name>/demo.mp4` — the video. `master.mp4` is the CRF-14 keeper
  on post presets.
- `npm run retake -- check outputs/<name>` — resolution, fps, duration, files,
  pass/fail. Exit 3 on failure.

Exit codes: `run` → 0 all steps passed, 2 something failed (video still
produced, proof log says why). `dry` → 3 if any step would fail.

## Fixing a take without re-recording

Captions, camera zoom, hold length, trim, format and layout are **render-time**.
Change them in the YAML and `npm run retake -- render outputs/<name>` — seconds,
no browser. Only changes to what the browser *does* (steps, selectors, waits,
viewport) need `run` again; `run --reuse` skips the browser when nothing
recording-relevant changed, and the UI's one button works this out for you.

## Things that trip agents up

- The app must be running and reachable at the manifest's `url` before `dry`
  or `run`. Retake says "Nothing is running at …" if not.
- `describe` and `ideas` need a model configured (`.env` or the UI's Settings).
  `validate`, `dry`, `run`, `render`, `check` never use a model.
- Two runs on the same demo at once are refused (a lock); wait for the first.
- Deleted demos go to `.trash/`; `POST /api/demos/<name>/restore` or copy the
  file back.
- **Wait for durable state, not its announcement.** Toasts and banners clear
  themselves (and often share a class with other notices); a wait on one can
  time out while the thing it announced sits on the board. Wait for the row,
  the count, the heading — `.act >> nth=1` beats `.landed`.
- `dry` runs file/command seeds first so it sees the state `run` will
  (`--no-seed` to skip). `evaluate` seeds only run with a camera.
- A one-line `script:` with braces is a YAML mapping, not a string — write
  `script: |` and put the JS on the next line.
- Long demos (> 60 steps): the cursor stays visible instead of fading when
  idle — each fade is a nested `if()` in testreel's ffmpeg expression and the
  parser has a depth limit. `cursor: { idleHide: false }` forces it off at any
  length; `true` forces it on (and may fail past ~60 steps).
- Iterating on one beat of a long demo: `run demos/x.yaml --until <scene>`
  records up to the end of that scene and stops (MCP: `run` with `until`).
  Better still, keep demos short — above ~40 steps, split the story.
- If Retake itself fails (render/ffmpeg error, crash), stop and report it —
  do not patch around the tool.
