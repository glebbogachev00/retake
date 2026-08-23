# Changelog

## 0.3.0 — 2026-08-23

Logins, done so that no model ever sees a password.

- **`secrets` MCP tool.** The agent asks for credentials *by name*
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
