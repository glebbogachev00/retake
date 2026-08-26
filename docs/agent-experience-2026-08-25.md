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

---

# Update after 0.4.x — better, and one new top finding

Re-recorded both demos against the updated build. **`actionFits` and the
1280px breakpoint re-check both paid off immediately.** The second demo cost
one failed dry run and *zero* failed takes; the equivalent last session was
three captures. `dry-failed-*.png` is doing real work — I diagnosed a wrong
page state from the screenshot without recording anything.

Revised: **efficiency 5 → 7**, **error-resistance 6 → 8**. Equipped and
structured stay at 9.

## The new top recommendation: print the CSS width

Ahead of everything else now, because **three separate incidents traced to it
in one session**:

1. A take died at step 57 because `post-landscape` (1920 at scale 2) gave the
   app a 960px window — under the site's 1020px breakpoint — so it rendered its
   *mobile* layout.
2. Fixing that with a 1920 viewport silently reframed the demo. The client
   noticed the UI had shrunk; I had reported the resolution and not the
   framing, because I was not thinking in CSS px at all.
3. Fixing *that*, I set `viewport: 1440` believing scale multiplied up. It
   divides. The app got a 1080px window, below another breakpoint. The width
   check caught it; I did not.

The run header prints `page scale 1.3333×`. The number a person reasons about
is **the width the app was given**, and it is the only one not shown.

```
preset post-landscape · canvas 1920×1080 · page 1440×810 CSS · 30fps
```

That one field turns all three of the above into a glance. It is derivable
before a frame is captured, so it belongs in `dry` too.

Related: **the viewport is the output canvas and `scale` divides it.** That is
in a source comment in `presets.ts` and nowhere a manifest author will look.
Worth a line in the skill, because getting it backwards silently changes which
UI is filmed rather than failing.

## Second new finding: fragment-only navigation does not reload

`navigate` from `…/operations#/a` to `…/operations#/b` does not reload the
document, so an SPA keeps whatever state the last action left in memory and a
freshly-registered stub is never fetched. The page then looks plausible and is
stale, which is the worst kind of wrong.

Cost two dry runs. Statically knowable: compare consecutive `navigate` URLs and
warn when only the fragment differs.

The full-flow demo hid this for days because it bounces between `/operator` and
`/operations` — real page loads. The moment a demo stays inside one SPA, it
bites.

## Still open from the original report

- **Stub coverage in the proof log.** "My stub did not take effect" was the
  symptom above. Listing stubs that matched zero requests would have named it
  in seconds.
- **A picture at a stall.** The stall check works — it caught 25.5s at 0:56 on
  a scroll, which I would otherwise have shipped. But a timestamp alone leaves
  "re-record and hope"; I still do not know whether that one was the machine or
  the page. A frame grab would settle it, the way `dry` now does.
- **Scene-label uniqueness.** Still unchecked.

---

# Update after 0.5.x — `--from` is the win it was predicted to be

Two demos re-recorded after a product fix. Notes from that session only.

## `--from` did exactly what it was supposed to

The change was in the last 70 seconds of a 7½-minute demo. `run --from
track-confirmed` proved the whole new ending in **3 minutes instead of 8**,
and — the part I did not expect — it still executes every earlier step, so a
green `--from` run is also proof that the *whole* manifest still resolves
against the live app. I went straight to a full-quality take on that
evidence and it passed first time. Under the old workflow that would have
been a preview take plus a full take.

Both `dry` and `--from` now catch different things and neither is wasted.
That is the loop working.

## The new finding: `nudge` cannot fix a still whose beat scrolls away

I lost four rounds to this, so it is worth writing down.

A still is sampled at **the midpoint between this scene's start and the
NEXT scene's start** — not inside the scene's own span. So for a beat that
holds a good frame for 2 seconds and then scrolls somewhere else for 8, the
midpoint is always in the scroll. Nudging the scene moves its start *and*
its midpoint together, so a positive nudge makes it later and a negative one
drags the caption backwards out of the beat. There is no value that lands on
the frame you want.

The actual fix is pacing: hold longer before scrolling away. That also made
the video better, which is the tell that it was the right fix — the beat
was too short for a viewer to read ten names off, and the bad still was the
symptom rather than the problem.

**What would help:** say this in the failure surface people actually meet.
Either a line in `look` — *"still sampled at 28.0s, midway to the next
scene"* — or, better, let a scene name its own still: `still: after-scroll`
/ `still: 2500` sampled within the scene rather than halfway to the next
one. A knob that cannot express "the first two seconds of this beat" is a
knob you will keep reaching for and missing with.

The `-end.png` variants are genuinely useful and I use them to diagnose
drift, so the sampling model is sound. It is just invisible, and the
guessing costs renders.

## Smaller

- **`viewport` warns, and the warning is right to be conditional.** This app
  needs 1440 CSS px (breakpoints at 1020/1240/1400) and the preset gives 960,
  so the override stays. `validate` only complains when the override would
  change the *output shape*, which mine does not. That is the correct line to
  draw, and it is the first time this manifest's viewport has not felt like a
  fight with the tool.
- **Watching it again found two more product defects** that every check
  passed: a tracker rail that stopped four steps short of the end, and a
  finished trip still describing itself in the present tense. Neither is
  visible to a test. That is now seven real bugs this tool has found by
  being watched, which remains the strongest argument for it.

Ratings unchanged from the 0.4.x update except **efficiency 7 → 8** — `--from`
is most of the remaining gap closed. The last point is the still-sampling
model above: it is the only thing left that cost me renders rather than
minutes.

---

# Update — three findings from a re-record session

## 1. `look` shows a frame the deliverable never contains

This cost me a whole take, and it is the most fixable thing here.

`look` defaults to `frame: "end"` — the scene's last moment. The PNG that
ships in `stills/` and becomes the thumbnail is sampled somewhere else
entirely: **the midpoint between this scene's start and the NEXT scene's
start**. Those are routinely different frames, and for any beat that scrolls
or clicks near its end they are wildly different.

So I inspected a thumbnail with `look`, saw the wrong page, did arithmetic on
scene timings, lengthened a hold, re-recorded 85 seconds — and then opened the
actual PNG and found it had been correct all along.

**What would help:** make `look` say which frame it is showing relative to the
still, or add `frame: "still"` that samples exactly where the exported still
does. One line — *"this is the end frame; the still ships from 34.2s"* — turns
a wasted take into a glance.

Related: the midpoint rule means a beat's still cannot be moved without moving
the beat. Holding for H moves the good window's end by H but the sample point
by only H/2, so a still that lands just past the end of a hold needs **twice**
the shortfall in extra hold. That is worth one sentence in the docs; I derived
it the slow way.

## 2. The stall check is right, and does not say what to blame

It fired twice in one session and was correct both times. It is doing real work
and I would not want it gone.

But the message names the step — *"8.4s at 5:50 — go http://localhost:3200/#/track"* —
which points at the demo, and the demo was fine. The cause was system load. I
only established that by dropping to `ps` and `uptime`, and the numbers were
unambiguous once I did:

| load average | same 265-step take |
|---|---|
| 69.6 | 506s, one stall, `check: FAIL` |
| 7.9 | 458s, clean |

48 seconds — 10% of the runtime — purely contention on an 8GB M1. The short
demo told the same story: 80s clean, 149s with four stalls, 85s clean again.

**What would help:** sample load average at capture start and again at any
stall, and print it with the failure. *"stalled 8.4s · load average 69.6 — the
machine, not the demo"* would have saved the investigation and stopped me
suspecting my own manifest. Retake already knows capture is real-time; it is
the one tool in a position to say so.

## 3. What saved a lost manifest

`demos/avex-manifest-check.yaml` was deleted from disk mid-session, along with
its output folder, and it had never been committed. I rebuilt it from context
and the dry run came back at exactly 49 steps, matching the original.

Worth writing down: **`outputs/<name>/manifest.used.yaml` is a full copy of the
manifest a take was recorded from.** Had the output folder survived, the rebuild
would have been a `cp`. That is a genuinely good design decision that is not
advertised anywhere — the recovery path exists and nothing points at it.

**What would help:** one line in the docs, and possibly `retake restore <name>`.
Manifests live outside git by default, which makes them exactly the thing people
lose.
