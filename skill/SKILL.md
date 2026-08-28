---
name: recording-product-demos
description: Record a silent product demo video of a web app with Retake, prove a web app actually LOOKS right before saying it works, check that a flow ADDS UP, and find what breaks just off the happy path. Use when the user asks for a demo video, screen recording, or product walkthrough — or asks what demos would be worth recording — and ALSO whenever you have changed something a person will look at (a page, a screen, a flow) and are about to report that it works. Works through Retake's MCP tools (preferred) or its CLI.
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
8. **Before the expensive take, if it is expensive, show them the draft.**
   `run` prints an estimate before capture. If it said this is a long take
   (over ~2.5 minutes), do not go straight to full quality: `ask` them,
   naming the demo and pointing at the draft in the Retake window, and say
   what the full take will cost. Something like *"Draft is ready — 40s, 6
   scenes, in the window. Full quality is about 7 minutes of recording.
   Worth spending, or change something first?"*
   - **Their taste is the thing you cannot check.** Every mechanical
     problem is already caught by `dry` and the take's own checks. What a
     person sees that no checker will is whether the story lands, whether
     the payoff reads, whether it looks right for their product. Getting
     that verdict on a cheap draft is the whole point.
   - **Short take?** Skip the gate. Asking someone to approve a 30-second
     recording costs them more than just recording it.
   - **Nobody there to ask?** Never block and never guess. Leave the draft,
     `done` with what you have and what it would cost, and let them start
     the expensive one when they are back.
9. When they say go: `run` with `preview=false` once (full quality), then
   `done` with one sentence. Outputs: `demo.mp4`, `stills/` (one PNG per
   scene), `proof-log.md`.

### Leave the manifest where it lives

**Every demo you record must have its file in `demos/<name>.yaml` when you are
done.** The window lists demos and shows each one's recording — so a manifest
written to a temp path, or deleted after the take, makes the finished video
invisible. It has happened: a five-minute, seventeen-scene recording sat
rendered on disk and nowhere in the library, because the file it came from was
gone.

Never record from a manifest outside `demos/`. If you were experimenting, the
experiment still gets a name and stays. `retake heal` writes back what is
missing, but nobody should need it.

## Inspect the frame, not the change

**This is a method, and it is the one that fails silently.**

After you fix something, the natural thing is to open the frame and check
whether the fix landed — *is the doubled card gone?* That is confirmation, not
inspection, and it will miss anything you were not already looking for, every
time. It has: a frame was looked at directly, by someone paying attention, and
three labels with the card below sitting on top of them went straight past.

So read every frame as if you had never seen the app, BEFORE you check whether
your change worked. Ask what a stranger would notice, not what you hoped to
confirm. And do it on every frame, not the ones you think are interesting —
the ones you think are interesting are the ones you already have a theory
about.

**`sweep` is this, mechanised.** It puts a closed ten-item checklist to every
scene's frame — clipped text, overlap, contrast, cut off, misalignment,
doubled, unfinished, broken media, dev UI in shot, empty regions — one frame
at a time, never a sample.

Use it whenever you have changed something a person will look at. It costs
about a judge call per frame, roughly two minutes on a long demo.

Three things about reading what it says:

- **They are things to look at, not verdicts.** Open the frame it names and
  decide for yourself. Some findings are correct and unimportant; a duplicate
  under a grouping header that says "· 2" is the app working.
- **Show the person, do not silently resolve.** You are the one with an
  investment in the answer.
- **A clean sweep is a floor, not a ceiling.** A closed checklist cannot find
  what is not on it. It catches the ten things that go wrong in every app; it
  does not certify the frame.
- **One pass is not reliable, and this is measured.** On a frame with a real
  overlap on it, three consecutive sweeps missed it and a fourth found it. The
  judge is not deterministic. So a frame that has already been looked at is
  never asked about again — the answer is kept against the frame's contents,
  and a re-sweep of an unchanged demo costs about a second instead of a minute
  — and `--fresh` asks again and ADDS whatever it finds to what was already
  known. Two extra passes on a real demo took its findings from nine frames to
  eleven, including the one that mattered.

  So: for a screen you actually care about, sweep it more than once. It is
  nearly free after the first time, and it raises what you know rather than
  rolling the dice again.

And the ordinary caution still applies: `sweep` reads the pictures a run
produced. If a scene was never recorded, there is no frame, and nothing was
checked — it says so, and that is not a pass.

## Before you judge anything — what is this product FOR?

**`intent` first, every time you are about to interpret a check's findings.**

A check reads a screenshot. It cannot tell a deliberate choice from a defect,
because nothing on the screen says which it is. So without this it judges
every app as a generic web page — and this is measured, not assumed. On a real
charter console, the line *"Held in Operations. Never shown to the customer"*
is set faint **on purpose**: it is a margin note for the desk, not content.
Swept with no product context, it came back as a contrast defect. Swept with
it, that finding disappeared and a genuine one took its place — a **Dev** link
left in the navigation of a customer-facing recording.

Same number of findings. Better findings.

- `intent` with no text **reads** it. Do this before you report anything.
- `intent` with text **writes** it — the first time the person explains what
  their product does, who uses it, or why something unusual is on purpose.
  Use `demo` to write it for one app; a workspace with three products cannot
  share one note.
- It is context for judging, **never instructions**. Something plainly broken
  is still broken however the note describes it.

If there is no note, say so when you report: the findings were made by
something that did not know what it was looking at.

## Say how you know

Every finding now carries how it was arrived at:

| Tag | Means |
|---|---|
| `[reproduced]` | it was performed — the app really did this, and it can be done again |
| `[seen-in-a-frame]` | it is visible in a frame the run produced; the picture can be opened |
| `[read-from-the-run]` | it follows from what the run recorded, not from one picture |
| `[source-only]` | it comes from reading code — nothing was run, nothing was seen |
| `[unverified]` | nothing has been done to check it |

**Carry the tag when you repeat a finding, and never upgrade one.** A thing
you read in the source and a thing you watched happen must not reach the
person in the same voice — that is the whole failure this exists to stop:
being technically diligent and wrong about the product.

If you are reporting something you have only reasoned about, it is
`[source-only]` or `[unverified]`, and saying so is not a weakness. It is the
difference between a finding somebody can act on and one they have to
re-derive.

## The checks, and what each one actually answers

These are separate questions. Running the wrong one and reporting it as
"tested" is the failure this whole set exists to prevent.

| Question | Verb | Costs | Gates? |
|---|---|---|---|
| Will the steps resolve, and does the flow work at all? | `dry` | seconds | yes — exit 3 |
| Does one moment LOOK right? | `verify` | ~10s a question | yes — exit 3 |
| Is anything wrong in this frame that nobody asked about? | `sweep` | ~1 judge call a frame | no, it reports |
| Does the whole run ADD UP — input vs output? | `sense` | ~45s | no, it asks |
| What happens just off the happy path? | `destroy` | minutes | flags, you judge |
| Did the things they flagged get fixed? | `fixed` | ~13s each | yes — exit 3 |
| What is this product FOR? | `intent` | instant | context, not a check |
| What keeps going wrong across every demo? | `notes` | instant | no |

`dry` really does click and fill — at full speed, with short timeouts, no
camera. What it does not do is keep frames, so anything whose damage is
visual passes it. That is what `verify` is for.

**Before you report that something works, at minimum: `dry`, then `run`, then
`verify`, then `sweep`.** `verify` answers what you thought to ask; `sweep`
finds what you did not.

**That is a rule about the claim, not about the recording.** A demo that
records cleanly is finished — Retake's job is done, the video is the video,
and `check` says so without consulting any of these. The checks are for the
separate and larger claim that the APP is right, which nobody asked Retake to
make and which is worth much more when it is made honestly. A take with no
checks against it is not an unfinished demo. It is a finished demo nobody has
inspected.

**Whether you ran them is visible.** Each check writes a line into the demo's
own folder when it finishes, and the window shows it — `verify ✓ 32 of 34
answered yes · sweep — · sense — · fixed ✗`. A check against an older
recording is shown as answering an older recording. So "did you actually look
at it" is not a question anybody has to take your word for, and `retake notes`
lists every demo nobody has inspected — which is a fact about the looking, not a defect in the take.

Which means: say what the checks said. Do not summarise a run as fine when the
line will say `sweep —`. `sense` on anything with numbers or a summary in it. `destroy`
when you have changed something people depend on and want to know what you
did not think of.

## Arriving in a workspace you did not set up

Call **`notes`** first. It reads every take on disk back and says only what is
true of the files: a stub that never answered (that demo is showing live data
where it meant to show canned), the same selector failing across several demos
(the app moved — fix it once, not five times), a fragment sitting where a
finished cut should be, a dead lock holding a folder, demos nobody has ever
verified. It is silent when there is nothing, so it costs you one turn.

It also proposes the occasional line for AGENTS.md. Show those to the person
rather than writing them in yourself — a policy is theirs to set.

## Proving it looks right — before you say it works

**Read this whenever you have changed something a person will look at.** Not
only when someone asks for a video. If you are about to write "the page now
works" or "fixed — the button shows up", this section is the difference
between saying that and knowing it.

You cannot verify a screen by reading the code that draws it, and you cannot
verify it by checking that a selector exists. Every one of these shipped from
a green build, a passing test, and an agent that said it was fine:

- an animation frozen half-drawn — the element was there, at the right size
- an icon 404ing — the `<link>` tag was correct, the route shadowed it
- a card knocked out of its grid — the DOM was valid, the class was consumed
- a label in dark text on a dark pill — perfect contrast in the stylesheet

All four were DOM-correct and visually wrong. The only thing that catches
them is looking, and the only thing that makes looking reliable is a reader
who is not you.

### The procedure

1. **Write the flow as a manifest** — the same manifest you would write for a
   demo. Steps that reach the screen you changed.
2. **Put the question on the scene.** Each `scene` step takes `expect:` — one
   plain sentence, or a list of them, answerable yes or no from a single
   frame:

   ```yaml
   - action: scene
     label: board
     expect:
       - "every card sits inside its own rounded box, none overlapping"
       - "the Continue button's text is readable against its background"
   ```

   Write what a person would notice, not what the DOM contains. `expect` is a
   question about the picture. "the heading is fully visible and not cut off"
   is a good one. "`h1.title` exists" is not — that is what `dry` is for, and
   it would have passed on all four bugs above.
3. **`dry`**, then **`run`** (use `--preset draft` while iterating — the same
   layout at a quarter of the pixels).
4. **`verify`** — MCP tool `verify`, or `retake verify outputs/<name>`. It
   takes each scene's still, puts your question to a separate reader that can
   see it, and reports the verdict. Exit code 3 if anything failed.
5. **Report what verify said, not what you believe.** If it failed, the line
   names the still — open it with `look`, fix the real thing, run again.

### The rules that make it worth anything

- **A question nobody could answer is a FAILURE, never a pass.** No still, no
  reader available, an unparseable answer — all fail. A check that could not
  run did not run.
- **You do not judge your own work.** `verify` asks a separate reader holding
  only the question and the image, because the agent that built the thing has
  an investment in the answer. Do not substitute your own look for it.
- **Bounded questions only.** "does anything look broken" is not a question,
  it is a wish. Name the one thing.
- **Never report a run you did not finish.** A skipped scene is an incomplete
  run, not a pass.

### When it is not worth it

A change nobody looks at — types, a build script, a pure function — needs a
test, not a picture. Verify is for pixels. If you cannot write a sentence
about what should be visible, there is nothing here to verify.

## Does the run add up — `sense`

`verify` judges one frame. `sense` judges the whole run: everything the demo
typed, chose and clicked, against the frames that came out.

Nothing needs declaring. The inputs are already in the take — this is the half
of the recording nothing has ever read.

It found a real one on its first outing. An Avex quote entered two legs:

```
type "SGN" → #leg-from-0      type "SIN" → #leg-to-0
type "SIN" → #leg-from-1      type "SGN" → #leg-to-1
type "17400" → [data-op-field='price']
```

and showed a single unlabelled price of 17,400. Every step passed. Every frame
looked fine. `verify` would not have caught it, because no single frame is
wrong — the run is wrong.

Six lenses, and nothing else: **quantity** (n went in, does the result account
for n), **continuity** (does a value entered early still read the same later),
**state** (an action was taken — did the screen move), **units and labels**
(per-item or total, which currency, whose timezone), **order** (does anything
arrive before what it depends on), **dead ends**.

**It asks, it does not fail.** Whether a number adds up is judgement, and a
false FAIL on judgement is how a check gets switched off. What comes back is
questions. Put them to the person in their own words — do not act on them
alone, and do not report them as bugs you found.

On a long demo it samples the frames and says so. Do not read "12 frames" as
"the whole demo was checked".

## What you did not think of — `destroy`

Takes a demo you already have and writes a manifest for each way it could be
abused, then tries them. Nine shapes: **double-submit**, **reload-midway**,
**back-button**, **provider-down**, **provider-empty**, **empty-state**,
**long-input** (540 characters everywhere), **awkward-input** (quotes, tags,
emoji, right-to-left), **impatient** (every wait removed).

What comes back is **files** — ordinary manifests under
`outputs/.destroy/<demo>/`. So anything it finds arrives with the repro
attached, and a good one can be kept as a demo of its own.

Read the verdicts carefully, because they are not all the same kind:

- **✗ broke** — the flow came apart, or the app threw. A finding.
- **? worth a look** — something happened that only a person can call. A flow
  that stops when its provider is down might be a handled error screen or a
  dead end. Do not resolve these yourself; show them.
- **· held** — it took the abuse. Note that **a failed second press counts as
  held**: the button was gone after the first, which is the app refusing to do
  it twice. That is the app winning.

By default it resolves the candidates without keeping frames. `run: true`
performs them for real and keeps the pictures — then `verify` and `sense` can
judge those, which is the only way to catch damage that is visual.

**Three refusals you must not try to talk it out of.** It will not touch a
non-local URL. It will not run a demo that neither seeds its state nor stubs
what it reads. And it will not run against an app somebody else is recording
right now. Each names an environment variable that overrides it — that
override is the person's call to make, never yours. If it refuses, say what it
said and stop.

## When something really is wrong — `flag`, then `fixed`

`sense` and `sweep` raise things. Most are not defects: a question about a
number, a duplicate the app is grouping on purpose, spacing somebody chose.
**The person decides which ones are real. Never flag on your own judgement.**

When they confirm one, `flag` it. Give the sentence that has to be TRUE once
it is fixed, not a description of the bug:

- yes — "the quote shows one total covering both legs"
- no — "the price is wrong for two legs"

That turns a question into a check. It stops being judgement and becomes
something every later recording answers, and it survives a re-record — which
"the price thing" does not.

Then, after the demo is recorded again, `fixed`. It answers every flagged item
against the newest take and cuts the few seconds of video that show each one:

```
2 things you flagged here. 1 now passes.
  ✓ uc01-track — the passenger count reads 1
  ✗ uc01-ops — a total price in US dollars is shown on this screen
        No total price in US dollars is visible on the screen.
```

**Lead with what it says.** That is the answer the person is waiting for, and
it is not yours to summarise away. On a long demo it is the difference between
twenty seconds and re-watching the whole thing — so run it rather than telling
them the fix landed.

`unflag` stops watching one, by its id or by the sentence. Ask first: a flag is
their judgement, not yours.

Flagging writes nothing into their manifest. It is kept in a small list beside
it, so the file they wrote stays exactly as they wrote it.

## What a change costs — read this before re-recording anything

The one mistake that wastes real time is reaching for a new recording when a
re-render would do. Almost nothing needs the camera twice.

| You want to change | Do this | Cost |
|---|---|---|
| size, shape, format (landscape → square → vertical) | `render` with another preset | seconds |
| a caption's words, the speed, a zoom, cards, music | edit the manifest, `render` | seconds |
| **where** a caption or still sits in time | `nudge: <ms>` on the scene, then `render` | seconds |
| which frame is the poster | click a frame in the window, or `--scene` | seconds |
| the ending, or any part of a demo you already recorded | `run --from <scene>` — it tells you which scene | only what changed |
| one beat, iterating | `run --until <scene>` | the head only |
| **the whole demo, while it is still changing** | `run --brisk` | the steps without the pacing |
| the steps themselves — what the demo DOES | full `run` | the whole thing |

Only the last row needs the camera for the whole demo. If you are about to
re-record and your reason is not in that last row, you are paying for
something you already have.

**`--brisk` records everything without the holding still.** Every `pauseAfter`
skipped, every `wait` capped. All the steps run and all of them are in the
video; only the pacing is gone. On a real demo 317 of 509 seconds were pauses
— 62% of the recording — so this is three and a half minutes instead of eight
and a half.

Use it for every take while the demo is still changing, and record the real
one without it. The result is correct and unwatchable: the take is marked
`brisk` so `--reuse` can never hand it back as the finished thing, and so
nothing that judges a finished cut is fooled by it.

`nudge` and `--from` are the two most recently added and the two most often
missed. `nudge: -1500` moves a scene's marker 1.5s earlier in the finished
video — caption, still and thumbnail follow it. `--from <scene>` runs the
earlier steps at full speed off camera so the app reaches the right state,
then starts recording there; a seven-minute demo whose last third changed
costs ninety seconds instead of seven minutes.

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
is the plain cut: still camera, cursor, no burned-in captions, nothing
else. That is
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
- "no captions" / "shorter captions" → already off; rewrite the scene
  captions if the proof log reads badly
- "slower" / "hold the ending" → `pauseAfter`, scene `holdMs`, end waits
- "square" / "vertical" / "for X" → preset `post-square` / `post-vertical`,
  and this is a RE-RENDER of the take you already have, never a re-record:
  `retake render outputs/<name> --preset post-square`. Size is not recorded.
- **Never set `viewport`.** The preset owns the size — one preset, one
  output shape, every time. A manifest that sets its own viewport comes out
  a different shape from every other demo of the same app, and players
  letterbox it. `validate` warns.

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

## Hard-won rules from real sessions

- **Scout again after ANY server restart** — not just the first time. A dev
  server that restarts can come back serving a different build or mode on
  the same port, and the take fails 20 seconds in with a selector timeout
  that looks like your manifest's fault. Five takes were lost to this once.
  If the run aborts saying "the app at <url> is not what this manifest
  expects", believe it: look at not-the-app.png, fix the server, re-run.
- **A failed step leaves failed-step.png next to the take** — a full-page
  picture of the exact moment. Read it BEFORE re-running or editing
  anything; it turns a five-round guess loop into one round.
- **`waitFor` can match a STALE element.** After an action, the previous
  capture's Undo button (or any leftover) may still satisfy your selector,
  and the click lands on the wrong thing. Wait for something unique to the
  NEW state (a count, a heading, a row with the new text), never for a
  control that also existed before the action.
- **What `compressIdle` compresses:** the app's own delays (`waitFor`,
  `navigate`) and long typing. It NEVER touches your `wait` steps — those
  are your pacing. Do not re-render hoping a `wait` gets shorter; shorten
  the wait.
- **Streaming content:** `waitFor` on a container resolves when the shell
  exists, not when the text has streamed in. Wait on the signal the app
  itself uses — a button flipping from busy to ready
  (`button:has-text("Send")`), a count, a class change.

## Waits that do not lie

A bare `waitFor` resolves the instant the element exists. Three times that
is the wrong moment, and each has cost a take:

- the element is the **previous** action's success banner, still on screen →
  `{ action: waitFor, selector: ".landed", gone: true }`
- the element is an empty shell that **streams** its text in →
  `minChars: 40`
- the element is there but still **changing** → `stableMs: 500`

Prefer these to a flat `wait`. A timer that happens to work today is the
thing that breaks when the app gets slower.

## Rules the manifest enforces, so you do not have to remember them

`validate` and `dry` refuse these outright rather than letting a take discover
them:

- **Scene labels are unique.** `thumbnail`, `--until`, the stills and the proof
  log all address a scene by its label.
- **The action has to fit the element.** `type` on a `<select>`, `select` on a
  `<div>`, `upload` on something that is not a file input, `click` on a button
  that is disabled at that moment — `dry` names the fix.
- **A navigate that changes only the `#fragment` is flagged.** It does not
  reload the document, so an SPA keeps its state and a stub armed just before
  it never fires. Add a throwaway query param, or click the app's own link.
- **A stub that never answers a request fails `check`.** Armed but unmatched
  means that screen showed the app's real data.
- **Seeds may not leave anything running** — no `&`, `nohup`, `pm2`. Starting
  the app is `start_app`'s job, which the person authorises.

## Cheap iteration — a demo should not cost five takes

A take is real time (capture is ~2.3× the finished video) and the field
average is three to five takes per demo. Most of that is avoidable:

1. **Draft everything.** `--preset draft` has the same layout and timing at
   a quarter of the pixels. Judge the story there; switch to a post preset
   once, at the end.
2. **Record only what changed.** When you edit a demo you have already
   recorded, `run` diffs your manifest against the one the last take used and
   tells you the scene the change starts at. Pass that as `from` and the
   earlier steps still run — the app has to reach that state — but at full
   speed and off camera. On a 251-step demo with the last third edited that
   is about 103 seconds against 469. What comes back is a FRAGMENT for
   checking the fix, not the finished video: watch it, and when it is right,
   take one full recording for the deliverable. Iterating is where takes
   multiply, and this is the whole of that cost.

3. **On a long take, `--no-master`.** The archival CRF-14 copy is worth
   keeping for a video you are publishing and is pure waste for the nine
   renders before it. Measured on an 8-minute demo: 495s of encoding became
   147s. The deliverable is marginally BETTER without it — the master path
   encodes to CRF 14 and then re-encodes THAT to the delivery CRF, so what
   you hand over is a compression of a compression.

4. **`--until <scene>` for the head, `--from <scene>` for the tail.** These
   are the two halves of the same idea and `--from` is the one people miss:
   when the ending changed, everything before it still runs (the app has to
   reach that state) but at full speed and off camera. Re-recording a 60s
   demo to change its last 8 seconds is paying for 50 seconds you already
   have.
5. **Get a person's eyes on a cheap draft before buying an expensive take.**
   A draft costs a quarter of the pixels and answers the only question a
   checker cannot: is this the right video? Spending seven minutes of
   capture to find out the story was wrong is the most expensive mistake
   available in this tool.
6. **A caption in the wrong place is a nudge, not a take.** `nudge: -1500` on
   a scene moves its marker 1.5s earlier in the finished video; the caption,
   the still and the thumbnail all follow. Re-render and look — it is seconds.
7. **Never re-record for a size or a format.** `render outputs/<name>
   --preset post-vertical` re-frames the take you have. Captions, camera,
   speed, cards and posters are all render-time too.
8. **`dry` before every `run`** — including after the app restarts. It is
   ~10s and it catches the wrong-build-on-the-port failure that otherwise
   costs a take and a confusing video.
9. **Fix everything `dry` and the proof log report in ONE pass.** Reading
   the whole failure list before editing turns three rounds into one.


## Captions are off, and that is on purpose

`captions` defaults to FALSE. A caption under the app makes a viewer look
away from the thing they came to watch and read instead of see — which is
why they were turned off here after being tried.

Still write a caption on every scene. They name the beats in the proof log,
the shot list and the stills, which is how anybody reviews a take. They are
just not painted onto the video.

Turn them on (`captions: true`) only when the person asks, or when a viewer
genuinely cannot follow the demo without them — a flow whose meaning is not
visible on screen. Never add them because a video "usually" has them.

## Judging the cut

`check: pass` proves the file is sound, not that the demo is good. Before
`done`, look: `retake contact outputs/<name>` writes one timestamped grid
of the whole video (launch cuts get it automatically). Read it for the
things checks cannot see — a caption that is true when its scene starts and
false by the end, a payoff nobody can find, four seconds where nothing
changes. `look` at the payoff scene is the other half.

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
