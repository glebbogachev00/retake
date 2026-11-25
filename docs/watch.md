# Watch mode

Sit and watch an AI test a web app, live or later as a replay, and flag the
moments that work but don't look clear.

A test script keeps its own Playwright browser and hands its page to
`startWatch`. Before each step it says what it is about to do and what it
expects; after the step it says how it went. Retake streams the page into the
window, paces the run at the speed the person picked, hides secrets, and
writes the whole session to a folder.

The public guide, with screenshots, is at
https://www.useretake.app/docs/watch (`site/docs/watch.html`). This file is
the developer's source; keep the two in step.
Its pictures come from `scripts/watch-docs-shots.mjs`, a real session
against Larkspur, a made-up app in `test/fixtures/larkspur/`: rerun it when
the window changes.

## The script side

Watch mode arrived in 0.16.0. Add Retake to the project that holds the test
(`npm install --save-dev retake-demos`); the test keeps its own Playwright.

```js
import { startWatch } from 'retake-demos/dist/watch.js';
// from a clone: '<clone>/dist/watch.js' after `npm run build`,
// or '<clone>/src/watch.ts' under tsx

const w = await startWatch(page, { title: 'Client portal – licences', ui: 'http://localhost:4311' });
await w.mask('#password');                            // before anything secret is on screen
await w.scenario('L4 Licence running out');           // a heading for the steps that follow
await w.step('Click Renew', 'The request form opens, already filled in');
await page.click('text=Renew');
await w.result(true, 'Form pre-filled: Survey Suite, 1 seat');
await w.beat();                                       // the pause between steps, at the person's pace
const { dir, flags } = await w.end();                 // writes the folder, returns the person's flags
```

| Call | What it does |
|---|---|
| `startWatch(page, { title, ui?, out?, mask?, fix? })` | Starts the live picture and the session folder. `ui` is the Retake window (default `$RETAKE_UI`, else `http://localhost:4310`; `false` for none). `out` is the outputs folder (default `$RETAKE_OUT`, else the window's; with neither, Retake's own install folder, so set it when there is no window). `mask` hides things from the very first frame. |
| `w.scenario(name)` | Groups the steps that follow under a heading. |
| `w.step(intent, expect)` | Starts a step. Its screenshot is taken once the next action has settled (the first change on screen, then half a second of stillness), or at `result` if nothing changed. |
| `w.result(ok, note?)` | Ends the step: pass or fail, and a short note. |
| `w.beat()` | Honours the person's speed: Watch about 1.5 s, Step waits for Next, Fast returns at once. If the script skips it, the next `step` takes the pause instead. |
| `w.mask(selectorOrLocator)` / `w.unmask(…)` | Blacks out a region (with a blur under it) in the stream, the screenshots and the video. Takes one or an array. |
| `w.end()` | Stops the picture, makes the video, writes the folder, returns `{ dir, flags }`. |
| `w.dir`, `w.link` | The session folder, and its address in the window (or `null`). |

To use Retake's own browser in a script, import
`retake-demos/dist/browser-home.js` before `playwright`.

### Masks

A CSS selector (`#password`, `.qr canvas`, `[data-testid=totp]`) is applied by
the page itself through an init script, so it is in place before the page's
first paint, on every page the context opens, after every navigation. Prefer
CSS for anything secret.

A Playwright locator or a Playwright-only selector (`text=…`, `role=…`,
`>>`) cannot be applied by the page, so Retake finds it and marks it: at
`mask()`, after every page load, and four times a second. Something that
appears between two of those can show for a moment. Use CSS when that
matters.

Styles go in through a constructed stylesheet, so a page whose
Content-Security-Policy forbids inline styles is still masked.

### Fixing what was flagged (optional, off by default)

`startWatch(page, { …, fix: { repo: '/abs/path/to/app', command: 'claude -p' } })`
runs that command in that repo, with the fix brief on stdin, each time the
person's notes go out. Its output goes to `fix-request.log` beside the brief.

## The window

Open `http://localhost:4311/watch` (the port of whichever window the script
names). It opens the live session, or lists past sessions, newest first.

- The page, large. Under it, one line: what the AI is doing and what it
  expects, then its verdict.
- **Next** (or Space) and **Unclear** (U). Unclear saves a flag at once, with a
  screenshot and the page's address, and puts the cursor in the note field:
  Enter saves the words, Esc keeps the flag without them.
- The note field is always there: type at any moment and press Enter.
  While it has the cursor, a Watch pause waits for you.
- **Watch · Step · Fast**: the person's choice, kept between sessions. A
  script cannot change it.
- After the session, the same screen plays the video, at 1× or 2×. Each step is
  a mark on the timeline; click a mark, a step, or anywhere on the line to
  jump. Unclear and notes work the same and attach to the step at that time.
  Space plays and pauses; ← and → jump 5 seconds.

When a session's video ends (on `w.end()` for a live session; at the end of
playback, or when the window closes, for a replay) and it has unsent notes,
the window says "Sending 2 notes to fix in 10s — Undo". Ten seconds later it
writes `fix-request.json` and `fix-request.md` to the session folder, adds one
line to `outputs/watch/fix-queue.jsonl`, and posts a `fix-request` event to the
activity feed. Notes added after that go out as `fix-request-2`, and so on.

An agent that takes a request can append a line to the queue with the same
`dir` and `request` and a new `status` (`picked`, `pr <url>`, `done`). The
window shows the latest status next to each note.

## The folder

`outputs/watch/<title>-<YYYYMMDD-HHMM>/`

| File | |
|---|---|
| `session.mp4` | The whole session, made from the live frames. |
| `steps.json` | Each step: `n, scenario, intent, expect, result, note, startedAt, endedAt, t, tEnd, url, screenshot`. `t` is in milliseconds from the start, the same clock as the video. |
| `flags.json` | Each flag: `n, kind (unclear or note), step, time (seconds), at, note, screenshot, url, source (live or replay), fix`. |
| `shots/` | `step-NN.jpg`, `flag-NN.jpg`. |
| `report.md` | Your flags first, with screenshot links, then every step with its verdict. |
| `session.json` | Title, start and end, the video. |
| `fix-request*.json/.md` | The briefs that went out. |

`steps.json` and `flags.json` are written as the session goes, so a script
that dies half-way still leaves what happened.

## Limits

- The live picture and the video show the page's viewport only: no browser
  chrome, no other tabs or popup windows.
- They come from the Chrome DevTools screencast, so they need Chromium. In
  Firefox or WebKit there is no live picture and no video; steps and
  screenshots are still kept.
- The window listens on 127.0.0.1 only, so the person watches on the same
  computer as the window. Watching from another device is not built.
- The cursor is drawn by the page from real mouse events. It glides to
  where Playwright clicked, a moment after the click.
- Watch pace pauses only at Retake's own calls (`step`, `beat`). It cannot slow
  down Playwright's actions in between.
- A mask covers elements in the page and its iframes. It does not reach into
  closed shadow roots. Over a native `<dialog>` the blur still applies but the
  black box may sit underneath.
- A script that exits without `w.end()` leaves `steps.json`, `flags.json` and
  the raw frames in `.frames/`, but no video and no report.
- The `fix` command is held by the window the script registered with. After
  that window restarts, notes from a replay still reach the queue but do not
  start the command.
- Masks hide pixels, not text: each step's and each flag's URL is saved in
  the folder and the fix brief.
- The screencast sends a frame only when the screen changes, so a still screen
  is one frame held: the video is exact in time, not in frame count.
