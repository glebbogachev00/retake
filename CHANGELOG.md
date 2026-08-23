# Changelog

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
