# Contributing

Retake is small on purpose. The best contribution is a manifest that breaks
it, with the proof log attached.

## Setup

```bash
git clone https://github.com/glebbogachev00/retake && cd retake
npm install                   # builds dist/ too
npm test                      # 400+ checks; several drive a real browser
npm run retake -- ui          # the window, at http://localhost:4310
```

The browser downloads itself the first time something needs it (into
Retake's own folder, so another project's Playwright cannot delete it). In
the window, paste any public URL to record a first demo.

`npm run retake -- …` runs `src/` through tsx. `node dist/cli.js …` is what the
npm package ships. Same code; the only difference is `src/paths.ts` deciding
how to spawn child processes.

## Before you open a PR

```bash
npm run typecheck
npm test
npm run build && node dist/cli.js --help
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
- The **UI** is one http server and one HTML file (`src/ui/chat.html`) with
  no build step. Keep it that way; it is a window onto the work, not the
  product.

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

None ship: a new workspace starts empty so the window's first run can guide
someone to their own app. To try a change, record a public site from the
window, or the small pages in `test/fixtures/` (served by the tests that use
them). Manifests and outputs for private apps are gitignored; keep them
that way.

## Notes

`docs/notes/` holds working notes written while building Retake. They are a
record of why things are the way they are, not current documentation.
