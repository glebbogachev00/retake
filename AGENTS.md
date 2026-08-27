# Using Retake from Claude Code, Codex, or any coding agent

Retake records product demos of web apps from a small YAML manifest. Its CLI
is deliberately agent-shaped: every command prints plain text, exits non-zero
on failure, and the cheap checks come before the expensive recording. An agent
can drive the whole loop — write, check, record, inspect, fix — without ever
opening the UI.

This file is also what Claude Code and Codex read when you point them at this
folder, so it doubles as the tool's own instructions to them.

`retake` here is the installed command (`npm install -g retake-demos`). From a
clone of this repo the same commands run from source as `npm run retake -- …`.
The MCP route is better than the CLI when it exists: `retake install` registers
the tools and the skill with Claude Code, so the loop below becomes tool calls.

## What a change costs

Reaching for a new recording when a re-render would do is the one mistake
that wastes real time. Almost nothing needs the camera twice.

| You want to change | Do this | Cost |
|---|---|---|
| size, shape, format | `retake render <dir> --preset <other>` | seconds |
| caption words, speed, zoom, cards, music | edit the manifest, `retake render` | seconds |
| **where** a caption or still sits | `nudge: <ms>` on the scene, then render | seconds |
| the ENDING of a demo | `retake run … --from <scene>` | the tail only |
| one beat, while iterating | `retake run … --until <scene>` | the head only |
| what the demo actually DOES | full `retake run` | the whole thing |

`--from` runs the earlier steps at full speed and off camera so the app
reaches the right state, then starts recording there. A seven-minute demo
whose last third changed costs ninety seconds.

Housekeeping, since outputs grow: `retake takes <dir>` lists the kept
versions of a demo and `retake restore <dir> <id>` puts one back;
`retake tidy` reports reclaimable disk and removes nothing without
`--apply`. Neither ever touches a raw recording or a take.json — those are
the only things a re-render cannot rebuild.


## Starting from nothing (the person pasted the repo link)

```
npm install -g retake-demos
mkdir -p ~/retake-demos && cd ~/retake-demos && retake install   # workspace + tools + skill
retake ui                                                         # their window: http://localhost:4310
```

`retake install` registers the MCP tools with Claude Code (user scope) and
prints the Codex / Cursor config. Tools load at the start of a session, so
in the session that ran the install, use the CLI loop below and tell the
person to restart you afterwards. `retake doctor` says what, if anything,
is missing. Always tell the person the window's address — they may not know
it exists.

## The loop an agent should run

```
write demos/<name>.yaml
  → retake validate demos/<name>.yaml      schema + warnings (instant)
  → retake dry demos/<name>.yaml           every selector & wait, no camera (~30–60s)
  → fix what dry reports, repeat until "all N steps resolved"
  → retake run demos/<name>.yaml --preset preview-fast   first take (~2 min)
  → read outputs/<name>/proof-log.md                  what actually happened, per step
  → retake check outputs/<name>             pass/fail on the result
  → retake verify outputs/<name>            did it LOOK right — each scene's `expect`, judged
  → retake sweep outputs/<name>             every frame, as a whole — what nobody asked about
  → retake flag demos/<name>.yaml           this one is real: watch it from now on
  → retake fixed <name>                     did what was flagged get fixed, with the clip
  → retake sense outputs/<name>             does the run ADD UP — input vs output
  → retake destroy demos/<name>.yaml        what happens just off the happy path
  → retake notes                            what keeps going wrong across every demo
  → adjust, then: retake run demos/<name>.yaml          final quality
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
folder (your app's repo), add the workspace: `claude --add-dir <your retake workspace>`
— or skip all this with `retake install`, which gives the agent the tools directly.

## Letting the agent draft with Retake's own scouting

The agent does not have to write the manifest from nothing:

```bash
retake describe <name> <url> "<one sentence of what to show>" -P <path-to-app-source>
retake ideas <url> -P <path-to-app-source>        # 5–7 demo ideas, saved to ideas/
```

`describe` scouts the live page for real, unique selectors, reads the app's
source for routes / sign-in fields / things that animate, and drafts the YAML.
`-P` is optional but makes drafts much better. The model is whichever is set in
`.env` (`RETAKE_MODEL=claude-code|codex|groq|mistral|local`) — so an agent can
use Retake's drafting, or draft itself; both are fine.

## What the agent must know about manifests

Full reference: `README.md` → "Demo-as-code". The short version:

- **Wait for the RESULT, and know the three ways a bare selector lies.** It
  resolves the moment the element exists, which is wrong when (a) the element
  is the PREVIOUS action's banner still on screen — use
  `{ action: waitFor, selector: ".landed", gone: true }` and wait for it to
  leave; (b) the element is a shell that streams its text in — use
  `minChars: 40`; (c) the element is there but still changing — use
  `stableMs: 500`, which resolves when its subtree has been quiet that long.
  Each of these cost a real take before it existed.
- **Wait for results, not timers.** After any click that loads or computes
  something, `{ action: waitFor, selector: <thing that appears> }`. A fixed
  `wait` is for pacing only.
- **Selectors must be unique.** Playwright runs strict: a selector matching two
  elements fails. Prefer ids, `data-testid`, `aria-label`, then
  `button:has-text("…")`; append `>> nth=0` only when duplicates are intended.
- **`run --name <x>`** records into outputs/<x> without touching the
  original; **`render <dir> --out <newdir>`** re-renders a copy and leaves
  the published cut alone. Revising is never overwriting.
- **A failed step writes `failed-step.png`** (full page, the exact moment)
  and the failing URL into the log and take.json. Read the picture first.
- **`manifest.used.yaml`** sits in every output — the exact manifest this
  video came from, not whatever the file on disk says today.
- **Size is a render-time choice.** One preset = one output size, always
  (the caption band sits inside the canvas). Any take renders at any preset:
  `retake render outputs/<name> --preset post-vertical`. Never re-record to
  change a shape, and never set `viewport` — `validate` warns because it
  makes one demo a different shape from the rest.
- **`retake contact outputs/<name>`** — one timestamped grid of the whole
  video. This is how you review a cut without pulling frames by hand, and
  how you check a caption is still true in the middle of its own scene.
  Launch cuts write `contact.png` automatically.
- **The poster** is `thumbnail.png`. `outputs.thumbnail: { scene: <label> }` picks the scene; the person can override it in the window from any frame, a generated cover, or their own image (`POST /api/cover/<name>`). Launch mode also writes `cover.png` (the title card) and `cover-titled.png` (a real frame with the title on it) as candidates. Do not re-render to change a poster.
- **`mode:`** — `demo` (default) proves the interaction: nothing in the frame
  but the product. A CLIENT WALKTHROUGH IS A DEMO. `launch` presents the
  product in public (a launch, a post, an ad) and may carry a title card,
  music, emphasis and a branded ending — ending with THEIR product, never
  with Retake. Decide from the audience, not the subject; never upgrade a
  demo yourself (`validate` warns).
- **voiceover** needs a continuous `script:` and `approved: true` from a
  person who heard it. Off otherwise.
- **The launch cut**: `compressIdle: true` (waits shown short — render-time),
  `voiceover: true` (captions read aloud), `typing: brisk` (re-record). Offer
  as one package when the destination is a launch or post; default is plain.
- **`music: <file>`** mixes a bed under the video at render (looped, faded
  out). The person supplies the file — never invent a path, never bundle.
- **Cards and callouts:** `intro: { title, subtitle }` / `outro:` splice a
  title card (render-time; the intro frame becomes cover.png). A
  `{ action: callout, selector, label }` step rings an element on camera.
  At most one callout per scene; never callout what the caption already says.
- **Scenes carry the story.** `{ action: scene, label, caption }` at each beat;
  captions burn into the video. The camera is still by default; `camera: auto`
  eases toward the last thing touched, or per scene `camera: { focus:
  <selector>, zoom: 1.3 }`. Add zoom only when the person asks.
- **Logins go in `auth.setup`**, never in `steps` — see "Logins" below.
- **Backend not available?** `stub:` answers API calls with canned JSON for the
  take, and a `stub` step swaps the answer mid-demo. Every stub is named in the
  proof log.
- **Long forms:** `{ action: scroll, to: <selector>, align: center }` before
  filling them, so the viewer sees the whole thing.

## Logins

Most real demos start behind a sign-in. The agent never sees a password:

- **Ask by name, not for the value.** Over MCP, call `secrets` with the
  variable names (`APP_USER`, `APP_PASSWORD`, `APP_TOTP_SECRET` for an
  authenticator) and a one-line why. With the Retake window open, a form
  appears there and the values go straight into the workspace `.env` — the
  tool returns "set". Without a window, the tool returns the sentence to
  relay: the person runs `retake secret APP_USER APP_PASSWORD` (typed into
  their terminal, hidden, kept on their machine) and the agent calls
  `secrets` again. From the CLI only, say the same sentence yourself.
- **Put the sign-in under `auth.setup`** with `${APP_USER}` / `${APP_PASSWORD}`
  and `secret: true`, plus `auth.storageState: .auth/<name>.json`. It runs
  before the camera, is trimmed off, and the session is reused by later takes.
  A failed sign-in never saves a session.
- **Authenticator codes:** `${TOTP:APP_TOTP_SECRET}` is the current six-digit
  code, computed when the field is filled.
- **SMS, SSO, captcha:** a script cannot; a person can, once.
  `retake signin demos/<name>.yaml` opens a real window, they log in, press
  Enter, and the session is saved. Leave `auth.setup` empty; a take with no
  fresh session and no setup refuses to run rather than record logged out.
- **Firebase-style sessions** (IndexedDB) cannot be restored from a saved
  session: put the login under plain `setup` so it runs every take.
- **Demo accounts only.** The output is a video.

## Reading the results

- `outputs/<name>/proof-log.md` — per-step ✓/✗ with timings, the shot list,
  quality facts, and which endpoints were stubbed. This is the file to read
  when something looks wrong.
- `outputs/<name>/take.json` — the same, machine-readable.
- `outputs/<name>/demo.mp4` — the video. `master.mp4` is the CRF-14 keeper
  on post presets.
- `retake flag demos/<name>.yaml --scene <label> --expect "<sentence>"` — the
  person has confirmed something raised by `sense` or `sweep` is a real defect.
  Give the sentence that must be TRUE once it is fixed, not a description of
  the bug. It becomes a check every later recording answers, and it survives a
  re-record. Writes nothing into the manifest — the ledger sits beside it as
  `demos/<name>.flags.json`. **Never flag on your own judgement.**
- `retake fixed <name>` — answers every flagged item against the newest take
  and cuts the few seconds of video that show each one, so a long demo does not
  have to be re-watched to learn whether one thing changed. Exit 3 while
  anything flagged is still wrong. `retake unflag` stops watching one.
- `retake sweep outputs/<name>` — the one that finds what nobody thought to
  ask about. `verify` answers written-down questions, so it can only find what
  was already suspected. `sweep` inspects EVERY scene's frame, one at a time,
  never sampled, against a closed ten-item checklist: clipped text, overlap,
  contrast, cut off, misalignment, doubled, unfinished, broken media, dev UI in
  shot, empty regions. Advisory — it reports, it does not gate. Roughly one
  judge call per frame, so about two minutes on a seventeen-scene demo.
- `retake sense outputs/<name>` — the verdict on the RUN, not on one frame.
  Everything the demo typed, chose and clicked, put against the frames that
  came out, through six lenses: quantity, continuity, state, units and labels,
  order, dead ends. Needs nothing declared — the inputs are already in the
  take. It ASKS rather than fails (exit stays 0), because whether a number adds
  up is judgement. Found a real one first time out: two flight legs entered,
  one unlabelled price shown.
- `retake destroy demos/<name>.yaml` — the flows nobody wrote down. Derives a
  manifest for each of nine abuses (double-submit, reload-midway, back-button,
  provider-down, provider-empty, empty-state, long-input, awkward-input,
  impatient), writes them under `outputs/.destroy/<name>/`, and tries them.
  `--run` performs them for real and keeps the frames. Three verdicts, not
  two: **broke**, **worth a look** (only a person can call it), **held** — and
  a failed second press counts as held, because the button being gone is the
  app defending itself. Refuses a non-local URL, a demo that neither seeds nor
  stubs, and an app somebody else is recording. Each refusal names its own
  override; using one is the person's call.
- `retake heal` — writes back the demo files for recordings whose manifest went
  missing. The window lists demos, not recordings, so a manifest deleted or
  written outside `demos/` makes a finished video invisible. Every output folder
  keeps `manifest.used.yaml`; this restores from that. Shows what it would do
  unless you pass `--apply`. **Never record from a manifest that does not live
  in `demos/` — this verb exists to clean up after that mistake, not to license
  it.**
- `retake notes` — the watcher. Reads every take in `outputs/` back and says
  the few things a person would say after looking through them: a stub that
  answered nothing (the demo is showing live data), the same selector failing
  in several demos (the app moved, not the demos), a fragment left where a
  finished cut should be, a dead lock holding a folder, demos nobody has ever
  verified. Silent when there is nothing. Run it when you arrive in a
  workspace you did not set up.
- `retake verify outputs/<name>` — the verdict on the PICTURE. Every scene
  with an `expect:` has its plain-language question put to a separate reader
  that can see the still. Exit 3 on failure; an unanswerable question counts
  as a failure, never a pass. This is the one check that catches DOM-correct,
  visually-wrong: a frozen animation, a 404ing icon, a card out of its grid,
  dark text on a dark pill. Use it before reporting that a screen works.
- `retake check outputs/<name>` — resolution, fps, duration, files,
  pass/fail. Exit 3 on failure.

Exit codes: `run` → 0 all steps passed, 2 something failed (video still
produced, proof log says why). `dry` → 3 if any step would fail.

## Fixing a take without re-recording

Captions, camera zoom, hold length, trim, format and layout are **render-time**.
Change them in the YAML and `retake render outputs/<name>` — seconds,
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
- Iterating on one beat of a long demo: `run demos/x.yaml --until <scene>`
  records up to the end of that scene and stops (MCP: `run` with `until`).
  Better still, keep demos short — above ~40 steps, split the story.
- If Retake itself fails (render/ffmpeg error, crash), stop and report it —
  do not patch around the tool.
- **Cursor cap: ~180 moves per take.** (Was ~45; Retake now flattens testreel's
  cursor expressions at install.) `validate` warns past it, the recorder
  detects a failed overlay and `check` FAILs. Split long stories anyway —
  above ~40 steps nobody is watching.
- Stills: `NN-label.png` is mid-scene, `NN-label-end.png` the last moment.
- Scroll pacing defaults to constant pixels-per-second; `speed:` overrides.
- **New tabs are folded back into the recorded page** (`keepInTab`, default
  true): `window.open` navigates in place and `target="_blank"` is stripped.
  Retake records one page, so a popup login or a "preview" button used to lose
  the demo's subject entirely. Set `keepInTab: false` if a flow genuinely needs
  a separate window — and know it will not be on camera.
- **Iterate at `--preset draft`.** Same 960px layout as the post presets (so
  selectors, wrapping and timing match) at a quarter of the pixels. Measured on
  a 22s demo: capture 22.4s vs 30.1s, render 1.2s vs 3.6s — the 1080p encoder
  adds ~8s to every take and competes with the app being recorded. Ladder:
  `draft` while fixing, `preview-fast` to check final framing, a post preset to
  ship. Never ship a draft.

## Every release gets a note a non-developer can read

`site/releases.json` is the one list of what shipped. The landing page and the
Retake window both read it — there is no second copy to update.

When a release changes anything a person can see, add an entry: a version, a
date, a headline, and a few lines. Write them for the person using Retake, not
for whoever wrote the code. Name no files. Name no flag they will not type. Do
not write "refactor", "regression", "schema" or "pipeline". If a line only
makes sense to someone who has read the source, it is not a release note —
it belongs in the commit message, which is where that audience already is.

Good: "You choose the cover image. Click any frame to make it the one people
see first." Bad: "Poster selection is now persisted via a marker file."

## The landing page is public — look at it before you commit

`site/index.html` is the page strangers see. It has been shipped broken
twice by checking that a string was present rather than that the page was
right: an unbalanced `<div>` dropped a card out of its grid, and a
catch-all route quietly swallowed the favicon. Neither showed up in a grep;
both were obvious in a screenshot.

There is a demo for it. Before committing any change to the page:

```bash
retake run demos/landing-review.yaml --no-master
```

No `--preset`: the manifest pins 1440 so this checks the DESKTOP layout,
and a preset override would drop it to 960 — below the breakpoint — so the
review would check a layout nobody sees on a laptop.

Then LOOK at `outputs/landing-review/stills/` — one still per section, named
after the section. Thirty seconds, and it is the only check that catches
layout.

Grep proves a string exists. It proves nothing about whether the page works.
