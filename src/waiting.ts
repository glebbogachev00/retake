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

  if (step.minChars) {
    await page.waitForFunction(
      ([sel, n]) => (document.querySelector(sel as string)?.textContent ?? "").trim().length >= (n as number),
      [step.selector, step.minChars] as const,
      { timeout: t },
    );
  }

  if (step.stableMs) {
    // Quiet for this long, measured in the page: the only honest signal that
    // a streamed or animating subtree has finished.
    await page.waitForFunction(
      ([sel, quiet]) => {
        const w = window as unknown as { __retakeStable?: Record<string, number>; __retakeSnap?: Record<string, string> };
        const el = document.querySelector(sel as string);
        if (!el) return false;
        w.__retakeStable ??= {};
        const key = sel as string;
        const now = Date.now();
        const snap = el.innerHTML.length + ":" + (el.textContent ?? "").length;
        const prev = (w.__retakeSnap ??= {});
        if (prev[key] !== snap) { prev[key] = snap; w.__retakeStable[key] = now; return false; }
        return now - (w.__retakeStable[key] ?? now) >= (quiet as number);
      },
      [step.selector, step.stableMs] as const,
      { timeout: t, polling: 100 },
    );
  }
}

/** What this step is waiting for, in the words both surfaces should use. */
export function describeWait(step: WaitStep): string {
  return `wait for ${step.selector}`
    + (step.gone ? " to go" : "")
    + (step.stableMs ? ` to settle (${step.stableMs}ms quiet)` : "")
    + (step.minChars ? ` to hold ${step.minChars}+ chars` : "");
}
