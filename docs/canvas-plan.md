# Canvas editors: Scratch and GDevelop — the plan

Branch `canvas`, cut from `chat`. Merges back when one real Scratch lesson
records clean. Read `docs/gdevelop-scratch-retake-claude-brief.md` first — this
plan agrees with it, and resolves its one tension (below).

## Probed facts (2026-08-21, headless Chromium, no login)

| Fact | Scratch `scratch.mit.edu/projects/editor/` | GDevelop `editor.gdevelop.io` |
|---|---|---|
| Loads without account / modal | yes, `.blocklyFlyout` in ~10s | yes; in-app tutorials open from the home screen |
| Block elements | SVG, `.blocklyFlyout g.blocklyDraggable[data-id]` — 187, all with ids; text in `.blocklyText` | React/Material UI panels; scene editor is a PixiJS canvas |
| Fixed geometry at 1440×900 | stage canvas 480×360 at (951,93); workspace 942 wide; "move 10 steps" at (70,121) 103×38 | — |
| Green flag | `[class*="green-flag_green-flag-button"]` (CSS-module class, stable prefix) | — |
| Tutorial flow | — | clicking "Platformer" opens *"Let's make a platformer game"* (official in-app tutorial, `[role=dialog]`) |
| testreel drag API | none — a drag must be composed | same |

The brief's Scratch URL (`scratchfoundation.github.io/scratch-gui/develop/`)
returns 404 — the repo is archived and its Pages build is gone. The official
editor is the same GUI.

## The tension, resolved

The brief says *do not build features; avoid drag-and-drop*. In Scratch the
lesson **is** dragging. Both are right, in order:

- **Phase A — no features.** Clicking a block in the palette *runs it*: click
  "move 10 steps" and the cat moves on the stage. A real lesson beat, zero
  new engine work, and it proves Retake on an SVG editor + canvas stage today.
- **Phase B — one step type.** `drag` is the only feature this market needs.
  Built once, proven on one lesson, then widened by use.
- **Phase C — GDevelop**, mostly DOM, rides on A + B.

## Phase A — DONE (2026-08-21)

`demos/scratch-first-move.yaml` records clean: 19s, 14/14 dry, check pass,
sprite **x: 0 → 50** in the final frame. Two findings, both now in the engine
or the manifest:

- **Click the block's `<text>`, not its group.** `.blocklyFlyout text:has-text('move')`
  runs the block. Playwright's click on `g.blocklyDraggable` times out (Blockly
  intercepts pointer events on the group), and a raw mouse click at the group's
  centre lands on the number input and does nothing. The first take passed every
  check with the cat at x: 0 — proof that on canvas apps `look` is the assertion,
  not `check`.
- **`networkidle` is the wrong gate for public sites.** scratch.mit.edu never
  goes idle, so `goto` timed out at 30s. Retake now waits for the document
  (60s) and treats idle as a short bonus; `waitForSelector` is the real gate.

## Phase A — Scratch, click-to-run (recipe)

`demos/scratch-first-move.yaml`: open the editor, click "move 10 steps" in the
palette three times (the cat walks), click "turn 15 degrees", hold on the
stage. Selectors: `.blocklyFlyout g.blocklyDraggable:has-text("move")`.
Camera static. Under 20 steps, well under the cursor cap.

What it proves: selectors on Blockly SVG resolve in `dry`; clicks land on
SVG targets through the overlay; the canvas result is visible to `look`.
What it cannot prove: anything about dragging.

## Phase B — DONE (2026-08-21)

`demos/scratch-first-script.yaml`: 19s, dry 13/13, check pass. The final frame
shows `when flag clicked` with `move 10 steps` snapped under it and the sprite
at x: 10 — a child's first script, built by dragging, on video.

What the build actually needed, beyond the plan:

- **Playwright finds, the page measures.** `locator.boundingBox()` waits for
  visibility and times out on Blockly's toolbox categories (they intercept
  their own pointer events). `locator.elementHandle()` + `getBoundingClientRect`
  in the page returns a rect for anything attached — and keeps Playwright
  selector syntax (`:has-text`, `>> nth=`), which raw `querySelectorAll`
  cannot parse.
- **Two cursor keyframes, many mouse moves.** `moveCursorToPoint` (exported by
  testreel) logs the overlay's start and end; the page gets 16 small moves in
  between. A drag therefore costs the cursor expression what a click costs —
  without this, three drags would exceed ffmpeg's nesting limit and the cursor
  would vanish.
- **An 8px nudge after mousedown**, or Blockly never starts the drag.

## Phase B — `drag` (design as built)

### Schema

```yaml
- action: drag
  from: ".blocklyFlyout g.blocklyDraggable:has-text('move')"   # selector | {x,y} | {selector, dx, dy}
  to:   { selector: ".blocklyWorkspace", dx: 300, dy: 200 }     # same shapes
  steps: 18          # intermediate mouse moves (smoothness); default 16
  holdMs: 120        # pause after mousedown before moving; default 100
```

Click and hover gain the same target shapes (`at: {x,y}` / `{selector,dx,dy}`)
for canvas hits — the Scratch stage, GDevelop's scene editor.

### Mechanics (the spike)

testreel records cursor keyframes only from its own actions. A drag is
composed as: `rec.hover(from)` (cursor travels on camera) → `page.mouse.down()`
→ N × `page.mouse.move` **paired with** testreel cursor-position events so the
overlay follows → `page.mouse.up()`. The spike answers one question: does
testreel expose a way to add cursor keyframes outside its actions (a
`moveCursorTo` / event push)? If yes, the overlay follows exactly. If no, the
fallback is a chain of `rec.hover` calls along the path with the button held —
visually identical, slightly slower. Either way the cursor is on camera.

### Dry run

Resolves both ends (exists + visible), checks point targets are inside the
viewport, never performs the drag. Canvas results are not checkable by `dry`;
the skill says: on canvas apps, `look` is the assertion.

### Acceptance (the merge condition)

"Make the cat move when the flag is clicked": drag the `when flag clicked`
hat, drag `move 10 steps` under it, click the green flag, `look` — the cat
has moved. ~30s, under the cursor cap, `dry` passes, `check` passes, the end
still shows the cat displaced.

## Phase C — DONE (2026-08-21)

`demos/gdevelop-scene-and-events.yaml`: 23s on camera, 43s of navigation
trimmed off the front, dry 11/11, check pass. The payoff frame shows the event
sheet reading *"At the beginning of the scene → Hide KnightHitBox"*.

Three findings, all of which cost a take:

- **The in-app tutorial locks the UI to its own next step** — and that step is
  Preview, which opens a second tab Retake cannot record. Setup clicks *Quit
  tutorial*; the project stays open and the editor becomes explorable. Until
  then, tab clicks silently did nothing and the captions lied over the wrong
  screen.
- **A click belongs before the scene it causes.** With the click at the end of
  a scene, that scene's last frames show the next action instead of the
  payoff. Every scene here starts after the click that earns it.
- **Event groups start collapsed** (`button.rst__expandButton` opens them), and
  the events tab shows a promo card. Setup visits the tab once, dismisses the
  card with a selector-plus-offset point, and returns — so the recording never
  contains an advert.

Editor handles are stable ids: `#tab-layout-Level-1-button`,
`#tab-layout-events-Level-1-button`, `#main-toolbar-project-manager-button`.

## Phase C — GDevelop (original plan)

Start from the in-app platformer tutorial (official, logged-out). Put any
"open example" / dismiss-prompt clicks in `setup`. Expect: panels and dialogs
are plain DOM; object placement in the scene editor needs the point targets
from Phase B. Split by tutorial step; each video ends on a visible result
(the preview running, the character moving).

## Non-goals

No "canvas mode", no generic drag heuristics, no UI changes, no desktop apps.
Long lessons are chapters of 30–45s — the cursor cap and the viewer's
attention agree on that number.
