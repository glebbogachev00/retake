# Backlog

What's next for Retake, in the open. Roughly in order.

## Next

- **Mobile and device presets.** `device: "iPhone 14"` in the manifest, mapped
  to Playwright's device descriptors (viewport, scale factor, user agent,
  touch), plus a `retake devices` table. Vertical output already exists; what's
  missing is the page rendering as a phone would. About a day.
- **Smart idle compression.** Read `take.json`, find the stretches where
  nothing moved on screen, and speed them up at render time. Today `tempo` is
  one rate for the whole video.
- **Linux.** Hardware presets now fall back to x264 off macOS; nothing else has
  been run there beyond CI's typecheck and tests. A real recording on Linux
  would tell us what else assumes a Mac (`open -R` for Show in Finder does).

## Later

- **Multi-tab recording.** Retake records one page; `keepInTab` folds most
  popups back into it. OAuth flows and apps that need a second window to keep
  existing are still off camera.
- **Upstream the flat cursor expressions.** `scripts/patch-testreel.mjs`
  rewrites four of testreel 0.2.0's expression builders at install time; a PR
  to testreel would retire the patch (and the exact version pin).
- **Per-project workspaces.** Today one workspace holds demos for every app
  (they group by URL in the window). A `.retake/` folder inside an app's repo
  is the obvious shape once someone actually wants it.
- **Cut the hosted model providers.** `describe` and `ideas` still accept
  Groq/Mistral keys from the pre-agent era. With an agent driving, Retake
  needs no model of its own; the CLIs you're signed into (`claude`, `codex`)
  and a local OpenAI-compatible URL cover the manual path.

## Not doing

- A chat inside the window. The agent you already use is the chat.
- Generic drag-and-drop heuristics or a "canvas mode". `drag` with explicit
  points is enough, proven on Scratch and GDevelop.
- Cloud rendering, accounts, sharing links. It's a local tool that writes files.
