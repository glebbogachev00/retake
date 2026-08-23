# Contributing

Retake is small on purpose. The best contribution is a manifest that breaks
it, with the proof log attached.

## Setup

```bash
git clone https://github.com/glebbogachev00/retake && cd retake
npm install                   # builds dist/ too
npx playwright install chromium
npm run retake -- run demos/todo-basics.yaml --preset draft
```

`npm run retake -- …` runs `src/` through tsx. `node dist/cli.js …` is what the
npm package ships. Same code; the only difference is `src/paths.ts` deciding
how to spawn child processes.

## Before you open a PR

```bash
npm run typecheck
npm test
npm run build && node dist/cli.js validate demos/example.yaml
```

CI runs exactly that. There is no lint step; match the surrounding code.

## What goes where

- A new **step type or manifest field** touches `manifest.ts` (schema),
  `record.ts` (do it), `dryrun.ts` (prove it resolves without a camera), and
  a line in `README.md`. If an agent needs to know about it, also `AGENTS.md`
  and `skill/SKILL.md` — those two are the tool's instructions to itself.
- A new **MCP tool** lives in `src/operator/tools.ts`. Tool descriptions are
  read by models, not people: say what it returns and when *not* to call it.
- **Render-time** things (captions, camera, layout, speed) go in `render.ts`
  and must stay render-time — never make the browser run again for them.
- The **UI** is one http server and three HTML files with no build step. Keep
  it that way; it is a window onto the work, not the product.

## Principles that have held up

- The cheap check comes before the expensive one: `validate` → `dry` → `run`.
- Failures are text. An agent fixes a take from the proof log, never from
  watching the video.
- Never save a session after a failed sign-in; never put a secret in a manifest.
- If Retake itself breaks (ffmpeg, Playwright), stop and say so — don't patch
  around the tool inside a demo.
- Don't start the user's app, restart a server, or touch their git without
  being asked. `RETAKE_ALLOW_START=1` is the only exception, and it's theirs
  to set.

## Demos in this repo

`demos/` ships a few public manifests (TodoMVC, saucedemo, Scratch, GDevelop)
so anyone can record something without setting up an app. Manifests for
private apps are gitignored by pattern; add yours to the allow-list in
`.gitignore` only if the app is public.
