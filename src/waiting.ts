/**
 * One `waitFor`, for the cheap check and the expensive one.
 *
 * Retake's whole bargain is that `dry` predicts `run`. It cost seconds and it
 * told you whether the take would work — except for the one step whose entire
 * job is knowing when something has actually finished.
 *
 * `dry` waited for the selector and stopped there. `minChars` and `stableMs`
 * were not implemented in it at all. So a manifest that waits for a streamed
 * answer to reach two hundred characters passed `dry` the instant an empty
 * element appeared, and then the real recording sat there for thirty seconds
 * and timed out. The check said yes about a different question from the one
 * the recorder asks.
 *
 * Now there is one implementation. `dry` passes a shorter ceiling, because a
 * dry run that inherits a thirty-second timeout stops being cheap — but it
 * waits for the same conditions, in the same order, and fails for the same
 * reasons.
 */
import type { Page } from "playwright";

export type WaitStep = {
  selector: string;
  timeout?: number;
  gone?: boolean;
  minChars?: number;
  stableMs?: number;
};

/** What a `waitFor` waits for when the manifest does not say. */
export const DEFAULT_WAIT_MS = 30_000;

/**
 * @param cap the longest this is allowed to wait, whatever the step asks for.
 *   `dry` sets it so a slow page cannot turn a seconds-long check into a
 *   minutes-long one; `run` leaves it alone.
 */
export async function waitForStep(page: Page, step: WaitStep, opts: { cap?: number } = {}): Promise<void> {
  const asked = step.timeout ?? DEFAULT_WAIT_MS;
  const t = opts.cap ? Math.min(asked, opts.cap) : asked;

  if (step.gone) {
    await page.waitForSelector(step.selector, { state: "hidden", timeout: t });
    return;
  }
  await page.waitForSelector(step.selector, { timeout: t });

  // `minChars` and `stableMs` used to run `document.querySelector(sel)` inside
  // the page. That parses the string as CSS — and a manifest is allowed to use
  // Playwright's own selectors, so `button:has-text("Buy now")` THREW inside
  // the browser rather than matching. Found by recording a real app, not by a
  // test: dry passed and the take fell over.
  //
  // Resolving through the locator and reading from Node costs a poll every
  // hundred milliseconds — which is what the in-page version did anyway — and
  // works for every selector form Retake accepts.
  const el = page.locator(step.selector).first();
  const deadline = Date.now() + t;
  const left = () => Math.max(0, deadline - Date.now());

  // Read with a real timeout, never the sliver left on the last pass: a read
  // that times out reports nothing, and "it had 0 characters" about an element
  // plainly holding five is a message that sends somebody looking in the wrong
  // place.
  const readWindow = () => Math.max(250, Math.min(1000, left()));

  if (step.minChars) {
    let seen = -1;
    while (left() > 0) {
      const text = await el.innerText({ timeout: readWindow() }).catch(() => null);
      if (text !== null) { seen = text.trim().length; if (seen >= step.minChars) return; }
      await page.waitForTimeout(Math.min(100, left()));
    }
    throw new Error(seen >= 0
      ? `waited ${Math.round(t / 1000)}s for ${step.selector} to hold ${step.minChars}+ characters; it had ${seen}`
      : `waited ${Math.round(t / 1000)}s for ${step.selector} to hold ${step.minChars}+ characters; it never became readable`);
  }

  if (step.stableMs) {
    // Quiet for this long: the only honest signal that a streamed or
    // animating subtree has finished.
    const shape = (n: Element) => `${(n as HTMLElement).innerHTML.length}:${(n.textContent ?? "").length}`;
    let snap: string | null = null, since = Date.now(), everSeen = false, changes = 0;
    while (left() > 0) {
      const now = await el.evaluate(shape, undefined, { timeout: readWindow() }).catch(() => null);
      if (now !== null) {
        everSeen = true;
        if (now !== snap) { snap = now; since = Date.now(); changes++; }
        else if (Date.now() - since >= step.stableMs) return;
      }
      await page.waitForTimeout(Math.min(100, left()));
    }
    throw new Error(everSeen
      ? `waited ${Math.round(t / 1000)}s for ${step.selector} to be quiet for ${step.stableMs}ms; it kept changing (${changes} times)`
      : `waited ${Math.round(t / 1000)}s for ${step.selector} to settle; it never appeared`);
  }
}

/** What this step is waiting for, in the words both surfaces should use. */
export function describeWait(step: WaitStep): string {
  return `wait for ${step.selector}`
    + (step.gone ? " to go" : "")
    + (step.stableMs ? ` to settle (${step.stableMs}ms quiet)` : "")
    + (step.minChars ? ` to hold ${step.minChars}+ chars` : "");
}
