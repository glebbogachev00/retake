# Retake — friction notes from recording the Capture set

Written while drafting and recording six demos in one session. Everything
here cost real time or a wasted take. Ordered by how much each would save.

Retake did the hard parts well: `dry` caught selector problems in seconds,
`proof-log.md` said exactly which step failed and what was on screen, and
re-running after an edit was genuinely cheap. These are the sharp edges.

---

## 1. `dry` does not run seeds — and that makes it lie

**Cost: one confusing debugging detour.**

`dry` runs against whatever state the app is in. For a demo whose story
depends on seeded state, it fails for reasons that will not happen during
`run`, and *passes* for reasons that will not hold either.

Concretely: the `it-learns` demo needs the app to have no learned rule. Its
first `run` seeded correctly and passed. The next `dry` inherited the state
that run left behind — including a rule the app had just learned — so the
app took a different branch, offered different buttons, and `dry` reported
a selector failure that had nothing to do with selectors.

**Ask:** `dry --seed` (opt in), or run seeds by default and let `--no-seed`
opt out. Even a warning would help: *"this manifest has seeds; dry did not
run them, so the app state may not match."*

## 2. Stills are captured at the END of a scene

**Cost: three wasted round trips, and nearly a wrong conclusion.**

I judged several scenes from `stills/NN-label.png` and concluded the demo
was broken. The stills showed the *next* interaction — cursor already on
the button the following step clicks, a modal already open, a spinner from
work that started after the beat.

The video was correct the whole time. I only found out by pulling a frame
with `ffmpeg -ss` at the scene's own timestamp from the shot list.

This matters because the skill file says to `look` at the take and judge it
like a viewer. If the stills are end-of-scene, that instruction quietly
misleads.

**Ask:** capture the still in the middle of the scene's hold, or emit both
(`NN-label.png` and `NN-label-end.png`). Failing that, say which it is in
`proof-log.md` — one line would have saved all three trips.

## 3. `scroll: { y: 0 }` did not move the page

**Cost: one wasted take.**

```yaml
- action: scroll
  y: 0
```

resolved fine, reported success, and the frame did not move. Replacing it
with `evaluate: window.scrollTo(0, 0)` worked immediately. Either the action
targets something other than the window, or it silently no-ops when the
scroll container is not the one it expects.

**Ask:** make `scroll` act on the window by default, or fail loudly when it
cannot.

## 4. `evaluate` with a one-line script is a YAML trap

**Cost: one parse error.**

```yaml
- action: evaluate
  script: window.scrollTo({ top: 0, behavior: "instant" })
```

The braces parse as a YAML flow mapping and the manifest dies with a parse
error pointing at the script line. A block scalar (`script: |`) fixes it.

**Ask:** the schema error could name this — *"script looks like a mapping;
use `script: |`"* — since it will happen to everyone who writes an object
literal in JS.

## 5. Waiting on transient UI is a footgun the docs could warn about

**Cost: one 60-second timeout inside a take, which then rendered a 90s video.**

I waited on a success banner (`.landed`) that clears itself after nine
seconds and shares its class with another transient notice. The thing it
announced was on the board the entire time.

The lesson generalises: **wait for the durable result, not the announcement
of it.** `.act >> nth=1` — a second row existing — is the assertion that
actually matches the caption.

**Ask:** a line in AGENTS.md. Something like *"prefer waiting on state that
persists (a row, a count, a heading) over toasts and banners, which may
clear before the wait resolves."* Cheap to write, saves a two-minute take.

## 6. A failed step still renders a full-length video

When step 17 timed out at 60s, the take carried on and produced a 90-second
MP4 with a minute of dead air. `check` correctly said FAIL, but the render
still cost time and disk.

**Ask:** skip the render on a failed take unless `--render-anyway`, or trim
the dead tail.

## 7. No relative-date seeding (I had to build it)

Three of six demos needed a board that was already old — an action twelve
days overdue, one faded three days ago, one mid-shelf-life. Fixtures store
epoch milliseconds, so a hand-written fixture is stale the day after it is
written, and the demo silently stops telling its story.

I wrote `demos/seeds/seed-board.mjs`, which resolves `"-12d"`, `"+6d"`,
`"now"` at seed time and installs the board the way `wipe-board.mjs` does
(tombstoning what is there first, so an open tab does not re-upload the old
board over it).

**Ask:** this is app-agnostic and probably belongs in Retake itself — a
`seed: { kind: json, path: …, relativeDates: true }` that resolves offsets
before writing. Every app with "3 days ago" in its UI needs it.

## 8. Nice-to-haves

- **`run --until <scene>`.** When only the last beat is wrong, re-running
  the whole take costs the full duration plus a model call per capture.
- **A still-only mode.** For judging framing I do not need an encode; six
  PNGs would do and would be ten times faster.
- **`check` could flag dead air** — a take whose last step ends well before
  the video does is nearly always a bug (Retake already prints this as a
  note; it could be a check failure).
- **Selector hints from the app's own test ids.** `read_project` found the
  routes; it did not surface that `Restore` lives inside a `.row-actions`
  menu that only exists after clicking `[aria-label="More options"]`. I
  found that by reading the component. Not really Retake's job — but a
  "this element is inside a collapsed container" note from `scout` would be
  worth a lot.

---

## What worked, and should not be changed

- `validate → dry → run --preset preview-fast → run` is the right ladder.
  Nearly every failure was caught by `dry` in under ten seconds.
- `proof-log.md` naming the failing step *and quoting what was on screen*
  is the single most useful output. That quoted text is what revealed the
  learned-rule state problem in note 1.
- `--preset preview-fast` at ~40s per take made six demos affordable.
- Failing non-zero and printing plainly means an agent never has to guess.
