/**
 * The verdict: did the app LOOK right, not did the steps execute.
 *
 * Every check Retake had before this proves something about the run — the
 * step passed, the file is 1920 wide, no scene stalled. None of them can see
 * that an animation froze half-drawn, that an icon 404'd, that a card fell
 * out of its grid, or that a label is dark text on a dark pill. All four of
 * those shipped from this repository in one day, every one DOM-correct and
 * visually wrong, and every one caught by a person looking rather than by
 * anything the tool did.
 *
 * So the tool looks. A scene declares, in plain words, what somebody should
 * be able to see at that moment; verify puts that question to a vision model
 * against the scene's own still and returns a verdict the caller cannot
 * manufacture. An agent can forget a rule written in a document. It cannot
 * forget to run the verb it is being asked to run, and it cannot claim the
 * picture was fine when a second reader has already said otherwise.
 *
 * The judging is deliberately NOT done by whoever asked for it: the agent
 * that built the thing has an investment in the answer. This asks a separate
 * reader holding only the question and the image.
 */
import fs from "node:fs";
import path from "node:path";
import type { Manifest } from "../manifest.js";
import type { Take } from "../record.js";
import { askAsync, pickJudge, pool, readJson, why as short } from "./judge.js";
import { readFlags } from "./flags.js";
import { NO_INTENT_NOTE, intentBlock } from "./intent.js";
import { tag, type Evidence } from "./evidence.js";
import { noteCheck } from "./checked.js";
import { endProgress, setPhase } from "../progress.js";
import type { Provider } from "../describe.js";

export type Answer = {
  scene: string;
  question: string;
  /** null when nothing could judge it — which is a FAILURE, never a pass. */
  ok: boolean | null;
  why: string;
  still: string;
};
/** Every answer verify gives was read off a frame this run produced. */
export const VERIFY_EVIDENCE: Evidence = "seen-in-a-frame";

export type Verdict = { ok: boolean; answers: Answer[]; judge: string; lines: string[] };

/** The still to ask about: a scene's END frame, because "did it happen" is
    almost always the question, and the middle of a scene is mid-motion. */
export function stillFor(outDir: string, label: string, index: number): string | null {
  const dir = path.join(outDir, "stills");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const n = String(index + 1).padStart(2, "0");
  const end = files.find((f) => f.startsWith(n) && f.includes(label) && f.includes("-end."));
  const mid = files.find((f) => f.startsWith(n) && f.includes(label));
  const any = end ?? mid;
  return any ? path.join(dir, any) : null;
}

/** Where a scene sits among the scenes, which is how the stills are numbered. */
export function sceneIndexOf(m: Manifest, label: string): number {
  return m.steps.filter((s) => s.action === "scene").findIndex((s) => (s as { label: string }).label === label);
}

/** Every question this manifest asks, paired with the frame that answers it. */
export function questions(m: Manifest, outDir: string): { scene: string; question: string; still: string | null }[] {
  const out: { scene: string; question: string; still: string | null }[] = [];
  let sceneIndex = 0;
  for (const st of m.steps) {
    if (st.action !== "scene") continue;
    const here = sceneIndex++;
    const exp = (st as { expect?: string | string[] }).expect;
    if (!exp) continue;
    const label = (st as { label: string }).label;
    for (const q of Array.isArray(exp) ? exp : [exp]) {
      out.push({ scene: label, question: q, still: stillFor(outDir, label, here) });
    }
  }
  return out;
}

/**
 * Describe first, then judge.
 *
 * Measured on a real frame: asked "does the layer count sit clear of the card
 * below it", the judge answered yes — on the exact frame where `sweep` had
 * already found the overlap. Twice, on two phrasings. A question that invites
 * confirmation gets confirmed; that is the same bias that made a person miss
 * the bug in the first place, reproduced inside the checker.
 *
 * So the answer has to carry what was actually seen at that spot BEFORE the
 * verdict, which forces looking rather than agreeing.
 */
const PROMPT = (question: string, demosDir = "demos", demo?: string) =>
  intentBlock(demosDir, demo) +
  `Look at this screenshot of a web app and answer one question about it.\n\n` +
  `QUESTION: ${question}\n\n` +
  `First describe, in one sentence, exactly what is at the place the question is about — the real text, and how it sits against the things around it. Then answer.\n\n` +
  `Answer with a single line of JSON and nothing else:\n` +
  `{"saw": "<what is actually there>", "ok": true|false, "why": "<one short sentence>"}\n\n` +
  `Rules: judge ONLY what is visible in this image. If the thing asked about is ` +
  `not visible, or is present but unreadable, cut off, overlapping, or blank, ` +
  `answer false and say so. The question is not a hint that the answer is yes — ` +
  `it is as likely to be describing something that is broken. Do not assume it ` +
  `is fine because it probably is. Do not be generous.`;

export async function judgeWith(p: Provider, still: string, question: string, demosDir = "demos", demo?: string): Promise<{ ok: boolean | null; why: string }> {
  try {
    return readAnswer(await askAsync(p, PROMPT(question, demosDir, demo), [still], 120_000), p.name);
  } catch (e) {
    return { ok: null, why: `judge failed: ${short(e)}` };
  }
}

type Said = { ok: boolean; why?: string; saw?: string };
const isSaid = (v: unknown): v is Said => !!v && typeof v === "object" && typeof (v as Said).ok === "boolean";

/** Read a verdict out of whatever the CLI printed. */
function readAnswer(out: string, who: string): { ok: boolean | null; why: string } {
  const said = readJson(out, isSaid);
  if (!said) return { ok: null, why: `no usable answer from ${who}` };
  const why = (said.why ?? "").trim();
  const saw = (said.saw ?? "").trim();
  // Both, when they differ: what it saw is how you catch a wrong verdict.
  return { ok: said.ok, why: [saw, why].filter(Boolean).join(" — ") || "(no reason given)" };
}

/** Exposed for the test: reading a verdict out of whatever a CLI printed is
    the part that silently turns a real answer into "could not answer". */
export function __test_readAnswer(out: string) { return readAnswer(out, "test"); }

export async function verify(m: Manifest, outDir: string, log?: (l: string) => void, manifestFile?: string, concurrency = 4): Promise<Verdict> {
  const lines: string[] = [];
  const say = (l: string) => { lines.push(l); log?.(l); };
  const qs = questions(m, outDir);
  // Things flagged as really wrong are checked here too, so `verify` is one
  // answer and not two. They live in a ledger rather than in the manifest —
  // see flags.ts for why nothing writes to a file a person wrote.
  if (manifestFile) {
    for (const f of readFlags(manifestFile)) {
      if (qs.some((q) => q.scene === f.scene && q.question === f.expect)) continue;
      qs.push({ scene: f.scene, question: f.expect, still: stillFor(outDir, f.scene, sceneIndexOf(m, f.scene)) });
    }
  }

  if (!qs.length) {
    say("no `expect` on any scene — nothing to verify.");
    say("Add one to a scene: expect: \"the board shows two items\" — a question answerable yes/no from one frame.");
    return { ok: true, answers: [], judge: "none", lines };
  }

  const take = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(outDir, "take.json"), "utf8")) as Take; } catch { return null; }
  })();
  if (!take) {
    say("FAIL  no take.json — record it first; verify judges the frames a run produced.");
    return { ok: false, answers: [], judge: "none", lines };
  }

  const { provider, name: judge, why: noJudge } = pickJudge();
  if (!provider) {
    // A check that could not run is not a check that passed.
    say("FAIL  nothing available to look at the frames.");
    say(`      ${noJudge}`);
    return { ok: false, answers: qs.map((q) => ({ scene: q.scene, question: q.question, ok: null, why: "no judge available", still: q.still ?? "" })), judge, lines };
  }

  if (!intentBlock("demos", m.name)) say(`  ${NO_INTENT_NOTE}`);
  say(`judging ${qs.length} question(s) with ${judge}`);
  // A few at a time. Serially, a demo with thirty-four expectations took six
  // minutes to answer — long enough that an agent skips it, which makes the
  // check worthless however good it is.
  setPhase(outDir, { demo: m.name, phase: "verifying", step: 0, of: qs.length, label: "answering what the scenes ask" });
  let asked = 0;
  const answers: Answer[] = await pool(qs, Math.max(1, concurrency), async (q): Promise<Answer> => {
    if (!q.still) return { scene: q.scene, question: q.question, ok: null, why: "no still for that scene — was it recorded?", still: "" };
    const a = await judgeWith(provider, q.still, q.question, "demos", m.name);
    setPhase(outDir, { phase: "verifying", step: ++asked, of: qs.length, label: q.scene });
    return { scene: q.scene, question: q.question, ok: a.ok, why: a.why, still: q.still };
  });
  // Printed in manifest order after the fact, so the report reads down the
  // demo rather than in whatever order the answers came back.
  for (const a of answers) {
    const mark = a.ok === true ? "pass" : "FAIL";
    say(`${mark}  ${tag(VERIFY_EVIDENCE)} [${a.scene}] ${a.question}\n      ${a.why}${a.ok !== true ? `\n      look: ${a.still ? path.relative(process.cwd(), a.still) : "(no still)"}` : ""}`);
  }

  // null counts as failure, deliberately: a question nobody could answer has
  // not been answered, and reporting it as a pass is the exact lie this verb
  // exists to make impossible.
  const ok = answers.every((a) => a.ok === true);
  const yes = answers.filter((a) => a.ok === true).length;
  say(ok ? `verify: pass (${answers.length}/${answers.length})` : `verify: FAIL (${yes}/${answers.length} answered yes)`);
  endProgress(outDir);
  noteCheck(outDir, "verify", { takeFinishedAt: take.finishedAt, ok, count: answers.length, summary: ok ? `${answers.length} answered yes` : `${yes} of ${answers.length} answered yes` });
  return { ok, answers, judge, lines };
}
