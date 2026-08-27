/**
 * What has actually been checked, and against which recording.
 *
 * "Did the agent verify this, or did it just say so?" had no answer. The
 * checks printed their verdicts into a terminal somebody else was looking at,
 * and nothing on disk remembered that they had run at all — so the window
 * could not tell a demo that had been inspected from one nobody had looked at.
 *
 * Each check drops one line in here when it finishes. It is a record, not a
 * cache: nothing reads it to skip work, and a stale entry is shown as stale
 * rather than believed. Written best-effort — a check must never fail because
 * it could not write its own receipt.
 */
import fs from "node:fs";
import path from "node:path";

export type CheckName = "verify" | "sweep" | "sense" | "fixed";

export type CheckRecord = {
  /** When it ran. */
  at: string;
  /** The take it answered. If this is not the current take, the answer is
      about a recording that no longer exists. */
  takeFinishedAt: string;
  /** Did it pass, where passing means something — verify and fixed gate, sweep
      and sense only report, so theirs is null. */
  ok: boolean | null;
  /** The count that matters for this check: questions answered, frames looked
      at, concerns raised, items still failing. */
  count: number;
  /** One short line a person can read without opening anything. */
  summary: string;
};

export type Checks = Partial<Record<CheckName, CheckRecord>>;

const file = (outDir: string) => path.join(outDir, "checks.json");

export function readChecks(outDir: string): Checks {
  try { return JSON.parse(fs.readFileSync(file(outDir), "utf8")) as Checks; } catch { return {}; }
}

/** Record that a check ran. Never throws: a receipt is not worth a failure. */
export function noteCheck(outDir: string, name: CheckName, r: Omit<CheckRecord, "at">): void {
  try {
    if (!fs.existsSync(outDir)) return;
    const all = readChecks(outDir);
    all[name] = { at: new Date().toISOString(), ...r };
    fs.writeFileSync(file(outDir), JSON.stringify(all, null, 2) + "\n");
  } catch { /* the verdict was still printed */ }
}

/** Is this record about the recording that is there now? */
export const isCurrent = (r: CheckRecord | undefined, takeFinishedAt: string | undefined): boolean =>
  !!r && !!takeFinishedAt && r.takeFinishedAt === takeFinishedAt;
