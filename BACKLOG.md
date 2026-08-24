# Backlog

What's next for Retake, in the open. Roughly in order.

## The launch formula, in phases

Retake serves one person on two days: the day a plain walkthrough is enough
(a PR, a client, a lesson), and the day it must be produced (a launch, a
post). Same file, escalated. Cards, callouts, true square/9:16, tempo and
covers exist (0.3.0); these phases finish the second day. Refused, still:
transitions, filters, stock intros — the video-editor line stays drawn.

- **L1 — Music.** `music:` in the manifest: a bundled handful of licensed
  instrumental loops (or the person's own file), mixed at render time,
  faded out on the last scene, pre-ducked for L3. Render-time only; the
  loudest "produced" signal for the least work. ~an afternoon.
- **L2 — Smart idle compression.** Read take.json for stretches where
  nothing moved on screen and speed only those; `tempo` stays as the blunt
  whole-video knob. Launch cuts live on pace. ~a day.
- **L3 — Voiceover from the captions.** `voiceover: { voice }` reads each
  scene's caption — the captions are already the script, timed to the
  frames they describe. edge-tts for the good free neural voices
  (en-US-JennyNeural), Piper/Kokoro as the local, offline fallback; audio
  placed at scene starts, music ducked under it, scene holds stretched
  when the line runs longer than the beat. ~two days incl. the timing.
- **L4 — Typing rhythm + the launch preset in the skill.** `typing: brisk`
  (fast keys, pauses on meaning) instead of per-step delay tuning; and the
  skill learns: when the person says "launch" or "post", reach for intro
  card + a callout on the payoff + square/vertical + music without asking
  knob by knob. ~half a day, mostly prose.

## Next

- **Mobile and device presets.** `device: "iPhone 14"` in the manifest, mapped
  to Playwright's device descriptors (viewport, scale factor, user agent,
  touch), plus a `retake devices` table. Vertical output already exists; what's
  missing is the page rendering as a phone would. About a day.
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
