<p align="center"><img src="assets/hero.png" width="720" alt="Retake — rerun the demo, don't re-record it"></p>

<p align="center">
  <b>Describe a product walkthrough once. Get a silent demo video.</b><br>
  Change the UI, change one line, run it again — nobody re-records anything by hand.
</p>

---

Retake drives a real browser through your app, records it at 1080p, and hands back an MP4 (plus a thumbnail, an optional GIF, and a proof log of exactly what happened). The demo lives as a small YAML file, so when a button moves you edit a selector instead of re-shooting a screen recording.

It does one job: **record the demo well, from what was asked.** What you do with the video afterwards is not its business.

<p align="center"><img src="assets/ui.png" width="900" alt="The Retake UI: demos on the left, the demo and its scenes in the middle, the last take on the right"></p>

## Quickstart

Already using Claude Code or Codex? See [`AGENTS.md`](AGENTS.md) — Retake's CLI is agent-shaped (`validate → dry → run → check`, non-zero exits), and that file is what those tools read when pointed at this folder.


```bash
npm install
npx playwright install chromium
npm run ui            # → http://localhost:4310
```

Point it at anything running locally, describe what to show, and press Record. Or drive it from the terminal:

```bash
npm run retake -- run demos/example.yaml            # record + render
npm run retake -- render outputs/example            # re-render only (no browser)
npm run retake -- check outputs/example             # resolution, fps, duration, files: pass/fail
npm run retake -- ideas http://localhost:3000 -P ~/my-app   # what's worth recording?
```

Outputs land in `outputs/<name>/`:

```
demo.mp4        the shareable, captions burned in
master.mp4      the CRF-14 keeper (post presets only)
demo.gif        optional, via gifski when installed
thumbnail.png   the frame at a chosen scene
proof-log.md    result, shot list, every step's timing and pass/fail
take.json       the raw timeline that render reads
```

Exit codes: `0` all steps passed and a video exists · `2` a step failed, the run aborted, or the video is a raw fallback (the proof log says **partial** and why).

## The loop

**Auto mode** is four dropdowns and one button. The button says what will actually happen — *Record*, *Re-record*, or *Render again* — because Retake hashes what the recording depends on and knows whether the browser has to run at all.

**Refine** lives under the video: per-scene captions, camera on/off/zoom, hold length, and trim off each end. All of it is render-time, so **Re-render** takes seconds and never touches the browser. Scrub with `space` `←` `→` `J/K/L`; press `[` and `]` to set trim points from the playhead.

**Manual mode** is the manifest itself, for when you want it.

## Demo-as-code

```yaml
name: example
title: "Example — the shape of a demo"
url: http://localhost:3000
preset: post-landscape           # 1080p @ 30fps
viewport: { width: 1440, height: 1080 }
scale: 1.8                       # page rendered at 1.8× so text stays crisp
reducedMotion: true
camera: auto                     # each scene eases toward the last thing touched

seed: []                         # put the app in a known state first
setup: []                        # runs before the camera; trimmed off the video

steps:
  - { action: scene, label: start, caption: "The problem, before anything happens.", camera: static }
  - { action: wait, ms: 1800 }
  - { action: click, selector: "button:has-text('Get started')", pauseAfter: 900 }
  - { action: type, selector: "input[name=title]", text: "A realistic thing a person would type", delay: 40 }
  - { action: click, selector: "button[type=submit]" }
  - { action: waitFor, selector: ".result", timeout: 30000 }
  - { action: scene, label: result, caption: "And the result, which is the whole point." }
  - { action: wait, ms: 2600 }

outputs:
  mp4: true
  gif: false                     # GIF is opt-in
  thumbnail: { scene: result }
```

The full file lives at [`demos/example.yaml`](demos/example.yaml).

**Steps** — `wait`, `click`, `type`, `fill`, `hover`, `scroll`, `keyboard`, `navigate`, `screenshot`, `waitFor`, `evaluate`, `upload`, `download`, `scene`. Each takes `pauseAfter`, `waitFor`, `timeout`, `secret`. `${VAR}` expands from the environment and fails loudly when unset.

**Scenes** are the spine. They get their timestamps from the actual run, so captions land on the frames they describe even when a model call took 3 seconds this time and 11 the last.

**Seeds** put the app in a known state: write a JSON file, run JS in the page (IndexedDB/localStorage), or run a shell command.

## Quality

Think in the publishing format, not the browser window.

| Preset | Canvas | Encoder | Use |
|---|---:|---|---|
| `preview-fast` | 1920×1080 @ 24fps | VideoToolbox (hardware) | same framing as final, ~10× faster render |
| `post-landscape` *(default)* | 1920×1080 @ 30fps | libx264 CRF 17 + CRF-14 master | the general-purpose demo |
| `post-square` | 1080×1080 @ 30fps | libx264 | feed-friendly |
| `post-vertical` | 1080×1920 @ 30fps | libx264 | shorts and reels |
| `docs-gif` | 1440×900 @ 24fps | libx264 | README/docs GIF, 900px |
| `master` | 1920×1080 @ 30fps | libx264 CRF 12 | archive |

**Page scale** is what makes it crisp: the page lays out as if the viewport were smaller and every glyph is drawn at 2×, so 1080p text is readable on a phone. Set `viewport` to the app's natural shape — a 620px column suits 1440×1080 — and the recording fills the frame with the caption band below it.

**Camera** eases toward whatever the demo just touched, at render time, clamped so it can never crop the thing it points at. Per scene: `camera: static`, or `camera: { focus: .result, zoom: 1.3 }`.

## Signing in

Logins belong in `setup`, which runs before the camera and is trimmed off the front:

```yaml
auth:
  storageState: .auth/myapp.json   # session saved here, reused until it goes stale
  maxAgeHours: 8
setup:
  - { action: fill, selector: "#user", text: "${APP_USER}" }
  - { action: fill, selector: "#password", text: "${APP_PASSWORD}", secret: true }
  - { action: click, selector: "button[type=submit]" }
```

- Secrets live in `.env`, never in the manifest. `secret: true` keeps values out of the terminal, the UI log and the proof log.
- `auth.storageState` saves the signed-in session, so later takes skip the login entirely.
- `retake validate` **warns** if a `secret` step sits in `steps` rather than `setup` — redaction hides text from logs, not from the video.
- Use a demo account. The output is a video you may publish.

## Files and several apps

`upload` attaches local files to a file input (hidden inputs included, no OS dialog). `download` catches a download into `outputs/<name>/downloads/`. `navigate` moves between apps mid-take — as long as the flow stays in one tab, it stays one continuous video.

Not supported: flows that open a **new tab or window** (Playwright records per page), and anything outside the browser.

## Describe mode

Give it a URL, a sentence, and optionally the app's source folder. Retake scouts the page for real, unique selectors, reads the project for routes / sign-in fields / things that animate forever, and a model drafts the manifest into the editor. **The AI never records** — it writes the YAML you read and run.

```bash
npm run retake -- describe onboarding http://localhost:3000 "Show a new user creating their first project" -P ~/my-app
```

Providers, in preference order — any one is enough, configured in `.env` (see `.env.example`) or the UI's Settings:

| | Needs | Notes |
|---|---|---|
| Claude Code | the `claude` CLI you're already signed into | no key; best drafts so far |
| Codex | the `codex` CLI you're already signed into | no key |
| Groq | `GROQ_API_KEY` | fast, rougher drafts |
| Mistral | `MISTRAL_API_KEY` | |
| Local | `RETAKE_LOCAL_URL` (Ollama, LM Studio) | fully offline |

## Speed

Quality first, determinism second, speed third — but the hooks are there:

- **Reuse** — if nothing that shapes the recording changed, the browser is skipped and only the render runs. Preset, layout and caption changes are render-only by definition.
- **Render cache** — an unchanged render is a 0-second no-op.
- **Preview** — hardware-encoded, ~5–10s.
- **Scene rerender** — `retake render outputs/x --scene result`.

A first take costs about a minute and a half (the demo has to actually be performed). Corrections cost seconds.

## How it's built

```
src/
  cli.ts        run · render · check · validate · describe · ideas · gif · presets · ui
  manifest.ts   zod schema, preset resolution, warnings
  presets.ts    canvas, page scale, fps, crf, layout, camera
  record.ts     Playwright + testreel → take.json (lock, auth, fallback)
  render.ts     ffmpeg: camera → layout → captions → master/demo, gifski, check
  describe.ts   scout the page, draft the manifest, suggest ideas
  digest.ts     read a project: routes, sign-in, selectors, risks
  ui/           a tiny http server + one page, no framework, no build
demos/          one yaml per demo (+ seeds/)
```

Recording and cursor rendering come from [testreel](https://github.com/greentfrapp/testreel) (MIT); GIFs from [gifski](https://github.com/ImageOptim/gifski) when installed. Retake adds what they lack for this job: waiting on selectors, seeding state, scenes with real timestamps, camera and captions at render time, quality presets, credentials, caching, and the receipts.

## Status

Works, in daily use, still moving. Next: a prompt-first path — describe the demo, get a first take, then fix it in plain English — with the draft dry-run-validated against the page before anything records.

**Known issue:** page `scale` uses CSS `zoom`, which shifts the coordinate space some in-page rect math relies on; on certain forms the focus click misses and typing goes nowhere. Workaround: `scale: 1`. The fix is to move to Playwright's `deviceScaleFactor` and scale the cursor overlay instead.
