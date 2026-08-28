/**
 * How a finding was arrived at.
 *
 * The failure this exists for: an agent reads code, forms a view, and reports
 * it in the same voice it would use for something it had watched happen. The
 * reader cannot tell which is which, so either they trust both — and act on a
 * guess — or they trust neither, and the real finding is wasted.
 *
 * So every finding says how it was come by. Not how confident anybody feels,
 * which is unfalsifiable, but what was actually done to produce it: a frame
 * that was looked at, a flow that was performed, a file that was read.
 *
 * The order below is the order of strength, and the labels are meant to be
 * read by somebody who does not know how Retake works.
 */

export type Evidence =
  /** It was performed. The app really did this, and it can be done again. */
  | "reproduced"
  /** It is in a frame the run produced. Somebody can open the picture. */
  | "seen-in-a-frame"
  /** It follows from what the run recorded — what went in against what came
      out — rather than from any single picture. */
  | "read-from-the-run"
  /** It comes from reading the source. Nothing was run, nothing was seen. */
  | "source-only"
  /** Nothing has been done to check it yet. Worth saying; not worth acting on. */
  | "unverified";

export const EVIDENCE_ORDER: Evidence[] = ["reproduced", "seen-in-a-frame", "read-from-the-run", "source-only", "unverified"];

/** In the words of somebody who has never read Retake's source. */
export const EVIDENCE_WORDS: Record<Evidence, string> = {
  "reproduced": "done, and it can be done again",
  "seen-in-a-frame": "visible in a recorded frame",
  "read-from-the-run": "follows from what the run recorded",
  "source-only": "from reading the code — nothing was run",
  "unverified": "not checked",
};

/** Strongest first, so a report leads with what was actually observed. */
export const strongestFirst = <T extends { evidence: Evidence }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => EVIDENCE_ORDER.indexOf(a.evidence) - EVIDENCE_ORDER.indexOf(b.evidence));

/** The tag a report prints beside a finding. */
export const tag = (e: Evidence): string => `[${e}]`;

/**
 * A line explaining the tags, for a report a person reads once.
 * Only the kinds actually present, so it never lectures.
 */
export function legend(used: Evidence[]): string {
  const seen = EVIDENCE_ORDER.filter((e) => used.includes(e));
  if (!seen.length) return "";
  return seen.map((e) => `${tag(e)} ${EVIDENCE_WORDS[e]}`).join("  ·  ");
}
