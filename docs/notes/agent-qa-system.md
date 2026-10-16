> **Read this first — 28 August 2026.**
>
> This document was written before the work it proposes was partly done, and
> its opening decision is no longer the one that was taken. It is kept because
> its reasoning is good and most of it still holds, but do not build from line
> 5 without reading this note.
>
> **What changed.** Rather than a separate QA product, the checks were built
> *inside* Retake as optional extensions in `src/ext/`: `verify` (a bounded
> question about one frame), `sweep` (a closed ten-item checklist over every
> frame), `sense` (what went in against what came out), `destroy` (nine ways
> to abuse an existing demo), `flag`/`fixed` (a defect, watched across later
> takes, with the clip that shows it), and `notes`. The reason was
> distribution: agents already reach for Retake, and a second tool is one they
> would forget existed. Recording remains the complete core — `check` consults
> none of these, and `test/ext-boundary.test.ts` enforces that.
>
> **Already built from this document.** The bounded visual questions of §3
> (two of them are `sweep` checklist items verbatim), most of the adversarial
> list in §4 (`destroy`), the trust gates about not passing what was not run
> (`checks.json` receipts) and not passing on a selector alone (the reason
> `verify` exists), and the MCP control surface.
>
> **Deliberately not built.** The issue lifecycle, visual baselines, the
> separate run-review screen, and the agent roster. Retake's checks report
> rather than gate, and no model-based check has a measured false-positive
> rate yet — until it does, none of them should be a release decision.
>
> **Still the right target.** The acceptance test at the bottom of this file:
> seed a defect, and if the run comes back clean the system has failed however
> good it looks.

# Agent QA System

## Decision

Build a separate QA product that shares execution infrastructure with Retake.
Do not turn Retake into a release gate.

Retake answers: “Can we produce a reliable demonstration?”
The QA product answers: “Should this code be allowed to ship?”

Retake already provides useful primitives: browser actions, manifests, dry runs,
screenshots, proof logs, and an MCP route. The QA product adds a different
product layer: test contracts, hard-case coverage, assertions, regression
history, issue lifecycle, and release decisions.

## Product job

Make an agent test a web app like a careful human before the agent claims that a
change works.

The success signal is a replayable test run with evidence for every scenario and
an issue record for every failed assertion.

## The test contract

A test pack describes a user flow and its hard cases. Each scenario contains:

- a clean starting state
- the user goal
- the actions to perform
- the expected visible result
- the expected application state
- visual checkpoints
- negative cases
- a cleanup step
- a severity if the scenario fails

A scenario is not complete because the agent reached the final URL. It is
complete when the expected result and the expected state both pass.

## Example scenario

```yaml
name: capture-mixed-action
starting_state: empty-board
risk: high
steps:
  - capture: "Fix the signup bug before Friday and call the vet tomorrow"
  - wait_for: ".record-result"
  - screenshot: record-result
assertions:
  - visible: "two actions"
  - visible: "different due dates"
  - absent: "duplicate action"
  - state: actions.count == 2
  - state: actions[0].due != actions[1].due
hard_cases:
  - reload during processing
  - submit twice quickly
  - provider failure
  - long input
  - phone viewport
severity: high
```

The exact schema can grow later. Start with the smallest contract that expresses
one real failure.

## Test layers

Visual testing alone is not enough. Use four layers in order.

### 1. Mechanical checks

Run selectors, waits, navigation checks, console checks, network checks, and
basic accessibility checks without using a model.

### 2. Behavioral assertions

Check the result through the user-visible interface and, where safe, through a
read-only application state endpoint or exported artifact.

### 3. Visual assertions

Capture screenshots at meaningful checkpoints. Compare the current screen with
an approved baseline or ask a vision model targeted questions:

- Is the primary action visible?
- Is any content clipped or overlapping?
- Does the result match the preceding action?
- Is the empty state still visible after data arrives?
- Does the layout work at the phone viewport?

A vision model should answer a bounded question. Do not ask it to vaguely “look
at the app.”

### 4. Adversarial passes

Run cases that agents and developers often miss:

- empty input
- very long input
- repeated submission
- slow response
- failed provider
- refresh during a request
- back navigation
- duplicate records
- stale success message
- small phone viewport
- keyboard open on phone
- missing image or attachment
- first use with no existing data

## Agent workflow

1. Read the test pack and the current change.
2. Start the app in an isolated environment.
3. Seed the declared starting state.
4. Run the cheap mechanical checks.
5. Execute each scenario through the real browser.
6. Take screenshots at declared checkpoints.
7. Run behavioral and visual assertions.
8. Save the exact URL, viewport, actions, screenshots, console output, and result.
9. Create or update an issue for each unique failure.
10. Stop when the pack passes or the run reaches its failure budget.

The agent must not silently skip a scenario. A skipped scenario is a failed
run with a stated reason.

## Issue record

Each issue must include:

- short title
- severity
- scenario name
- exact reproduction steps
- expected result
- actual result
- URL and viewport
- screenshot or video evidence
- console and network evidence when relevant
- suspected area, if known
- run identifier
- whether the issue is new, known, fixed, or not reproduced

The issue system can start as Markdown or JSON in the Retake output. Add a GitHub
or Linear adapter only after the local report is reliable.

## Agent roles

Keep the roles narrow.

- **Planner:** selects the test pack from the changed area.
- **Driver:** performs the browser actions.
- **Observer:** checks visual and behavioral assertions.
- **Reporter:** deduplicates failures and creates issue records.
- **Fixer:** works only from a confirmed issue and its evidence.
- **Verifier:** reruns the original scenario and the relevant regression pack.

The driver and observer may be one process at first. The important separation is
between changing the app and judging the change.

## MCP boundary

MCP is the control surface, not the product.

Expose tools such as:

- list test packs
- run a test pack
- run one scenario
- inspect the live browser
- inspect the latest screenshot
- read the proof log
- create an issue record
- rerun a failed scenario
- mark a baseline approved

The agent calls these tools. Retake owns execution, evidence, and repeatability.
The agent should not need to invent browser commands or remember the testing
protocol from a prompt.

## Visual side

The visual interface should be a run review screen, not a general dashboard.

Show:

- the test pack name
- a scenario list with pass, fail, blocked, and skipped states
- the current browser viewport
- the expected checkpoint beside the actual checkpoint
- the issue created from a failure
- a replay button
- the proof bundle

The most important screen is the failed scenario. It should answer in seconds:

> What did the agent do, what should have happened, what happened instead, and
> can I replay it?

Keep agent logs behind the proof view.

## Trust gates

The system must enforce these rules:

- An agent cannot mark a test as passed without running it.
- A visual checkpoint cannot pass only because the DOM contains a selector.
- A skipped scenario cannot produce an overall pass.
- A changed app requires a fresh run.
- A fix requires the original failure to reproduce before the patch and pass after
  the patch.
- The fixer cannot merge or deploy without explicit approval.

## First build

Build one Retake QA command that runs a Capture test pack at a phone viewport.
Use five scenarios:

1. first capture
2. mixed capture with two different dates
3. provider failure with no lost input
4. rapid duplicate submission
5. reload during processing

The first version needs only local proof files, screenshots, and a structured
issue report. Do not build a polished issue tracker or a large agent roster.

## Acceptance test

The first version is successful when an agent can run the five scenarios against
Capture, find at least one deliberately seeded defect, produce evidence that a
human can review, and rerun the scenario after a fix.

If the agent reports a clean run while the seeded defect remains, the QA system
has failed, regardless of how attractive its UI looks.
