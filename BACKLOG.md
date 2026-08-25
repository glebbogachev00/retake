# Backlog

What's next for Retake, in the open. Roughly in order.

## Speed: where the time actually goes

Measured over 35 takes (2026-08-25), not guessed:

| | share | median |
|---|---|---|
| capture (browser doing the demo) | **69%** | 37.7s |
| render (ffmpeg + cards + stills) | 31% | 16.3s |

Capture runs at **2.3× the length of the video it produces**. A median take
is ~54s end to end. But the real cost is not one take — the field audits
recorded **three to five takes per finished demo**, so a demo costs 3–5
minutes of wall clock and the tokens to drive it. Speed work should attack
the number of takes first and the seconds per take second.

**Done (2026-08-25):** cards render only their animated frames (33.8s →
18.2s), stills seek by keyframe in parallel (3s → 1.6s). Size changes are
re-renders, not re-records. `compressIdle` shortens the video without
shortening the recording.

### Fewer takes — where the minutes are

- **Render-time scene markers** (see above). The single biggest one: caption
  placement currently costs a whole take, and the audit spent three takes
  on one beat, all differing only in where a `scene` sat. Would turn those
  into 16s re-renders.
- **`--until <scene>` is under-used.** It exists and records up to one beat.
  An agent iterating on the payoff of a 60s demo is paying for the first 50s
  every time. The skill mentions it; it should be the default move when the
  fix is in the last scene.
- **Draft first, always.** `--preset draft` is a quarter of the pixels with
  the same layout: measured 22.4s capture / 1.2s render against 30.1s / 3.6s.
  Nothing about the story needs 1080p to judge.
- **`dry` before every `run`, including after a server restart.** One
  session lost five takes to a dev server serving a stale build. `dry` is
  ~10s and now names a wrong app outright.

### Seconds per take — what is left

- **Cards still cost ~18s** on a two-card cut: ~50 Playwright screenshots at
  1920×1230. Options, cheapest first: reuse one browser across both cards
  and the callouts (2–3 launches saved); shoot the entrance per-frame but do
  the exit as an ffmpeg `fade` (halves the shots); or render two PNGs and let
  ffmpeg do the whole thing (fastest, loses the rule-growth flourish).
- **Two encodes on post presets** — compose to a CRF-14 master, then derive
  the deliverable. Correct for archiving, but `--no-master` would give a
  ~40% faster path for anything not being kept.
- **Capture's 1.3× overhead** beyond the demo itself is browser launch, page
  load, seeds and teardown. A warm browser reused across takes in one agent
  session is the obvious idea and the fiddliest to do safely.

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

## Shipped

- **Render-time scene markers** (2026-08-25). `nudge: <ms>` on a scene moves
  its marker in the finished video — caption, still and thumbnail follow it,
  clamped so it can never cross a neighbouring scene. Measured on a two-scene
  take: 1.6s to move a caption, against re-recording the whole thing. It is
  excluded from the capture hash, so it can never trigger a re-record.
- **`waitFor: {selector, stableMs, minChars, gone}`** (2026-08-25).
- **`retake contact <dir>`** — the timestamped contact sheet (2026-08-25).

## Next

- **Two mechanical caption checks.** Dead scene (a scene's -end still
  near-identical to the previous one under a caption promising change) and
  caption-outlives-its-subject (a captioned scene spanning steps that
  remove what the caption names). Both are diffs over stills Retake
  already takes; both would have caught three of four audit failures.

- **Mobile and device presets.** `device: "iPhone 14"` in the manifest, mapped
  to Playwright's device descriptors (viewport, scale factor, user agent,
  touch), plus a `retake devices` table. Vertical output already exists; what's
  missing is the page rendering as a phone would. About a day.
## Later

- **Linux.** Hardware presets fall back to x264 off macOS; nothing else has
  been run there beyond CI's typecheck and tests. A real recording on Linux
  would say what else assumes a Mac (`open -R` for Show in Finder does).
  Parked deliberately: worth doing when someone asks for it, not before.

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
