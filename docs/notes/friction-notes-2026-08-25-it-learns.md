# Retake friction: `it-learns` recording

Date: 2026-08-25

This file records issues found during two new `it-learns` recordings. Each issue has a status. Do not treat Capture behavior as a Retake defect.

## 1. `dry` does not save a failure screenshot

**Status:** Confirmed Retake gap.

**Observed:** A `click` step timed out because the Capture button was disabled. `dry` printed page text but saved no `failed-step.png`.

**Cost:** The text did not show whether another element covered the button. It also did not show the current layout.

**Workaround:** Read the page text and replace transient waits with durable result selectors.

**Possible fix:** Save a full-page screenshot for every failed `dry` step. Print its path next to the error.

## 2. A visible selector can match stale state

**Status:** Confirmed workflow gap. This repeats the stable-wait issue in the main audit notes.

**Observed:** `waitFor .landed` matched the prior success banner after a correction started. Retake then reached the next `click` while the app was still busy.

**Cost:** The next click timed out on a visible but disabled button.

**Workaround:** Wait for the durable result, such as the first thread card, instead of the banner.

**Possible fix:** Add a stable-state wait. For example, support `waitFor: { selector, stableMs }` and `waitForHidden`.

## 3. `check` passed a video that ended on an app error screen

**Status:** Confirmed Retake gap.

**Observed:** `it-learns-teach-final` passed all Retake checks. At 15.5 seconds, the app showed “This page couldn’t load.” The error remained through the last frame.

**Cause:** A manifest script removed React-owned nodes. A later React update caused the app to fail. The manifest now hides the nodes with CSS instead.

**Cost:** The proof log and thumbnail looked correct. Only direct frame review found the broken ending.

**Workaround:** Extract and inspect frames near the end of every final MP4.

**Possible fix:** Record page errors and unhandled exceptions during the full take. Fail `check` when an error occurs after the last step. Also compare the last frame with common browser and app error states.

## 4. The first sort is not deterministic

**Status:** Capture behavior, not a Retake defect.

**Observed:** The same gym sentence became an action in one dry run and a thread in another dry run.

**Cost:** The correction choice changed between runs. A manifest could not select one fixed correction button.

**Workaround:** Stub only the first `/api/sort` response. Keep the later learned-rule result real and deterministic. Retake must name the stub in the proof log.

**Possible product rule:** A published demo must not depend on a model returning one exact category. Use a declared stub or a deterministic application state.
