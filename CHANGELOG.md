# Changelog

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
