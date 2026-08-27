/**
 * The things you said were wrong, and whether they still are.
 *
 * A `sense` concern is a question nobody has answered. The moment you say
 * "yes, that one is real", it should stop being judgement and become a check:
 * it gets written into the manifest as an `expect:` on that scene, and from
 * then on every recording answers it yes or no.
 *
 * That is the whole trick. `sense` finds it once; `verify` watches it forever.
 * And because the answer is per-scene, the evidence can be six seconds of the
 * demo instead of the demo — which is the point. Nobody should have to watch
 * a seven-minute take again to find out whether one thing got fixed.
 *
 * The ledger lives next to the manifest, not in outputs/, because it is about
 * the demo rather than about any one recording of it — and because `tidy`
 * must never be able to take it. It is the only thing this writes: the
 * manifest itself is never edited.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Manifest } from "../manifest.js";
import type { Take } from "../record.js";
import { pickJudge } from "./judge.js";
import { judgeWith } from "./verify.js";
import { clipFor, type Clip } from "./clip.js";

export type Flag = {
  /** Short and stable: scene + a slug of the expectation. Survives a
      re-record, which "the price thing" does not. */
  id: string;
  scene: string;
  /** What was originally raised, in the words it was raised in. */
  question: string;
  /** What has to be true now — the sentence written into the manifest. */
  expect: string;
  flaggedAt: string;
  source: "sense" | "verify" | "you";
};

export const flagsPath = (manifestFile: string) => manifestFile.replace(/\.(ya?ml|json)$/i, "") + ".flags.json";

export function readFlags(manifestFile: string): Flag[] {
  try {
    const v = JSON.parse(fs.readFileSync(flagsPath(manifestFile), "utf8")) as { flags?: Flag[] };
    return Array.isArray(v.flags) ? v.flags : [];
  } catch { return []; }
}

function writeFlags(manifestFile: string, flags: Flag[]) {
  fs.writeFileSync(flagsPath(manifestFile), JSON.stringify({
    _readme: "Things you flagged on this demo. Each one is also an `expect:` on its scene in the manifest — that is what actually gets checked. Delete an entry here and in the manifest to stop watching it.",
    flags,
  }, null, 2) + "\n");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * Accept a concern: record it. And nothing else.
 *
 * The first version of this wrote the expectation into the manifest as an
 * `expect:` on the scene. It worked, and the diff was the entire file: a YAML
 * document round-trip re-emits every node it parsed, so one added sentence
 * reflowed every compact `{ action: click, ... }` in a 280-line file — and,
 * worse, dropped the quotes around strings containing commas. Editing
 * somebody's source to record a note is not a trade worth making.
 *
 * So the ledger IS the record, and `verify` reads it alongside the manifest's
 * own expectations. Nothing here ever writes to a file a person wrote.
 */
export function flag(manifestFile: string, f: { scene: string; question: string; expect: string; source?: Flag["source"] }): { flag: Flag } | { error: string } {
  // The scene has to exist, or the expectation can never be answered.
  let labels: string[] = [];
  try {
    const doc = YAML.parse(fs.readFileSync(manifestFile, "utf8")) as { steps?: { action?: string; label?: string }[] };
    labels = (doc.steps ?? []).filter((x) => x.action === "scene").map((x) => x.label ?? "");
  } catch { return { error: `could not read ${path.basename(manifestFile)}` }; }
  if (!labels.includes(f.scene)) {
    return { error: `no scene called "${f.scene}" in ${path.basename(manifestFile)} — it has ${labels.slice(0, 8).map((l) => `"${l}"`).join(", ")}${labels.length > 8 ? ", …" : ""}` };
  }

  const entry: Flag = {
    id: `${slug(f.scene)}--${slug(f.expect)}`,
    scene: f.scene,
    question: f.question,
    expect: f.expect,
    flaggedAt: new Date().toISOString(),
    source: f.source ?? "you",
  };
  const flags = readFlags(manifestFile);
  if (flags.some((x) => x.id === entry.id)) return { error: "already flagged" };
  writeFlags(manifestFile, [...flags, entry]);
  return { flag: entry };
}

/** Remove one, by id or by the sentence itself. */
export function unflag(manifestFile: string, idOrExpect: string): { removed: Flag } | { error: string } {
  const flags = readFlags(manifestFile);
  const hit = flags.find((f) => f.id === idOrExpect || f.expect === idOrExpect);
  if (!hit) return { error: `nothing flagged here matches "${idOrExpect}"` };
  writeFlags(manifestFile, flags.filter((f) => f !== hit));
  return { removed: hit };
}

export type Checked = {
  flag: Flag;
  /** null when it could not be answered — which is never a pass. */
  ok: boolean | null;
  why: string;
  still?: string;
  clip?: Clip;
  /** Why there is no clip. Never swallowed: "no clip" and "the clip failed"
      are different facts, and the second one is usually a half-written video. */
  clipError?: string;
};
export type FixedReport = { checked: Checked[]; lines: string[]; judge: string };

/** The still that answers a scene — its last moment. */
function stillFor(outDir: string, take: Take, label: string): string | null {
  const dir = path.join(outDir, "stills");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).sort(); } catch { return null; }
  const scenes = take.timeline.filter((t) => t.action === "scene");
  const i = scenes.findIndex((s) => (s as { label?: string }).label === label);
  if (i < 0) return null;
  const n = String(i + 1).padStart(2, "0");
  const hit = files.find((f) => f.startsWith(n) && f.includes(label) && f.includes("-end.")) ?? files.find((f) => f.startsWith(n) && f.includes(label));
  return hit ? path.join(dir, hit) : null;
}

/**
 * Answer every flagged thing against the newest recording, and cut the six
 * seconds that show it. This is the verb that exists so a long demo does not
 * have to be re-watched.
 */
export function checkFlags(manifestFile: string, _m: Manifest, outDir: string, opts: { clips?: boolean; log?: (l: string) => void } = {}): FixedReport {
  const lines: string[] = [];
  const say = (l: string) => { lines.push(l); opts.log?.(l); };
  const flags = readFlags(manifestFile);
  if (!flags.length) {
    say("nothing flagged on this demo yet.");
    say("When `sense` raises something real, `retake flag` turns it into a check that every later recording answers — and shows you the few seconds that prove it.");
    return { checked: [], lines, judge: "none" };
  }

  let take: Take | null = null;
  try { take = JSON.parse(fs.readFileSync(path.join(outDir, "take.json"), "utf8")) as Take; } catch { /* not recorded */ }
  if (!take) {
    say(`${flags.length} thing${flags.length === 1 ? "" : "s"} flagged, but this demo has not been recorded — nothing to check them against.`);
    return { checked: [], lines, judge: "none" };
  }

  const { provider, name: judge, why: noJudge } = pickJudge();
  const checked: Checked[] = [];
  for (const f of flags) {
    const still = stillFor(outDir, take, f.scene) ?? undefined;
    let ok: boolean | null = null;
    let why = "";
    if (!still) why = `no still for scene "${f.scene}" in the newest take — was that scene recorded?`;
    else if (!provider) why = noJudge ?? "nothing available to look at the frame";
    else ({ ok, why } = judgeWith(provider, still, f.expect));
    let clip: Clip | undefined;
    let clipError: string | undefined;
    if (opts.clips !== false) {
      const c = clipFor(outDir, take!, f.scene);
      if ("file" in c) clip = c; else clipError = c.error;
    }
    checked.push({ flag: f, ok, why, still, clip, clipError });
  }

  // Written down so the window can show the answer instantly and for free.
  // Judging costs a model call per flag; nothing should pay that on a page
  // load, and nothing should pay it during a recording.
  try {
    fs.writeFileSync(path.join(outDir, "fixed.json"), JSON.stringify({
      checkedAt: new Date().toISOString(),
      takeFinishedAt: take.finishedAt,
      judge,
      items: checked.map((c) => ({ id: c.flag.id, scene: c.flag.scene, expect: c.flag.expect, question: c.flag.question, ok: c.ok, why: c.why, clip: c.clip ? path.basename(path.dirname(c.clip.file)) + "/" + path.basename(c.clip.file) : null, clipError: c.clipError ?? null })),
    }, null, 2) + "\n");
  } catch { /* the report still printed */ }

  const pass = checked.filter((c) => c.ok === true).length;
  say(`${flags.length} thing${flags.length === 1 ? "" : "s"} you flagged here. ${pass === flags.length ? "All" : pass} now pass${pass === 1 ? "es" : ""}.`);
  say("");
  for (const c of checked) {
    say(`  ${c.ok === true ? "✓" : c.ok === false ? "✗" : "?"} ${c.flag.scene} — ${c.flag.expect}`);
    if (c.ok !== true) say(`      ${c.why}`);
    if (c.clip) say(`      ${path.relative(process.cwd(), c.clip.file)}  ·  ${c.clip.seconds.toFixed(0)}s from ${c.clip.start.toFixed(1)}s in`);
    else if (c.clipError) say(`      no clip — ${c.clipError}`);
  }
  return { checked, lines, judge };
}
