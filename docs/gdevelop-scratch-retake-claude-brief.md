# Retake brief for Scratch and GDevelop walkthroughs

## Purpose

Use Retake to record walkthrough videos of Scratch and GDevelop.

Retake is not the main app a human operates. Claude Code or Codex should use Retake as a local demo-recording tool. The human gives a target URL and a desired story. The agent writes the Retake manifest, runs dry checks, records a preview, reads the proof log, and fixes the take.

## What we already know from Retake

Retake already has the correct agent loop in `AGENTS.md`:

1. Write `demos/<name>.yaml`.
2. Run `npm run retake -- validate demos/<name>.yaml`.
3. Run `npm run retake -- dry demos/<name>.yaml`.
4. Fix selectors and waits until dry passes.
5. Run `npm run retake -- run demos/<name>.yaml --preset preview-fast`.
6. Read `outputs/<name>/proof-log.md`.
7. Run `npm run retake -- check outputs/<name>`.
8. Record or render the final take after the preview works.

Important Retake constraints:

- Use `waitFor` after clicks that change the page.
- Prefer durable page state over toast messages.
- Keep demos short. Split long walkthroughs above about 40 steps.
- Cursor overlay can fail on very long takes. Use `cursor: false` or split the story if needed.
- Put logins and setup in `setup` or `auth.setup`, not in the visible demo steps.
- Use `run --until <scene>` when iterating on one part of a long demo.

## Main recommendation

Do not try to record the full Scratch or GDevelop editor in one long video.

Make small walkthroughs:

1. Scratch: create a sprite interaction.
2. Scratch: add a backdrop and make a character move.
3. GDevelop: create a platformer object and add movement.
4. GDevelop: add a scene event and preview the game.

Each walkthrough should end with a visible result. The result matters more than covering all menus.

## Scratch sources

### scratchfoundation/scratch-gui

URL: https://github.com/scratchfoundation/scratch-gui

What it is:

Scratch GUI is the React interface for creating and running Scratch 3.0 projects. The repository page says it is the graphical user interface for Scratch 3.0 projects. It also exposes a hosted build at `https://scratchfoundation.github.io/scratch-gui/develop/`.

Why it helps Retake:

- Use the hosted develop build as a public Scratch editor target.
- Use the repo source to learn stable UI names, project-loading behavior, and editor state.
- The repo contains `src`, `static`, and `test` folders that Claude can inspect for selectors and test patterns.

Risk:

The repository is archived as of June 10, 2026. Treat it as useful source context, not an active upstream.

### scratchfoundation/scratch-blocks

URL: https://github.com/scratchfoundation/scratch-blocks

What it is:

Scratch Blocks is the block editor library used for creative computing interfaces.

Why it helps Retake:

- It is the best source for block workspace behavior.
- Its README says browser tests run in Chromium through Playwright.
- It can show Claude how Scratch tests block interactions with a real browser.

Useful note:

The README lists this browser-test flow:

```bash
npm ci
npm run build
npx playwright install chromium
npm run test:browser
```

Retake does not need to run those tests. Claude should inspect them for selector and interaction patterns.

### Scratch walkthrough advice

Use Scratch through the hosted browser editor first. Avoid the desktop app for the first pass.

Good target:

```text
https://scratchfoundation.github.io/scratch-gui/develop/
```

Good demo idea:

```text
Show a student choosing a sprite, adding a simple movement block, pressing the green flag, and seeing the sprite move.
```

Likely Retake issues:

- Canvas and block workspaces may use SVG or custom DOM.
- Dragging blocks can be harder than clicking normal controls.
- Some editor areas may not expose stable labels.

Preferred strategy:

1. Start with menus and simple clicks.
2. Avoid complex drag-and-drop in the first demo.
3. If block dragging is needed, use Playwright mouse coordinates only after dry run identifies stable element boxes.
4. Keep camera static if block workspace zoom makes the frame confusing.

## GDevelop sources

### 4ian/GDevelop

URL: https://github.com/4ian/GDevelop

What it is:

GDevelop is the main open-source editor and engine repository. The page describes it as a cross-platform 2D, 3D, and multiplayer game engine.

Why it helps Retake:

- The `newIDE` folder is the editor. It uses JavaScript, React, Electron, PixiJS, and Three.js.
- The repository recently added visual tests that manipulate the editor in a real browser with clicks and drag actions.
- These tests are directly relevant to Retake because they solve similar editor-automation problems.

Best area for Claude to inspect:

```text
newIDE/visual-tests
newIDE/app
```

The GitHub page mentions `newIDE/visual-tests` in a recent commit message. Claude should inspect that folder if it clones the repo.

### GDevelopApp/GDevelop-tutorials

URL: https://github.com/GDevelopApp/GDevelop-tutorials

What it is:

This repo holds official in-app tutorials for the GDevelop editor.

Why it helps Retake:

- It gives ready-made beginner tutorial flows.
- It has an `e2e` folder and scripts for automatic tutorial tests.
- It shows the canonical step-by-step shape of a GDevelop learning flow.

Best use:

Use these tutorials as the story source. Do not invent a walkthrough from scratch if an official in-app tutorial already covers it.

### GDevelopApp/GDevelop-examples

URL: https://github.com/GDevelopApp/GDevelop-examples

What it is:

This repo hosts official free example projects and templates for GDevelop.

Why it helps Retake:

- Use a known example project as stable demo material.
- The repo has gameplay test artifacts and screenshots. Those can help Claude choose clear outcomes for a walkthrough.
- Example projects reduce setup work because the demo can start from a known state.

Best use:

Use an official example project for the first GDevelop demo instead of starting from a blank project.

### GDevelop walkthrough advice

Prefer the web editor if it can run the required flow. Use the desktop app only if the web editor blocks file or project access.

Possible target:

```text
https://editor.gdevelop.io/
```

Good demo idea:

```text
Show a beginner opening a platformer example, adding or inspecting player movement, previewing the game, and seeing the character move.
```

Likely Retake issues:

- The editor is large and menu-heavy.
- Some interactions may involve drag-and-drop or canvas state.
- Login prompts or cloud project prompts can interrupt the flow.
- Electron-only flows may not work through a normal browser page.

Preferred strategy:

1. Use a web editor URL if possible.
2. Use an official example or tutorial to avoid blank-project setup.
3. Put account prompts or project imports in setup, not in visible steps.
4. Split the walkthrough into short videos.
5. Record the visible result, not every configuration step.

## General repos that can help Retake quality

### microsoft/playwright

URL: https://github.com/microsoft/playwright

What it helps with:

- Stable browser automation.
- Locator strategy.
- Codegen for learning selectors.
- Trace viewer for debugging failed interactions.
- MCP and CLI workflows for coding agents.

How Claude should use it:

Use Playwright best practices when Retake selectors fail. Prefer role, label, placeholder, and test id locators before brittle CSS.

### greentfrapp/testreel

URL: https://github.com/greentfrapp/testreel

What it helps with:

Retake uses testreel for recording and cursor rendering.

How Claude should use it:

Inspect testreel behavior when cursor overlay, click timing, or long takes fail. Do not replace Retake with testreel directly.

### ThePatriczek/playwright-recast

URL: https://github.com/ThePatriczek/playwright-recast

What it helps with:

It turns Playwright traces into polished videos. Its useful ideas are speed control, cursor overlay, click effects, subtitles, and trace-based render pipelines.

How Claude should use it:

Borrow ideas only. Do not migrate Retake to this library during the Scratch or GDevelop task.

Useful idea for later:

Compress idle time and network waits while keeping user actions at normal speed.

## What Claude should do now

Use this process for Scratch:

1. Open Retake repo.
2. Read `AGENTS.md`.
3. Use the Scratch hosted GUI URL as the target.
4. Draft a short demo manifest.
5. Run validate.
6. Run dry.
7. Fix selectors until dry passes.
8. Record with `--preset preview-fast`.
9. Read the proof log.
10. Keep the demo under 40 steps.

Use this process for GDevelop:

1. Open Retake repo.
2. Read `AGENTS.md`.
3. Try the GDevelop web editor first.
4. Inspect `GDevelop-tutorials` for a beginner flow.
5. Inspect `GDevelop-examples` for stable example projects.
6. Draft a short demo manifest.
7. Run validate.
8. Run dry.
9. Fix selectors until dry passes.
10. Record with `--preset preview-fast`.
11. Read the proof log.
12. Split the story if it grows past 40 steps.

## Paste-ready prompt for Claude Code

```text
You are working in ~/Documents/Retake.

Goal: use Retake to record walkthrough demos for Scratch and GDevelop.

Read these files first:
- AGENTS.md
- README.md
- docs/gdevelop-scratch-retake-claude-brief.md

Do not build new Retake features for this task. Use the existing Retake agent loop.

Targets:
- Scratch first: https://scratchfoundation.github.io/scratch-gui/develop/
- GDevelop second: https://editor.gdevelop.io/

Task:
1. Create one short Scratch demo manifest.
2. The Scratch story: show a student choosing or using a sprite, adding a simple movement behavior, pressing the green flag, and seeing a visible result.
3. Keep the Scratch demo under 40 steps.
4. Run validate and dry before recording.
5. Fix selectors and waits until dry passes.
6. Record a preview with `npm run retake -- run demos/<name>.yaml --preset preview-fast`.
7. Read `outputs/<name>/proof-log.md` and summarize what worked and what failed.
8. If Scratch works, create one short GDevelop demo manifest.
9. For GDevelop, prefer an official tutorial or example flow. Inspect the relevant upstream repos if needed:
   - https://github.com/4ian/GDevelop
   - https://github.com/GDevelopApp/GDevelop-tutorials
   - https://github.com/GDevelopApp/GDevelop-examples
10. Keep the GDevelop demo short. Show a visible game/editor result.

Rules:
- Do not go straight to `run`. Always validate, then dry-run.
- Prefer durable UI state over toast messages.
- Avoid complex drag-and-drop unless necessary.
- If block or canvas interactions are unreliable, simplify the story.
- If a flow needs login, put it in setup or avoid it.
- If a demo grows long, split it into multiple demos.
- Do not claim success until the proof log and check command confirm it.

Deliverables:
- `demos/scratch-*.yaml`
- `outputs/<scratch-demo>/demo.mp4` if recording succeeds
- proof-log summary
- then the same for GDevelop if Scratch succeeds
```

## Practical call

Start with Scratch because the hosted Scratch GUI is a direct browser target.

Use GDevelop second because it may involve heavier app state, tutorials, examples, or login/project prompts.
