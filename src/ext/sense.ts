/**
 * Does the run add up.
 *
 * `verify` judges one frame: is the button readable, is the card inside its
 * box. This judges the whole run: what went IN against what came OUT.
 *
 * The bug that produced it: an Avex demo entered two legs — SGN→SIN and
 * SIN→SGN — and quoted a single price of 17,400. Nothing caught it. Every
 * step passed, every frame looked fine, and the take recorded both halves:
 *
 *     type "SGN" → #leg-from-0      type "SIN" → #leg-to-0
 *     type "SIN" → #leg-from-1      type "SGN" → #leg-to-1
 *     type "17400" → [data-op-field='price']
 *
 * The evidence was on disk the whole time and nothing read it. So this reads
 * it: the ordered list of everything a run typed, chose and clicked, plus the
 * frames, put to a reader with six bounded lenses.
 *
 * It ASKS, it does not fail. `verify` answers a question about a picture and
 * can be sure of the answer, so it gates — exit 3. Whether a number adds up
 * is judgement, and a false FAIL on judgement is how a check gets switched
 * off. So sense raises questions a person settles in two seconds, and the
 * exit code stays 0.
 */
import fs from "node:fs";
import path from "node:path";
import type { Manifest } from "../manifest.js";
import type { Take } from "../record.js";
import { ask, pickJudge, readJson, why as short } from "./judge.js";
import { noteCheck } from "./checked.js";
import { NO_INTENT_NOTE, intentBlock } from "./intent.js";
import { tag, type Evidence } from "./evidence.js";
import { endProgress, setPhase } from "../progress.js";

/** How many frames one judgement is allowed. A 37-scene demo does not get 37
    images; it gets an even spread including the first and last, and is told
    out loud that it was sampled. A cap nobody mentions reads as coverage. */
export const FRAME_BUDGET = 12;

export type Concern = {
  /** Which of the six lenses caught it — named so a person can dismiss a
      whole category at a glance. */
  lens: string;
  /** The scene it points at, when it points at one. */
  scene?: string;
  /** Phrased as a question, deliberately. */
  question: string;
  /** What in the run made it ask — an input, a frame, a number. */
  saw: string;
};
/** sense reads what the run recorded against the frames it produced. */
export const SENSE_EVIDENCE: Evidence = "read-from-the-run";

export type Sense = { concerns: Concern[]; judge: string; lines: string[]; sampled: { used: number; of: number } };

const INPUT_ACTIONS = new Set(["type", "fill", "select", "upload", "click", "keyboard", "drag"]);

/** What the run actually did, in order, grouped under the scene it happened
    in. This is the half nothing has ever looked at. */
export function story(take: Take): { scene: string; did: string[] }[] {
  const out: { scene: string; did: string[] }[] = [];
  let cur: { scene: string; did: string[] } = { scene: "(before the first scene)", did: [] };
  for (const t of take.timeline) {
    if (t.action === "scene") {
      if (cur.did.length) out.push(cur);
      cur = { scene: (t as { label?: string }).label ?? "scene", did: [] };
      continue;
    }
    if (!INPUT_ACTIONS.has(t.action)) continue;
    const s = (t.summary ?? "").trim();
    if (s) cur.did.push(s + (t.ok ? "" : "   ← THIS STEP FAILED"));
  }
  if (cur.did.length) out.push(cur);
  return out;
}

/** One still per scene, capped, evenly spread, first and last always kept. */
export function frames(outDir: string, take: Take, budget = FRAME_BUDGET): { used: { scene: string; file: string }[]; of: number } {
  const dir = path.join(outDir, "stills");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).sort(); } catch { return { used: [], of: 0 }; }
  const scenes = take.timeline.filter((t) => t.action === "scene").map((t) => (t as { label?: string }).label ?? "");
  const all: { scene: string; file: string }[] = [];
  scenes.forEach((label, i) => {
    const n = String(i + 1).padStart(2, "0");
    const hit = files.find((f) => f.startsWith(n) && f.includes(label) && f.includes("-end.")) ?? files.find((f) => f.startsWith(n) && f.includes(label));
    if (hit) all.push({ scene: label, file: path.join(dir, hit) });
  });
  if (all.length <= budget) return { used: all, of: all.length };
  const step = (all.length - 1) / (budget - 1);
  const picked = Array.from({ length: budget }, (_, i) => all[Math.round(i * step)]);
  return { used: [...new Map(picked.map((p) => [p.file, p])).values()], of: all.length };
}

/** The six lenses. "Does it make sense" is a wish; these are questions.
    Every one of them is a shape a real bug has taken in this project. */
const LENSES = [
  "QUANTITY — n things went in; does what came out account for n of them? (Two legs entered, one price shown. Three guests added, a total for one.)",
  "CONTINUITY — a name, date, amount or choice entered early: does it still read the same later, in the summary, the confirmation, the receipt?",
  "STATE — an action was taken; did the screen actually move? A button pressed and the same message still sitting there is the bug.",
  "UNITS AND LABELS — per-item or total, per-person or party, which currency, whose timezone, one-way or return. A number with the wrong label is wrong.",
  "ORDER — does anything arrive before the thing it depends on? A confirmation ahead of the input it confirms, a summary before there is anything to summarise.",
  "DEAD ENDS — a step that produced nothing visible, or a final screen with nowhere to go from.",
];

function prompt(m: Manifest, told: { scene: string; did: string[] }[], shots: { scene: string; file: string }[], of: number, demosDir: string): string {
  return [
    intentBlock(demosDir, m.name),
    `A browser recording of a web app called "${m.title ?? m.name}" was made. You are checking whether the run ADDS UP — not whether it looked pretty, and not whether the steps ran (they did).`,
    "",
    "EVERYTHING THE RUN ENTERED, CHOSE AND CLICKED, in order:",
    ...told.map((s) => [`  [${s.scene}]`, ...s.did.map((d) => `    ${d}`)].join("\n")),
    "",
    shots.length
      ? `THE FRAMES: ${shots.length} screenshot${shots.length === 1 ? "" : "s"}${of > shots.length ? ` — an even sample of ${of} scenes, so you are NOT seeing every moment` : ""}, in order: ${shots.map((s) => s.scene).join(" → ")}`
      : "THE FRAMES: none were saved for this run — judge from the inputs alone, and say so.",
    "",
    "Look through these six lenses and nothing else:",
    ...LENSES.map((l) => `  · ${l}`),
    "",
    "Answer with one line of JSON and nothing else:",
    `{"concerns":[{"lens":"QUANTITY","scene":"<label or empty>","question":"<what you would ask the person who built this>","saw":"<the input or the thing in the frame that made you ask>"}]}`,
    "",
    "Rules. Raise something ONLY if you can point at the input or the frame that made you ask — quote it in `saw`. If the run adds up, answer {\"concerns\":[]}; an empty list is a good answer and the expected one for a healthy run. Do not raise style, wording, spacing, colour or anything a person would call taste — another check covers that. Do not raise something a frame merely fails to show; you are sampling. Phrase each one as a question, because you may be wrong. At most six.",
  ].join("\n");
}

type Raw = { concerns: unknown[] };
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && Array.isArray((v as Raw).concerns);

export function sense(m: Manifest, outDir: string, log?: (l: string) => void, demosDir = "demos"): Sense {
  const lines: string[] = [];
  const say = (l: string) => { lines.push(l); log?.(l); };

  let take: Take | null = null;
  try { take = JSON.parse(fs.readFileSync(path.join(outDir, "take.json"), "utf8")) as Take; } catch { /* not recorded */ }
  if (!take) {
    say("no take.json — record it first; sense reads what a run actually did.");
    return { concerns: [], judge: "none", lines, sampled: { used: 0, of: 0 } };
  }

  const told = story(take);
  if (!told.length) {
    say("this run entered nothing — there is no input to check the output against.");
    return { concerns: [], judge: "none", lines, sampled: { used: 0, of: 0 } };
  }

  const { used, of } = frames(outDir, take);
  const { provider, name: judge, why: noJudge } = pickJudge();
  if (!provider) {
    // Advisory, so this is a note and not a failure — but it must never read
    // as "checked, fine".
    say(`could not check: ${noJudge}`);
    return { concerns: [], judge, lines, sampled: { used: 0, of } };
  }

  const entered = told.reduce((n, s) => n + s.did.length, 0);
  if (!intentBlock(demosDir, m.name)) say(`  ${NO_INTENT_NOTE}`);
  say(`reading ${entered} recorded action${entered === 1 ? "" : "s"} against ${used.length} frame${used.length === 1 ? "" : "s"}${of > used.length ? ` (sampled from ${of} scenes)` : ""} with ${judge}`);

  setPhase(outDir, { demo: m.name, phase: "sensing", label: "checking the run adds up" });
  let raw: Raw | null = null;
  try {
    raw = readJson(ask(provider, prompt(m, told, used, of, demosDir), used.map((u) => u.file)), isRaw);
  } catch (e) {
    say(`could not check: the judge failed — ${short(e)}`);
    return { concerns: [], judge, lines, sampled: { used: used.length, of } };
  }
  if (!raw) {
    say("could not check: no usable answer from the judge.");
    return { concerns: [], judge, lines, sampled: { used: used.length, of } };
  }

  const concerns: Concern[] = [];
  for (const c of raw.concerns.slice(0, 6)) {
    const o = c as Partial<Concern>;
    if (!o?.question) continue;
    concerns.push({ lens: (o.lens ?? "").toString().slice(0, 24) || "—", scene: o.scene?.toString() || undefined, question: o.question.toString(), saw: (o.saw ?? "").toString() });
  }

  endProgress(outDir);
  noteCheck(outDir, "sense", {
    takeFinishedAt: take.finishedAt, ok: null, count: concerns.length,
    summary: concerns.length ? `${concerns.length} question${concerns.length === 1 ? "" : "s"}` : "the run adds up",
  });
  if (!concerns.length) {
    say("the run adds up — nothing to ask about.");
    if (of > used.length) say(`(${of - used.length} of ${of} scenes were not looked at — this is a sample, not a sweep.)`);
    return { concerns, judge, lines, sampled: { used: used.length, of } };
  }

  say("");
  for (const c of concerns) {
    say(`?  ${tag(SENSE_EVIDENCE)} ${c.lens}${c.scene ? ` · ${c.scene}` : ""}`);
    say(`   ${c.question}`);
    if (c.saw) say(`   saw: ${c.saw}`);
  }
  say("");
  say(`${concerns.length} question${concerns.length === 1 ? "" : "s"}, not ${concerns.length === 1 ? "a verdict" : "verdicts"} — settle them and re-run, or ignore them.`);
  if (of > used.length) say(`(${of} scenes, ${used.length} looked at.)`);
  return { concerns, judge, lines, sampled: { used: used.length, of } };
}
