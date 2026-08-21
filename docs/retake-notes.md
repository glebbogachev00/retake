# Notes from recording a 5-minute product walkthrough

Written while recording `demos/avex-full-flow.yaml` — one charter request
through three portals, 171 steps, ~80 interactions, 5m09s of finished video.
Retake had only ever been asked for short takes before this one, and almost
everything below is a limit that only shows up past about the two-minute mark.

Two of these I fixed in place while recording; they are marked **fixed**. The
rest are reported, not touched.

---

## 1. The cursor silently disappears from any long take

**This is the serious one.** The finished video has no mouse cursor at all —
forms fill themselves and buttons depress with nothing pointing at them.

`testreel` animates the cursor's position and opacity with an ffmpeg
expression that nests one `if()` per keyframe:

```
if(lt(t,27.59),624.5,if(lt(t,29.47),624.5,if(lt(t,30.07), ... )))
```

ffmpeg's expression parser refuses to parse past **98 levels of nesting**.
Measured, not guessed — bisected against ffmpeg 9.0.1:

```bash
depth  98: OK
depth  99: FAIL   # Missing ')' or too many args
```

Each cursor move costs two levels (a hold segment and a ramp segment), so a
take is capped at roughly **49 interactions**. This demo has about 80. The
overlay filter fails to initialise, ffmpeg drops it, and the cursor is gone.

### What makes it a bug rather than a limit

The run reports success anyway:

```
■ take done in 313.5s · all steps ok
✓ outputs/avex-full-flow/demo.mp4
check: pass
```

Nineteen `Error initializing filters` lines scroll past in between, buried in
multi-kilobyte expression dumps, and nothing downstream notices. I only found
it by extracting a frame at a known click and looking for a pointer that
wasn't there. Anyone recording a long demo ships a cursor-less video and never
knows — including, I suspect, whoever recorded the earlier version of this
same demo.

### Fixes, cheapest first

- **Detect it.** If the built expression exceeds ~90 levels, fail the check
  loudly instead of passing. One line, and it turns a silent wrong output into
  a visible error. Worth doing even if nothing else changes.
- **Flatten the expression.** The segments are disjoint, so a sum works and
  never recurses:
  `between(T,a1,b1)*v1 + between(T,a2,b2)*v2 + ...`
  Same maths, unbounded length, no parser depth involved.
- **Or stop doing it in ffmpeg.** Draw the cursor in the page during capture,
  or drive it with `sendcmd`. Post-hoc compositing of a per-frame value into a
  single expression is the thing that doesn't scale.

Meanwhile the manifest declares `cursor: false` with the reason inline, so the
render is at least honest about it.

## 2. Two different limits for "how long may a take be", neither aware of the other

`maxSeconds` in the manifest defaults to 240. The render's sanity check
hard-codes 300. A take needs to clear **both**, and raising the one you are
told about doesn't help:

```
■ stopped: the take passed 240s (maxSeconds) — something is stuck
```

Raise `maxSeconds` to 900 and the take completes, then:

```
check: FAIL
  FAIL  duration: 347.3s
```

The second message names no knob, so there is nothing to search for. Two runs
of six minutes each to get past a number that was never the problem.

**fixed** — `src/render.ts` now checks against the manifest's own `maxSeconds`
rather than a fixed 300. A take inside the bound its author declared is not a
runaway and shouldn't be failed for length. The 300 remains the default when
no manifest is in play.

Also: "something is stuck" is a guess, and it was wrong both times. The take
wasn't stuck, it was long. Worth saying "reached the maxSeconds limit — raise
it if the take is meant to run this long" instead.

## 3. No control over scroll speed — the single biggest cause of "it goes by too fast"

This was the original complaint about the old video, and it turned out not to
be a pacing choice at all. `rec.scroll()` runs a fixed 600ms **regardless of
distance**, so a 200px nudge and a 2000px traverse take the same time. Long
scrolls read as a snap, and there is no manifest knob to slow them.

testreel already accepts `scrollSpeed` (`duration = 600 / scrollSpeed`).
Retake simply never passed it through.

**fixed** — `speed:` on the scroll step, plumbed to `scrollSpeed`:

```yaml
- { action: scroll, to: "[data-ops-field='margin_pct']", align: center, speed: 0.3 }
```

Two lines: one schema field, one argument. It did more for the pacing of this
demo than every `pauseAfter` I tuned by hand.

**Suggestion:** default it to distance-proportional rather than constant.
A viewer's eye needs roughly constant *pixels per second*, not constant
seconds per scroll.

## 4. Stills are taken mid-scene, which costs review rounds

The proof log says so plainly — *"each taken at the MIDDLE of its scene (not
the end)"* — so this is a documented decision, not a bug. It still cost me two
wrong conclusions.

`13-quote.png` shows an empty quote form. The margin clicks, the line items
and the operator name all happen after the still is grabbed. I read that still
as "the margin calculator didn't fire", went digging, and found nothing wrong;
the next scene's still showed `Margin $2,600` exactly as expected.

A caption names what the scene *achieves*. The middle of the scene is
reliably the moment before it achieves it.

**Suggestion:** grab the still just before the next scene marker, or grab both
and keep the later one. For a workflow built around `look`-then-judge, the
frame you hand the reviewer should be the one that answers the question they
are about to ask.

## 5. Duplicate scene labels pass validation

I had two scenes labelled `ask` and nothing objected. Stills are prefixed
`NN-` so they didn't collide, but `thumbnail: { scene: ... }` and the proof
log both address scenes by label, and there `ask` is ambiguous. A uniqueness
check in the manifest schema is nearly free.

## 6. `dry` verifies reachability, not whether the shot is worth taking

`dry run: all 171 steps resolved` passed on a final scroll that landed on the
empty half of a two-column layout — the left column had ended two screens
earlier, so the payoff shot of the whole demo was mostly white space. Correct
by every check Retake makes, and useless as a frame.

Not asking `dry` to have taste. But two mechanical checks would have caught it:

- a `scroll to` whose target ends up below the last content in its column
- a scene with no action between it and the next scene marker

## 7. Error output buries the diagnosis

Nineteen copies of a 4KB ffmpeg expression, and the actual sentence —
`Missing ')' or too many args` — sits at the front of each one where it is
easiest to scroll past. Truncating the expression to its first ~200 characters
would make the same output readable, and would have made §1 obvious in
seconds rather than after frame extraction.

## 8. `retake` is not on PATH

The skill's CLI fallback table says `retake dry demos/<name>.yaml`. From a
fresh shell that is `command not found` — `bin` points at `./src/cli.ts`,
which needs `npx tsx src/cli.ts dry ...`. Small, but it is the first command
anyone types.

---

## What worked well, for balance

- **`dry` before `run` earns its place.** All 171 steps resolved first try
  after the manifest rewrite, including five newly-required form fields and a
  panel that didn't exist when the demo was first written. Six minutes of
  recording not wasted.
- **Stubs are the reason this demo exists.** The backing store isn't reachable
  locally; 38 fixture files carried a record through twelve stages and three
  portals, and the proof log names every stubbed endpoint so the take can
  never be mistaken for live.
- **`storageState` auth** meant sign-in ran once across a dozen runs.
- **The demo found two real product bugs.** A step that had become mandatory
  still told users it was optional, and a customer in Ho Chi Minh City was
  being shown `(16:30 Asia/Saigon your time)` — an IANA alias printed raw, next
  to a time identical to the one above it. Neither was visible in any test.
  Recording the flow at a speed a person can read is a form of review.
