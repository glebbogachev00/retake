# Changelog

## 0.4.0 — 2026-08-25

Sizes stop moving, failures explain themselves, and a cut can be reviewed.
Two field audits and a second recording session drove all of it.

**Sizes.** One preset now means one output size, always: the caption band
sits inside the canvas, so `post-landscape` is exactly 1920×1080 rather
than the four different shapes it was producing (a caption's line count
was changing the frame height, and manifests set their own viewports).
Better: the shape is now decided at RENDER — a take is fitted into
whichever canvas you ask for, so `render outputs/x --preset post-vertical`
turns a landscape recording into a true 9:16 in seconds. Nobody spends
tokens re-recording to change a size. `viewport` still works and
`validate` warns that it makes one demo a different shape from the rest.
No captions anywhere → no band; the app fills the frame.

Also: square pixels are forced. Playwright's webm carries SAR 1216:1215,
a half-percent stretch nobody had noticed.

**When something breaks, it says so.**
- A failed step writes a full-page `failed-step.png` — in `run` AND in
  `dry`, which is the cheap pass and was handing over less.
- A manifest whose `waitForSelector` never resolves now says *the app at
  this URL is not what this manifest expects*, with the page title, the
  text on screen and a picture — instead of a bare Playwright timeout that
  sends you hunting through steps that were fine.
- The app's own errors are recorded with timestamps, and `check` fails a
  video that ends on one. A take passed every check while ending on "This
  page couldn't load".
- `check` reads the timeline that shipped, so `compressIdle` no longer
  gets videos failed for a stall it already removed.

**Waits that do not lie.** `waitFor` gained `gone: true` (the element is
the previous action's banner, still on screen), `minChars` (a shell that
streams its text in) and `stableMs` (there, but still changing). Each cost
a real take before it existed.

**New step: `select`.** A form-heavy app is mostly dropdowns, and a demo of
one had to fake them with `evaluate`. Takes the option's value or its
visible label; `dry` proves the option exists rather than only the element.

**Reviewing.** `retake contact <dir>` writes one timestamped grid of the
whole video; launch cuts make it automatically. Per-scene stills cannot
show a caption going false inside its own scene, and carry no clock.

**Revising without destroying.** `render --out <dir>` and `run --name`,
so a published cut survives its own revision. Outputs keep a copy of the
manifest they were made from.

**Fixed:** a take that ended soon after its last scene produced no poster
and killed the render ("all steps ok, but no video"). The window's demo
list took 2.1s and is now 0.06s — it parsed every manifest twice per
request, on a call made on load, on every agent event and every 30s.

## 0.3.0 — 2026-08-23

Logins, done so that no model ever sees a password. And the launch cut:
title cards and callouts, rendered from HTML.

- **`intro:` / `outro:` title cards** in Retake's own look — Chromium renders
  them frame-by-frame from an HTML template (deterministic to the pixel),
  spliced onto the take at render time. The intro's settled frame is written
  as `cover.png` — the poster. Change a word, re-render in seconds.
- **`music:`** — a bed under the whole video, mixed at render: the person's
  own file (Retake bundles no tracks — licensing), looped or trimmed to
  fit, faded out at the end. The skill teaches the flow: plain cut by
  default; the launch treatment offered in one sentence when the
  destination is a launch or a post.
- **`compressIdle:`** — the app's dead waits (waitFor/navigate) shown as
  ~1.5s each: real start, then a fast-forward, every caption/camera/still
  clock remapped through the same warp. The author's pacing waits are never
  touched. Render-time.
- **`voiceover:`** — the captions read aloud (edge-tts, JennyNeural by
  default; `pipx install edge-tts` once). Each scene's line lands at the
  scene's start; music ducks 7dB under it; a line that overruns its scene
  is called out in the log with the fix.
- **`typing: brisk`** — fast keys, pauses carry the meaning.
- **`callout` steps**: an animated amber ring and label around an element,
  box recorded during the take, drawn at render in source coordinates so a
  moving camera carries it. The take holds while it plays.

- **The caption band fits the captions.** One line ≈ 100 px (was a fixed 150),
  two lines ≈ 160, one height per take; landscape videos are 1920×1180 for
  one-line captions. Square and vertical keep a fixed 120 px band and the
  page gets the rest (1080×960, 1080×1800). `captions: false` → no band.
  Render-time only: `retake render` re-cuts any existing take.
- **Camera is still by default.** `camera: auto` (ease toward the last thing
  touched) is something a person asks for after seeing a take.

- **`secrets` MCP tool.** Returns at once with the exact words and the link
  for the agent to relay — a first-timer is walked to the window, not left
  waiting on a silent tool. The agent asks for credentials *by name*
  (`APP_USER`, `APP_PASSWORD`, `APP_TOTP_SECRET`); a form appears in the Retake
  window, the person types the values, they are written to the workspace
  `.env` (mode 600) and the agent hears only "set". Without a window the tool
  returns the one sentence to relay. `ask` now refuses the job for passwords.
- **`retake secret NAME…`** — the same without a window: typed into the
  terminal, hidden, kept local.
- **`retake signin demos/x.yaml`** — for SMS codes, SSO, captchas: a real
  browser opens, the person logs in once, Retake keeps the session.
- **`${TOTP:APP_TOTP_SECRET}`** — authenticator codes computed at fill time
  (RFC 6238, verified against the reference vectors).
- A take with `auth.storageState`, no fresh session and no `auth.setup` now
  refuses to run instead of recording logged out.
- A blank `APP_USER=` counts as unset (it used to pass as an empty login);
  one `.env` parser everywhere, so a password with quotes or `#` survives.
- The method is written for agents in `skill/SKILL.md` and `AGENTS.md`, and
  for people in the README, the guide and the landing page.

## 0.2.2 — 2026-08-23

Two limits from the README's "Limits worth knowing" retired, with recorded
proof for each (`demos/cursor-hundred.yaml`, `demos/zoom-probe.yaml`).

- **Cursor cap lifted from ~45 to ~180 moves per take.** testreel builds its
  cursor overlay as nested `if()` expressions and ffmpeg's parser stops at 98
  levels; `scripts/patch-testreel.mjs` (run on install, testreel pinned to
  0.2.0) rewrites the four builders as flat sums of windowed segments —
  identical frame for frame (test covers 120k samples including overlapping
  transitions), depth 2 at 200 moves. A 100-click take now records with the
  cursor on every button and the idle fade intact. The remaining ceiling is
  the filter's size as one process argument (~630 bytes a move vs Linux's
  128 KB); `validate` warns at 180.
- Idle fade is no longer forced off above 60 steps — that was a workaround for
  the same cap.
- **The CSS-zoom focus bug is gone** and is now a regression demo: typing
  lands on the AvexJets forms at scale 1.8, 2 and 2.5. Earlier engine changes
  (zoom via a `<style>` tag, bring-into-view safe zone) had fixed it without
  anyone re-testing the claim.

## 0.2.1 — 2026-08-23

Found by testing the published package as a stranger would.

- **`post-square` and `post-vertical` now produce a true 1080×1080 and
  1080×1920.** The caption band used to be added below the canvas, so the
  square preset wrote 1080×1210 and every feed letterboxed it. The band now
  fits inside (page 1080×950 / 1080×1750). Takes recorded under the old
  geometry need re-recording, not re-rendering — the page area is baked in.

- **`gif: true` (and `--gif`) made no GIF on any preset except `docs-gif`** —
  it resolved to that preset's own `gif: false` and said nothing. It now
  falls back to 900px @ 15fps anywhere. Regression test added.
- `retake validate` prints the exact size of the video the manifest will
  produce, and `retake presets` shows video size next to page size. The video
  is the page plus the caption band, which the docs previously glossed over:
  `post-landscape` is 1920×1230, not 1920×1080.

## 0.2.0 — 2026-08-23

First public release on npm as `retake-demos`.

- `retake install` sets up a workspace, downloads Chromium, registers the MCP
  tools and skill with Claude Code, prints the Codex config. `retake init`
  and `retake doctor` are its halves.
- Built package (`dist/`) with a real `retake` binary; the package is separated
  from the workspace (`src/paths.ts`), so demos and outputs live wherever you
  ran `retake install`.
- `check` honours the preset a take was actually recorded with (a draft no
  longer fails for lacking a master).
- Hardware-encoded presets fall back to x264 off macOS.
- MIT license, CI, contributing guide, backlog.

Everything before this was the `canvas`, `chat` and `operator` branches:
the MCP server and its 22 tools, the `recording-product-demos` skill, the
review window, `draft`/`drag`/`tempo`/`lock`/`keepInTab`/`maxSeconds`,
stop-on-fail with screen text, the cursor-cap detection, stills per scene,
and the notes in `docs/`.
