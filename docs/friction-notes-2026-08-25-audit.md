# Retake — friction notes from the launch-video audit

2026-08-25. Written while auditing eight existing outputs and producing five
revised ones (four re-records against a live Capture, one re-render). Everything
here cost real time or a wasted take.

Companion to `docs/friction-notes.md`, written during the original recording
session. Two items from that list are still open and cost me time again today:
**#1 (`dry` does not run seeds — and that makes it lie)** and **#5 (waiting on
transient UI is a footgun the docs could warn about)**. They reappear below as
§3 and §7 with fresh evidence, because the new evidence is worse than the old.

Ordered by how much each would save.

---

## 1. Scene markers are record-time, so a caption-placement mistake costs a full take

**Cost: two wasted takes on `distill-messy-launch`, about 11 minutes of wall
clock, plus two model bills.**

The `talk` beat in `distill-messy-launch` took three takes to get right, and all
three differed by *where one `scene` step sat relative to a `wait`*. Nothing about
the browser interaction changed between them. Take 1 captioned the beat two
seconds after the paragraph was already readable. Take 2 captioned an empty reply
bubble. Take 3 was right.

Each iteration cost ~195s of recording (a live model, twice) plus 90–160s of
render, because a scene marker is written into the recording. Had scene boundaries
lived in `take.json` as editable timestamps and been applied at render, all three
iterations would have been ~90-second re-renders of one recording, and I would
have tried five placements instead of stopping at three.

**Ask:** make scene markers render-time. `take.json` already stores a timeline with
timestamps; a scene could be `{label, caption, atMs}` in that timeline, seeded by
the recorded markers but editable, with `render` reading them. This is the single
highest-value change on this list. It converts "caption placement" from a recording
decision into an editing decision, which is what it actually is.

Interim ask if that is too large: let `render` accept scene *time offsets* from the
manifest — e.g. `scene: {label: talk, nudge: -2000}` — so a marker can be moved
without re-recording.

## 2. `render <dir>` writes in place, and there is no `--out`

**Cost: a fiddly manual workaround on every revision, and one near-miss.**

The brief for this audit was explicit: do not overwrite existing outputs. Retake
gives no way to honour that. `render <dir>` writes back into `<dir>`, and `run`
derives its output directory from the manifest's `name:`. So producing a revised
cut without destroying the original meant, for each one:

```
cp -R outputs/scratch-mini-project outputs/scratch-mini-project-launch
# then hand-edit the absolute `video:` path inside the copied take.json,
# because it still pointed at the original directory
sed 's/^name: .../name: ...-launch/' demos/x.yaml > demos/x-launch.yaml
node dist/cli.js render outputs/x-launch demos/x-launch.yaml --force
```

Editing an absolute path inside a JSON artifact by hand is not something a tool
should require. And "revise a cut, keep the old one" is not an exotic workflow —
it is what you do every time a video is already published somewhere.

**Ask:** `render <dir> --out <newdir>` and `run <manifest> --name <override>`.
Also: make `take.json`'s `video` path relative to its own directory so a copied
output directory is self-contained.

## 3. `dry` passed, then `run` aborted on the manifest's own `waitForSelector`

**Cost: ~20 minutes, compounded by §4.**

```
$ retake dry demos/mark-done-launch.yaml
dry run: all 7 steps resolved

$ retake run demos/mark-done-launch.yaml
✗ run aborted: page.waitForSelector: Timeout 20000ms exceeded.
```

Whatever `dry` checks, it is not the same app-ready gate that `run` blocks on. A
green `dry` immediately followed by a `waitForSelector` abort is the worst possible
signal, because it points the investigation at the steps — which `dry` just
cleared — instead of at the environment.

This is `docs/friction-notes.md` §1 wearing a different hat: `dry` and `run` do not
see the same world. Today it was worse than a false selector failure, because `dry`
*passing* actively misled me.

**Ask:** `dry` should evaluate the manifest-level `waitForSelector` under the same
timeout as `run`, and should say out loud when it is running against app state it
did not create.

## 4. `capture-dev.sh` trusts the port, so a wrong-mode server records a wrong video silently

**Cost: the other half of that 20 minutes, and one junk take.**

```
port 3100 already in use — assuming the demo server is up
```

The listener on 3100 was a leftover dev server started with
`NEXT_PUBLIC_PLAYGROUND=1` and no `SYNC_DATA_DIR`. In playground mode Capture
refuses `/api/sync` outright (`{"error":"not available in the playground"}`), so
every seed silently no-ops, `/` serves the marketing landing page instead of the
board, and a "playground" notice sits at the top of the frame. The script declared
this fine and Retake rolled camera on it.

The failure then surfaced 20 seconds into the take as a `waitForSelector` timeout —
a message that points at the selector, and says nothing about the server being the
wrong application.

It got worse: after killing that server and starting a clean one, the clean one was
*still* in playground mode, because `capture-dev.sh` pins `NEXT_DIST_DIR=.next-retake`
and the previous playground process had left its compiled build there. Fixing it
meant `rm -rf .next-retake`. That build directory is shared state between whatever
last used it, and nothing checks it.

**Ask, Retake side:** before rolling, fetch the manifest's `url` and assert it looks
like the app the manifest expects — at minimum, that `waitForSelector` resolves —
and fail with "the server at :3100 is not serving what this manifest expects"
rather than a bare Playwright timeout. `retake doctor` could take a `--url` too.

**Ask, script side:** `capture-dev.sh` should probe `/api/sync` rather than the
port, and refuse a listener that answers wrong.

## 5. `check` fails a good video on a stall that `compressIdle` already removed

**Cost: no time, but it is actively corrosive.**

`distill-messy-launch` renders with, in the same run's output:

```
idle: type "ok so the contract thing with Maya — I promis…: 11.6s shown as 2.4s
...
check: FAIL
  FAIL  1 step stalled over 8s — the take holds a still frame there.
        Worst: 11.6s at 0:05 — type "ok so the contract thing with Maya…"
```

The render log says the 11.6s is shown as 2.4s. The check then fails the video for
containing an 11.6s stall it does not contain. `check` is reading raw take timings
and reporting them as properties of the rendered file.

A check that fails good output is worse than no check, because it teaches you to
skim past `check: FAIL` — and the next FAIL will be real.

**Ask:** run the stall check against the warped timeline when `compressIdle` is on.
The warp segments are already computed (`pace.ts:planIdle`).

## 6. `check` passes every video whose captions are false

**Cost: this whole audit.**

All four videos I re-recorded passed every check they had. `shelf-life` passed 15/15
while its closing caption asserted a due date that was not on screen. `search-thought`
passed while its final four seconds captioned an event that never occurred. `capture-hero`
passed with three of seven captions describing frames other than their own.

This is the point `VIDEO-CRITIQUE-FIX-BRIEF.md` already makes ("those checks proved
file integrity, not demo quality"), so I am not restating it as news. I am adding
that two cheap, mechanical checks would have caught three of today's four failures
without anyone judging anything:

- **Dead scene.** Warn when a scene's `-end` still is near-identical to the previous
  scene's `-end`. `search-thought`'s final scene — four seconds of unchanged screen
  under a caption promising a thread had opened — is exactly this shape.
- **Caption outliving its subject.** Warn when a captioned scene spans steps that
  change the page substantially (a click that removes the caption's own subject, or
  more than N mutations). `scratch-mini-project`'s "An empty project, and a plan."
  held while four blocks were dragged in under it; `mark-done`'s payoff caption sat
  under a green bar asserting the opposite.

Neither requires a model. Both are diffs over stills Retake already takes.

## 7. `waitFor` on a container is not a wait for content, and nothing says so

**Cost: one of the two wasted `distill-messy-launch` takes.**

`.distill-turn.assistant` renders as an empty shell and streams its text in
afterwards, so `waitFor` on it resolves instantly. A scene placed on that wait
captions a blank bubble. The original manifest had a comment warning about this,
which is how I know it cost someone a take before me — and I hit it anyway, from a
different direction, because the fix in the comment (a flat `wait 7000` after) has
its own failure mode: the paragraph is read before the caption naming it appears.

What actually tracks the stream is the app's `busy` flag, surfaced in the send
button's label (`…` → `Send`). Waiting for `button.capture-btn:has-text("Send")`
is correct and obvious in hindsight, and there is no way a manifest author gets
there without reading the app's source.

This is `docs/friction-notes.md` §5, still open.

**Ask:** a first-class idiom. `waitFor: {selector: X, stableMs: 800}` (resolves when
the subtree stops mutating), or `waitForText: {selector: X, minChars: 40}`. Either
would make "wait until the streamed reply has landed" expressible without reverse-
engineering the app's loading states.

## 8. There is no way to review an output

**Cost: threaded through the whole audit — every judgement in it.**

The task was "watch these eight videos and decide". Retake has no command for that.
What I actually did, eight times:

```
ffmpeg -ss $t -i demo.mp4 -frames:v 1 -vf scale=900:-1 out.png
```

at a dozen timestamps each, then read the PNGs. (A `tile` contact sheet would have
been faster, but this ffmpeg build has no `drawtext`, so an untimestamped grid is
guesswork.)

`stills/` is the closest thing and it is not close enough, for three reasons:

- **It is inconsistent.** `capture-hero` and `distill-messy` — the two longest and
  most complex takes, the two most worth reviewing — have no `stills/` directory at
  all. The five short ones do.
- **It is per-scene, so it cannot show a caption going false inside a scene.**
  `scratch-mini-project`'s whole defect is invisible in its stills: the `empty`
  scene's mid and end stills both show a caption that is true at the start and false
  by the end, and neither still is taken where the contradiction is sharpest.
- **It has no timeline.** Nothing maps a still back to a playback timestamp, so a
  still cannot be used to reason about pacing, which is half of what a launch cut
  is judged on.

**Ask:** `retake contact <dir> [--every 2s]` writing one timestamped grid PNG per
output, and produce it by default for `mode: launch`. It is a few lines of ffmpeg
and it is the artifact a human actually needs to sign off a video.

## 9. `take.json` does not record the manifest it was recorded with

**Cost: low individually, but it undermined every judgement in the audit.**

Given `outputs/mark-done/`, there is no way to know what produced it. `take.json`
holds the timeline and the video path; `facts.json` holds a `renderHash` and the
preset *name*, but no manifest content. To answer "was this recorded in demo or
launch mode?" I had to read `demos/mark-done.yaml` — which is the current manifest,
not necessarily the one used four days ago.

For an audit that is a correctness problem, not a convenience one: I was reasoning
about videos using manifests that might have changed since they were rendered.

**Ask:** write the fully-resolved manifest into `take.json` (or beside it as
`manifest.resolved.yaml`). It is small, and it makes an output directory
self-describing and self-contained — which pairs with §2.

## 10. Smaller things

- **A caption rewrite silently changed the output dimensions.** One longer caption
  took `scratch-mini-project` from 1440×1000 to 1440×1060, because `bandFit: text`
  sizes the band to the longest caption. For a *series* meant to look consistent
  across a feed, that is surprising. Ask: warn on dimension change during `render`,
  and offer a way to pin band height across a set.
- **A scene `camera.focus` selector that the scene destroys frames empty space,
  silently.** `camera: {focus: ".act", zoom: 1.5}` on a scene whose click removes
  `.act` produced a zoom onto blank background with no warning. Ask: log the
  resolved focus rect, and warn at validate time when a scene's focus selector is
  the target of a removal within that same scene.
- **`validate` warns on a deliberate opening hold.** `scene "one-left" has only
  waits before the next scene — nothing happens on camera in it` is good advice for
  `mode: demo` and wrong for `mode: launch`, where an opening held frame is the
  whole point. Ask: suppress for the first scene when `mode: launch`.
- **Any open browser tab on the app fights the seed.** I had a tab on
  localhost:3100 while seeding; the Capture client pushed its own board back and
  the seed vanished. `lock:` serialises Retake takes but nothing notices a human's
  tab. Ask: after seeding, re-read the source of truth and fail loudly if it does
  not match what was just written.
- **Relative-date seeding is still living in `demos/seeds/seed-board.mjs`.**
  `docs/friction-notes.md` §7 asked for this to move into Retake. It has not, and it
  was load-bearing for three of today's four re-records — every "this is two weeks
  old" claim in the new videos depends on it. It is too useful to stay a
  project-local script.

## What worked, and should not be changed

- **`compressIdle` is excellent, and its logging is the best thing in the tool.**
  `idle: type "ok so the contract thing…": 11.6s shown as 2.4s` tells you exactly
  what was done to the timeline and why. Four such lines on `distill-messy-launch`
  cut 20 seconds of nothing out of a 62-second take without touching a single step.
- **`mode: demo` / `mode: launch` with the schema comments explaining the difference
  is doing real work.** The validator warning that a `demo` carrying an intro card
  should probably be a `launch` is the kind of guidance that changes what people
  make, not just what they debug.
- **`proof-log.md`'s shot list.** Scene label, timestamp, caption, in one block. It
  was the first thing I read for all eight videos and it is the reason the audit
  could start with a hypothesis instead of a blind watch.
- **`--force` on render, and how cheap re-rendering is.** The scratch fix went from
  decision to finished MP4 in under a minute.
