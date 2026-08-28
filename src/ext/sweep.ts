/**
 * Look at the frame, not at the thing you changed.
 *
 * This exists because of a specific miss, described precisely by the person
 * who made it: *"What went wrong wasn't attention, it was method. I was
 * checking each frame against the thing I had just changed — is the doubled
 * card gone? — instead of looking at the frame as a whole. That's
 * confirmation, not inspection. It will miss anything I'm not already looking
 * for, every time."*
 *
 * `verify` has exactly the same flaw. An `expect:` only ever finds what
 * somebody thought to write down; it cannot find what nobody suspected. The
 * frame that prompted this had three labels with the card below sitting on top
 * of them, and no expectation anywhere would have asked about it.
 *
 * The fix is the same one that made `destroy` work: a closed list beats
 * open-ended looking. "Find anything wrong" fails on a FLOW because the space
 * is infinite. On a single frame it is not — the ways a picture can be wrong
 * are few, and they are the same ways in every app.
 *
 * Every frame, one at a time, never sampled. It reports rather than fails:
 * some of these are judgement, and a false failure on judgement is how a check
 * gets switched off.
 */
import fs from "node:fs";
import path from "node:path";
import type { Manifest } from "../manifest.js";
import type { Take } from "../record.js";
import { askAsync, pickJudge, pool, readJson, why as short } from "./judge.js";
import { noteCheck } from "./checked.js";
import { endProgress, setPhase } from "../progress.js";
import { memo } from "./memo.js";

/**
 * The list. Closed on purpose — no "anything else that looks wrong" slot,
 * because that is the wish that reopens the infinite space. If something real
 * keeps escaping it, the answer is a new numbered item, not a vaguer prompt.
 */
export const LOOK_FOR = [
  "CLIPPED — text cut off, truncated mid-word, or spilling outside the box it belongs to.",
  "OVERLAP — text or an element sitting on top of another, or crossing a boundary it should stop at.",
  "CONTRAST — text you would struggle to read against what is behind it.",
  "CUT OFF — something running off an edge of the frame that plainly should not be.",
  "ALIGNMENT — things that clearly belong on the same line or edge and are not.",
  "DOUBLED — the same element rendered twice by mistake. A list that legitimately holds similar items is not this, and neither is a repetition that a visible count or grouping label already accounts for.",
  "UNFINISHED — a spinner, skeleton, placeholder or loading state still on screen. Say so plainly; whether the app was simply still working is for a person to judge.",
  "BROKEN MEDIA — a missing image, a broken icon, or alt text showing where a picture should be.",
  "NOT FOR THE CAMERA — dev badges, error overlays, debug panels, console output, lorem ipsum.",
  "EMPTY — a region that is blank where content obviously belongs.",
];

export type Issue = { kind: string; what: string; where: string };
export type Frame = { scene: string; still: string; issues: Issue[]; error?: string };
export type Sweep = { frames: Frame[]; judge: string; lines: string[]; looked: number; recalled: number };

const PROMPT = [
  "Look at this one screenshot of a web app and inspect it as a whole.",
  "",
  "You are NOT checking whether some particular feature works. You are looking at the picture the way a person would if they had never seen this app and were asked whether anything about it looks wrong.",
  "",
  "Check for these and nothing else:",
  ...LOOK_FOR.map((l) => `  ${l}`),
  "",
  "Answer with one line of JSON and nothing else:",
  '{"findings":[{"kind":"OVERLAP","what":"<what you can see, naming the actual text or element>","where":"<roughly where in the frame>"}]}',
  "",
  // Retake draws a cursor and a ring on the frames it renders. sweep read the
  // ring as an application spinner and filed it as a defect in the app being
  // recorded. A tool that reports its own overlay as somebody's bug is worse
  // than a tool that reports nothing.
  "One thing in these frames is NOT part of the app: Retake draws a mouse cursor, and a soft circular ring around it at the moment of a click. Never report the cursor or that ring — not as a spinner, not as an overlap, not as anything. Only report what the app itself is drawing.",
  "",
  "Rules. Report only what is visible in THIS image — never what you assume, and never what might be true elsewhere in the app. Quote the real words you can see. A clean frame is the expected answer for a healthy app: return {\"findings\":[]} and do not manufacture something to say. Do not comment on taste, wording, colour choices, spacing you merely dislike, or what the app ought to do differently. At most five findings.",
].join("\n");

type Raw = { findings: unknown[] };
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && Array.isArray((v as Raw).findings);

/** Every scene's frame. `-end` is the payoff; `--all` adds the middles, where
    a half-drawn animation lives. */
export function framesOf(outDir: string, take: Take, all = false): { scene: string; still: string }[] {
  const dir = path.join(outDir, "stills");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).sort(); } catch { return []; }
  const scenes = take.timeline.filter((t) => t.action === "scene").map((t) => (t as { label?: string }).label ?? "");
  const out: { scene: string; still: string }[] = [];
  scenes.forEach((label, i) => {
    const n = String(i + 1).padStart(2, "0");
    const mine = files.filter((f) => f.startsWith(n + "-") && f.includes(label));
    const end = mine.find((f) => f.includes("-end."));
    const mid = mine.find((f) => !f.includes("-end."));
    if (all && mid) out.push({ scene: `${label} (mid)`, still: path.join(dir, mid) });
    const pick = end ?? mid;
    if (pick) out.push({ scene: label, still: path.join(dir, pick) });
  });
  return out;
}

export async function sweep(
  m: Manifest,
  outDir: string,
  log?: (l: string) => void,
  opts: { all?: boolean; concurrency?: number; fresh?: boolean } = {},
): Promise<Sweep> {
  const lines: string[] = [];
  const say = (l: string) => { lines.push(l); log?.(l); };

  let take: Take | null = null;
  try { take = JSON.parse(fs.readFileSync(path.join(outDir, "take.json"), "utf8")) as Take; } catch { /* not recorded */ }
  if (!take) {
    say("no take.json — record it first; sweep reads the frames a run produced.");
    return { frames: [], judge: "none", lines, looked: 0, recalled: 0 };
  }

  const shots = framesOf(outDir, take, opts.all === true);
  if (!shots.length) {
    say("no stills in this folder — there is nothing to look at.");
    return { frames: [], judge: "none", lines, looked: 0, recalled: 0 };
  }

  const { provider, name: judge, why: noJudge } = pickJudge();
  if (!provider) {
    say(`could not look: ${noJudge}`);
    return { frames: [], judge, lines, looked: 0, recalled: 0 };
  }

  // Every frame. Never a sample — sampling is how the method fails in the
  // first place, and the cost is honest: one question per frame.
  say(`looking at all ${shots.length} frame${shots.length === 1 ? "" : "s"} of ${m.name}, one at a time, with ${judge}`);

  // Frames that have not changed since they were last looked at are answered
  // from what is already known. A re-record usually moves one screen, not
  // thirty, and asking about the other twenty-nine again buys nothing.
  const known = memo<Issue[]>(outDir, { reask: opts.fresh === true });
  let recalled = 0;
  // Two minutes of work with nothing to see. It reports where it is, the same
  // way a recording does, so the window can say "sweeping · frame 12 of 30"
  // instead of nothing at all.
  setPhase(outDir, { demo: m.name, phase: "sweeping", step: 0, of: shots.length, label: "looking at every frame" });
  let done = 0;
  const frames: Frame[] = await pool<{ scene: string; still: string }, Frame>(shots, Math.max(1, opts.concurrency ?? 4), async (shot): Promise<Frame> => {
    const seen = known.recall(shot.still, PROMPT);
    if (seen) { recalled++; setPhase(outDir, { phase: "sweeping", step: ++done, of: shots.length, label: shot.scene }); return { ...shot, issues: seen }; }
    try {
      const raw = readJson(await askAsync(provider, PROMPT, [shot.still], 120_000), isRaw);
      if (!raw) return { ...shot, issues: [], error: "no usable answer from the judge" };
      const issues: Issue[] = [];
      for (const f of raw.findings.slice(0, 5)) {
        const o = f as Partial<Issue>;
        if (!o?.what) continue;
        issues.push({ kind: (o.kind ?? "").toString().slice(0, 20) || "—", what: o.what.toString(), where: (o.where ?? "").toString() });
      }
      // Union with anything a previous look found on this same frame — see
      // memo.remember. Two passes of one image do not return the same list.
      known.remember(shot.still, PROMPT, issues, (was, now) => {
        const seenAlready = new Set(was.map((i) => `${i.kind}|${i.what}`));
        return [...was, ...now.filter((i) => !seenAlready.has(`${i.kind}|${i.what}`))];
      });
      setPhase(outDir, { phase: "sweeping", step: ++done, of: shots.length, label: shot.scene });
      return { ...shot, issues: known.all(shot.still, PROMPT) ?? issues };
    } catch (e) {
      // Never remembered: a failure is not an answer about the frame.
      return { ...shot, issues: [], error: short(e) };
    }
  });
  known.flush();
  endProgress(outDir);

  const hit = frames.filter((f) => f.issues.length);
  const failed = frames.filter((f) => f.error);
  say("");
  if (!hit.length) {
    say(`nothing caught the eye in ${frames.length - failed.length} frame${frames.length - failed.length === 1 ? "" : "s"}.`);
  } else {
    say(`${hit.length} of ${frames.length} frame${frames.length === 1 ? " has" : "s have"} something on ${hit.length === 1 ? "it" : "them"}:`);
    say("");
    for (const f of hit) {
      say(`  ${f.scene}`);
      for (const i of f.issues) say(`    ${i.kind.padEnd(16)} ${i.what}${i.where ? ` (${i.where})` : ""}`);
      say(`    → ${path.relative(process.cwd(), f.still)}`);
    }
  }
  if (failed.length) {
    say("");
    // Never silent: a frame nobody could look at has not been checked.
    say(`${failed.length} frame${failed.length === 1 ? " was" : "s were"} not looked at at all: ${failed.map((f) => `${f.scene} (${f.error})`).join(", ")}`);
  }
  const found = hit.reduce((n, f) => n + f.issues.length, 0);
  noteCheck(outDir, "sweep", {
    takeFinishedAt: take.finishedAt, ok: null, count: frames.length - failed.length,
    summary: found ? `${found} thing${found === 1 ? "" : "s"} on ${hit.length} of ${frames.length} frames` : `${frames.length - failed.length} frames, nothing caught the eye`,
  });
  say("");
  say("These are things to look at, not verdicts — open the frame and decide. A closed checklist cannot find what is not on it, so this is a floor, not a ceiling.");
  if (recalled) say(`(${recalled} of ${frames.length} frames had not changed since they were last looked at, and were not asked about again — \`--fresh\` asks anyway.)`);
  return { frames, judge, lines, looked: frames.length - failed.length, recalled };
}
