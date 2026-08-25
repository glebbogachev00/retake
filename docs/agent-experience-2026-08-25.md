# Using Retake as an agent — a rating, and what cost the most

From one long session: eight takes of the same 251-step demo, across two days
of the product changing underneath it. Written for the person deciding what to
build next, not as a bug list.

## The rating

| | | |
|---|---|---|
| **Equipped for the job** | 9/10 | Almost nothing was missing. What was missing was passthrough, not capability. |
| **Structured process** | 9/10 | `dry` → `run` → read receipts → `look` is the right loop, and the skill states it plainly. |
| **Efficient** | 5/10 | Correct on the first try, expensive on the second. This is the gap. |
| **Resistant to error** | 6/10 | Excellent at catching what it checks; the failures it misses are the expensive ones. |
| **Would I reach for it again** | Yes, without hesitating. | |

The honest summary: **Retake is very good at recording a demo and much weaker
at recording a demo *again*.** Almost every hour lost was a re-capture I should
not have needed.

---

## What cost the most, in order

### 1. A green `dry` is not a green `run`

The single most expensive pattern of the session. `dry run: all 251 steps
resolved` and then the take failed at step 57. Three separate times.

Causes, all different:
- a `select` on a `<select>` — `dry` resolved the selector; the run failed
  because `type` is not a thing you do to a dropdown
- a preset whose `scale: 2` implies a 960px CSS viewport, below the site's
  1020px burger breakpoint, so the app silently rendered its **mobile layout**
  and desktop fields were not where the steps expected
- a panel that only appears in one state, where `dry` happened to load a
  fixture in that state and the run did not

Each cost a full capture (~16 min for this demo) to discover.

**What would help:** have `dry` check step-kind against element-kind. `type` on
a `<select>`, `click` on a disabled button, `fill` on a `<div>` — all knowable
before a single frame is recorded. This alone would have saved three takes.

### 2. Presets that change layout, not just resolution

`post-landscape` is 1920 at scale 2, meaning the page renders at 960 CSS px.
For any responsive app with a breakpoint above that, **the preset silently
changes which UI you are filming.** I spent two takes on this and only worked
it out by reading `presets.ts`.

The manifest had `scale: 1` with a comment saying "breaks focus clicks", which
was a previous person hitting the same wall and describing the symptom rather
than the cause.

**What would help:** warn when `preset.width / preset.scale` is under ~1100, or
when a take's CSS viewport crosses a width where the DOM changes materially.
Even a line in the proof log — *"page rendered at 960 CSS px"* — would make
this self-diagnosing.

### 3. Speed work exists but is invisible at the moment of choosing

`--preset draft`, `--until <scene>`, and `render --preset <other>` are exactly
the right tools and they are excellent. I learned about them **after** eight
full-quality captures, by reading a commit diff.

The skill mentions `preview-fast` in a table; the iteration rules that make
these matter were added to `SKILL.md` late in the session.

**What would help:** make `run` say it. `"This is a 7-minute take. --preset
draft is ~4× faster and identical in layout and timing."` printed once, before
capture starts, would have changed my behaviour on take two.

### 4. Passthrough gaps

Three times the underlying library could do the thing and the manifest could
not ask for it:

- **`scrollSpeed`** — testreel had it; `rec.scroll()` ran a fixed 600ms
  regardless of distance, so a 2000px scroll and a 200px nudge took the same
  time and long ones read as a snap. This was the actual cause of a "the demo
  goes by too fast" complaint that I first tried to fix with `pauseAfter`.
- **`select`** — testreel had `action: 'select'`; the manifest had no way to
  reach it. A form-heavy app is mostly dropdowns.
- **`maxSeconds`** default 240 vs a hard-coded 300 in the render check: two
  limits for one concept, and raising the one you are told about does not help.

All three are now fixed. The pattern is worth watching for: **if testreel can
do it, the manifest should be able to ask for it.**

### 5. Failures that pass every check

A take can be perfect by every measure and unwatchable:

- **The cursor was silently absent from every long take.** ffmpeg's expression
  parser stops at 98 nested `if()`s; testreel emits two per keyframe; past ~49
  interactions the overlay fails to initialise and is dropped. `all steps ok ·
  check: pass`.
- **A 46-second stall** mid-take, holding one still frame, while every step
  reported ok. A stalled step is not a failed step.

Both now have checks. The general lesson is the valuable one: **pass/fail is
not the same as watchable**, and the checks that matter most are the ones that
ask whether the *artefact* is good rather than whether the *run* completed.

---

## What is genuinely excellent

- **`dry` earns its place.** 251 steps resolving first try, after a manifest
  rewrite against a product that had changed under it, is worth a great deal.
- **Stubs.** This demo cannot exist without them — the backing store is not
  reachable locally, and 58 fixtures carry one record through thirteen stages
  and three portals. That the proof log names every stubbed endpoint means the
  take can never be mistaken for live. That is a trustworthy design.
- **`storageState` auth.** Sign-in ran once across a dozen runs.
- **The failure messages.** *"the take passed 240s (maxSeconds)"* names the
  knob. *"a one-line script with braces parses as YAML"* names the fix. Most
  tools would have said "timeout".
- **The proof log is the artefact I trust.** Per-step timings, stubbed
  endpoints, what failed and what was on screen.

## The one thing I would build next

Make `dry` a real rehearsal rather than a resolution check — same steps, same
assertions, no camera. Every expensive surprise this session was something
`dry` could have known and did not, and capture time is the dominant cost of
using this tool at all.

## A note on the demo itself

Recording the flow at a speed a person can read found **five real product bugs**
that a 428-check test suite did not: a step that had become mandatory while
still telling users it was optional, a raw IANA timezone shown to a customer,
radio buttons taking a text field's width, a squashed logo, and an email
subject carrying a full ISO timestamp. Every one was invisible to tests and
obvious on sight.

That is the strongest argument for this tool, and it is not the argument the
docs make.
