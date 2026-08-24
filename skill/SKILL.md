---
name: recording-product-demos
description: Record a silent product demo video of a web app with Retake. Use when the user asks for a demo video, screen recording, or product walkthrough of an app — or asks what demos would be worth recording. Works through Retake's MCP tools (preferred) or its CLI.
---

# Recording product demos with Retake

Retake turns a small YAML manifest into a 1080p silent demo video (MP4 +
one still per scene + a proof log). The demo lives as code, so when the UI
changes you edit one line and re-run — nobody re-records by hand.

You drive it; the person watches at http://localhost:4310 if the Retake
window is open. Prefer the MCP tools (`retake` server). If they are not
available, the CLI equivalents are in the table at the end.

## If the person asks what Retake is or how to use it

Explain it from this file, briefly, in their language — do not send them to
docs. The short version: "Describe the demo in a sentence and I'll record it
as a real browser walkthrough — video plus a still per scene. You can direct
it like a videographer: no zooms, hide the cursor, shorter captions, square
for X. Say it once and I'll remember it for this project." Then offer the
first concrete step: suggest ideas from their app, or record the flow they
name.

## You have Retake's tools and nothing else

When you are driving Retake you usually have no shell, no file reader, no
grep. Do not reach for them — every call to a tool you do not have is a
wasted turn. `scout` and `read_project` are your eyes on the app; `receipts`
and `look` are your eyes on the take; `ask` only works when a Retake window
is open, and `start_app` needs the person's say-so. If you are truly stuck,
say so in one line and stop.

## The order that wins

1. **`read_project`** (if you have the source folder) — routes, start
   command, sign-in fields, stable selectors, things that animate forever.
2. **`scout <url>`** — what is really on the page: unique selectors, text.
   If the URL refuses, check `ports`; dev servers often sit one port over.
   Do not start the app yourself unless the person says to.
3. **What to record?** If the person asked for suggestions, call `ideas` —
   do not invent ideas blind. Show them the list in the chat, numbered, and
   **stop**: they pick, drop, or reword before anything is recorded. Only
   then `plan_set` their choices and `plan_mark` each item as you go; an
   unfinished plan survives into the next session (`plan` shows it).
4. **`draft`** the manifest from the person's sentence, then read it and fix
   the obvious with `edit`: wait for results instead of timers, unique
   selectors, logins under `auth.setup` with `${ENV}` placeholders and
   `secret: true`, `reducedMotion: true` if things animate forever, scrolls
   before anything below the fold.
5. **`dry`** — ALWAYS before `run`. Seconds, no camera, strict; failures
   include what was on screen. Fix and repeat until it passes. Never record
   a manifest whose dry run fails.
6. **While iterating, record at `--preset draft`** (CLI) — same layout as the
   final at a quarter of the pixels, so a take costs ~real time instead of
   real time plus an encoder. Switch to a post preset only for the take you
   intend to keep.
7. **`run` with `preview=true`**, then read the `receipts` AND `look` at
   the take. Receipts say what happened; `look` shows how it looks — one
   image per scene. Judge it like a viewer would: is the thing the caption
   names actually on screen? Anything in shot that shouldn't be (dev
   badges, leftover data, cut-off text)? Wrong story or failed step →
   `edit`, run again. More than four rounds → ask the person.
8. When it is right: `run` with `preview=false` once (full quality), then
   `done` with one sentence. Outputs: `demo.mp4`, `stills/` (one PNG per
   scene), `proof-log.md`.

## Style — how the person wants their videos to look

Do not ask about knobs before the first take — nobody has opinions about
zooms or caption tone until they have seen one. Two moves instead:

1. **One question, about the destination:** "Where is this going — a
   post, docs, or a client?" Post → `post-square` or `post-vertical`,
   short captions. Docs → landscape or `docs-gif`, plain captions. Client
   → landscape, still camera, a hold on the payoff. Skip the question if
   the project's style note already answers it.
2. **The first take is the menu.** Record the calm default as a preview,
   let them watch it, then one line — no list, no questions before it:
   "Want it different? A zoom on the result, cursor off, square for a post —
   say so and I'll re-render." Whatever they choose, save it with `style`
   so it never comes up again in this project. Never ask about zoom or
   cursor before they have seen a take.

**Which kind of take is this? Get it from the destination, never from the
subject.** Write it into the manifest as `mode:`, and default to `demo`.

- **`mode: demo`** — it proves how the thing works. A client walkthrough IS
  a demo. So is a PR review, a bug repro, a docs clip, a lesson, "show the
  team", "send it to the customer", "so they can see the flow". Nothing in
  the frame but the product doing the thing. No title card, no music, no
  callouts. Most takes are this.
- **`mode: launch`** — it presents the product to strangers, in public: a
  launch, a post, an ad, a landing page, Product Hunt, "for X", a trailer.
  Only then are a title card, music, emphasis and a branded ending on the
  table, and each still has to earn its second.

The tell is the audience, not the polish: *someone who already wants to
know how it works* → demo. *Someone who has to be given a reason to care*
→ launch. If the person has not said, ask the one destination question and
take `demo` if they shrug. **Never upgrade a demo to a launch on your own**
— `validate` warns when a demo carries launch furniture, and that warning
means you guessed.

A launch cut ends with THEIR product, never with Retake. Retake branding
belongs only in a video that presents Retake.

**Two kinds of take, one file — and the destination decides.** The default
is the plain cut: still camera, cursor, captions, nothing else. That is
correct for PRs, clients, docs, lessons — most takes. When the person's
answer to "where is this going?" is a launch, a post, or anything public
and promotional, offer the produced cut in ONE sentence: "Want the launch
treatment — title card, a callout on the payoff, the waits compressed,
the captions read aloud, square or vertical for the feed, and music if
you give me a track?" Never apply it unasked, and
never ask about its parts one by one.

The produced cut, when they say yes (all render-time except typing):
- `intro: { title, subtitle }` and usually `outro:` (the product name or URL)
- one `callout` on the payoff moment, not more
- the destination's shape: `post-square` or `post-vertical`
- `compressIdle: true` — the app's waits shown as ~1.5s each; the person's
  pacing `wait`s are never touched
- **voiceover: leave it off.** It needs `script:` (one continuous script,
  synthesized as one performance) AND `approved: true`, which only a person
  who has HEARD it can set. Reading the captions line by line resets prosody
  at every scene — that is a defect in the shape, not the voice. A silent cut
  beats an unapproved synthetic voice. Offer narration only if they ask for
  it, and let them listen before it ships.
- `typing: brisk` — fast keys, the pauses carry the meaning (re-record)
- `music: <file>` only if they hand you a file or point at one on disk.
  Retake bundles no tracks (licensing) — say: "give me an mp3 you have the
  rights to; CC0 tracks live at freepd.com or pixabay.com/music". Skip
  music without complaint if they shrug.

Anything they would tell a videographer maps to a knob, in plain English:

- "add a title card" / "give it a cover" → `intro: { title, subtitle }`
  (and `outro:`) — render-time, and it also writes two poster candidates:
  cover.png (the card) and cover-titled.png (a real frame with the title on
  it, which is what stops a scroll)
- "the thumbnail is wrong" → they pick the poster themselves in the window
  (any frame, any still, a cover, or their own image). Point them at it
  rather than re-rendering; `outputs.thumbnail: { scene }` only sets the
  starting guess.
- "point at it" / "highlight the button" → a `callout` step with a label —
  at most one per scene, and only where the caption alone is not enough

- "no zooms" / "keep the camera still" → `camera: static` on scenes
- "hide the cursor" → `cursor: false`
- "no captions" / "shorter captions" → captions off, or rewrite them
- "slower" / "hold the ending" → `pauseAfter`, scene `holdMs`, end waits
- "square" / "vertical" / "for X" → preset `post-square` / `post-vertical`

The default is calm and real: still camera (`camera: static` is the
manifest default — write `auto` only when asked), cursor shown, plain
captions.
The first time the person expresses taste, save it with the `style` tool
(or write `demos/style.md`) — every later draft in the project reads it, so
they never have to say it twice. Their stated taste always beats defaults.

## The person may never have seen Retake — walk them

Assume a first-timer: your agent installed Retake for them and they know
nothing about a window, a workspace or a `.env`. So, every time:

- **Say where to look, with the link.** At the start of a demo: "I'll record
  this with Retake. You can watch at http://localhost:4310 (run `retake ui`
  if it isn't open) — the video, stills and a step-by-step log land there."
  Never assume the window is open or that they know the address.
- **One thing at a time, in their words.** When you need them to act (type a
  demo account, log in by hand, start their app), say exactly what to do,
  where, and how you'll know it's done: "…press Save to .env, then tell me
  it's done." Then wait for them to say so. Do not go quiet — a tool that
  waits on them is your cue to speak, not to sit.
- **Close the loop.** When the take is done: the one-line result, where the
  file is, and the one thing they can change without a re-record (speed,
  captions, format). Offer, don't pile on.

## Logins — most real demos start behind one

You will never see a password, and you never need to. The whole method:

1. **Notice it early.** `read_project` reports sign-in fields; `scout` shows a
   password input; or the person says so. Do not draft a manifest that
   pretends the app is open.
2. **Call `secrets` with the NAMES** you will use — `APP_USER`, `APP_PASSWORD`,
   and `APP_TOTP_SECRET` if the site asks for an authenticator code — and one
   sentence of why. It returns immediately with the words to say: a form is
   open in the window at a link, or a one-line terminal command. **Relay
   those words in full, link included**, then stop and wait for "done". Call
   `secrets` again; it answers "set" and you carry on. The values went
   straight into the workspace `.env` — you never saw them.
3. **Write the sign-in under `auth.setup`**, referencing `${APP_USER}` and
   `${APP_PASSWORD}` with `secret: true`, and set `auth.storageState` to
   `.auth/<name>.json`. The login runs before the camera and is trimmed off;
   the session is saved and later takes skip the login entirely. A failed
   sign-in is never saved as a session, so a wrong password stops the take
   instead of recording a logged-out one.
4. **Authenticator codes:** `text: "${TOTP:APP_TOTP_SECRET}"` — Retake
   computes the six-digit code at the moment it fills the field.
5. **SMS codes, SSO, captchas, anything only a human can do:** do not try.
   Tell the person: "run `retake signin demos/<name>.yaml` and log in once by
   hand — Retake keeps the session." Then run as normal. The manifest still
   needs `auth.storageState`; `auth.setup` can be empty.
6. **Firebase-style apps** keep the session in IndexedDB, which a saved
   session cannot restore: put the login under plain `setup` instead, so it
   runs every take (still before the camera, still trimmed).

Never ask for a credential in chat. Never write a literal one into a
manifest. Never invent one. Tell the person to use a demo account — the
output is a video they may publish.

## When a take fails

The camera stops at the first failed step, so a failed take is short and
its receipts name the step, the error, and what was on screen. **Fix from
that text** — usually a selector or a missing wait — then `dry` and `run`
again. Do not `look` at a failed take; images cost, and the text already
says what went wrong. Never call `done` on a take with a failed step.
Four rounds without a passing take → stop and ask the person.

## Two footguns worth knowing

- **Wait for durable state, not its announcement.** Toasts and banners clear
  themselves; wait for the row, the count, the heading that persists.
- **A one-line `script:` with braces is YAML, not JS** — use a block
  (`script: |`). Retake's validation error now says so too.

## When Retake itself breaks — stop, don't patch

A failed *step* is yours to fix (selector, wait, state). A failed *tool* is
not: a render error, an ffmpeg message, a crash, a cap you did not set.
Do not work around it, do not read Retake's or testreel's source, do not
try variations hoping one sticks. Say in one line what failed and which
demo, and stop. The person files it (the Bug? button) and it gets fixed
once, for everyone — an agent patching the tool is the most expensive
outcome there is.

## Long demos: split, and record up to the beat you are fixing

Hard limit to know: ~180 cursor moves in one take (the cursor filter must
fit in one ffmpeg argument). `validate` warns, `check` fails if it happened.
Past that, split — or `cursor: false`.

A take is real time: a six-minute walkthrough costs six minutes per
attempt and nobody watches six minutes. Above ~40 steps, split the story
into several 30–60s demos — each fails fast and re-records in a minute.
While iterating on one beat, `run` with `until: <scene label>` records only
up to the end of that scene.

## Rules

- Real interactions read as real: type actual text, scroll to what you use,
  hold on the result. No zoom tricks unless asked.
- Secrets never go in a manifest and never into chat: the `secrets` tool
  gets them into `.env` by name; you reference `${NAME}` with `secret: true`.
- Never invent selectors — only what scout/read_project returned.
- If the backend is down, prefer a `stub:` block over giving up.
- Starting the person's app needs their explicit say-so, every time.

## CLI fallback

| MCP tool | CLI |
|---|---|
| draft | `retake describe <name> <url> "<story>" -P <folder>` |
| dry | `retake dry demos/<name>.yaml` |
| run | `retake run demos/<name>.yaml` (`--preset preview-fast` for previews, `--until <scene>`) |
| render | `retake render outputs/<name>` |
| receipts | read `outputs/<name>/proof-log.md` |
| ideas | `retake ideas <url> -P <folder>` |
