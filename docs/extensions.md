# The core and its edges

Retake's core is one sentence: **drive a real browser to a known state and
prove what happened.** That is `manifest.ts`, `record.ts`, `dryrun.ts`.

Everything else hangs off it. Video is one edge. The checks are others. None of
them is the core, and the core must not know any of them exists.

## The rule

```
src/ext/  may import from the core
the core  may never import from src/ext/
```

Only three files are allowed to name an extension: `src/cli.ts`,
`src/operator/tools.ts`, `src/ui/server.ts` — the places a person or an agent
asks for something by name.

`test/ext-boundary.test.ts` enforces this, including transitively: it walks the
whole import graph out from the recorder and fails if anything under `ext/`
is reachable. Without that test this is a folder, not an architecture.

## The contract

An extension:

- **reads what a run left behind** — takes, stills, manifests;
- **never renders** — importing the renderer, the card machinery, captions,
  voice or ffmpeg is a test failure;
- **never writes into an existing demo's output.** `destroy` is the only one
  that writes at all, and everything it writes goes under
  `outputs/.destroy/<demo>/`, which cannot reach `outputs/<demo>/`.

An extension may ask the core to do work — `destroy` calls `dryRun` and
`record`, because trying a candidate means actually driving the app. What it
cannot do is produce a video, and what it cannot touch is a take you already
have.

## Absent has to work

`rm -rf src/ext` and `retake run` still records. That is the property, and it
is tested rather than promised. Anything that would break if an extension were
missing belongs in the core, not in `ext/`.

## What lives there today

| | asks | gates? |
|---|---|---|
| `verify.ts` | does one frame LOOK right — each scene's `expect` | yes, exit 3 |
| `sense.ts` | does the whole run ADD UP — input against output | no, it asks |
| `destroy.ts` | what happens just off the happy path | flags, a person judges |
| `notes.ts` | what keeps going wrong across every demo | no |
| `judge.ts` | (shared) the reader that can see a picture | — |

## Adding one

1. Put it in `src/ext/`, exporting one function that takes what a run left
   behind and returns a result plus the lines to print.
2. Give it a CLI verb in `cli.ts` and an MCP tool in `operator/tools.ts`. Those
   are the only two files that may name it.
3. Write it into `skill/SKILL.md` — an extension an agent does not know about
   is an extension nobody runs.
4. Decide, explicitly, whether it gates. Something that can be sure of its
   answer may set `process.exitCode = 3`. Something making a judgement call
   must not: a false failure on judgement is how a check gets switched off.
