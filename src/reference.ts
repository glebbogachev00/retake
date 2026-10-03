/**
 * Record like the good ones.
 *
 * A person who already has a handful of demos they are happy with should not
 * have to describe, knob by knob, what made them good — and an agent drafting
 * the next one should not have to guess. A reference is learned from those
 * takes: the render settings every one of them agreed on (preset, scale,
 * camera, captions, cursor, typing…), and the pacing they actually had,
 * measured from their timelines rather than read off their manifests.
 *
 *   retake learn capture outputs/two-places outputs/it-learns   → references/capture.yaml
 *   like: capture                                              (in a manifest)
 *   retake compare outputs/new-demo                            → how close the take came
 *
 * Two halves, kept apart on purpose:
 *
 *   defaults  are applied. A manifest that says `like: capture` gets every
 *             agreed setting it did not set itself. What the manifest says
 *             always wins — the reference is a starting point, not a cage.
 *   norms     are compared, never applied. Pacing is a property of a take,
 *             not a setting, so the only honest thing to do with it is
 *             measure the new take and say where it falls outside the range
 *             the examples covered. Advisory: a demo that needs to be longer
 *             than every example is allowed to be.
 *
 * Only takes whose steps all passed are learned from. A broken example would
 * teach the broken pacing.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Manifest } from "./manifest.js";
import type { Take, TimelineEntry } from "./record.js";

/** Settings a reference may carry into a manifest. Deliberately NOT here:
    `mode` (Retake never upgrades a demo to a launch on its own), `viewport`
    (pins a shape; `validate` warns against it), and anything that names this
    demo's own content — title, url, steps, intro/outro text, music files. */
export const CARRIED = [
  "preset", "scale", "fps", "crf", "layout", "camera", "captions", "cursor", "typing",
  "colorScheme", "reducedMotion", "theme", "compressIdle", "tempo", "transition", "keepInTab",
] as const;
type Carried = (typeof CARRIED)[number];

export type Range = { min: number; median: number; max: number; n: number };

export type Shot = { label: string; caption?: string; seconds: number };

export type Reference = {
  name: string;
  /** Free text: what these examples are, in the person's words. */
  about?: string;
  learnedAt: string;
  /** Where each example came from, so an agent can open its manifest and
      read how the good one was actually written. */
  examples: { name: string; from: string; manifest?: string; seconds?: number; shots?: Shot[] }[];
  /** Agreed by every example → applied to any manifest that says `like:`. */
  defaults: Partial<Pick<Manifest, Carried>>;
  /** Settings the examples did NOT agree on — left to each manifest. */
  varies: string[];
  norms: {
    /** Seconds of finished video. */
    duration?: Range;
    /** Scenes per demo. */
    scenes?: Range;
    /** Seconds each scene is on screen (every scene of every example). */
    sceneSeconds?: Range;
    /** Words per caption. */
    captionWords?: Range;
    /** Seconds before the first thing happens on camera. */
    openingHold?: Range;
    /** Seconds the last state is held before the video ends. */
    endingHold?: Range;
    /** ms per typed key, where a step set one. */
    typeDelayMs?: Range;
  };
};

// ---------------------------------------------------------------------------
// Reading an example

export type Example = { name: string; from: string; manifest: Manifest; take?: Take; seconds?: number };

/** What one example says about itself: an outputs/<name> folder (the
    manifest it was recorded with + its timeline), or a bare manifest. A
    folder whose take failed is refused, with the reason. */
export function readExample(p: string, parse: (data: unknown, file: string) => Manifest): Example {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`${p}: no such file or folder`);
  if (fs.statSync(abs).isDirectory()) {
    const used = path.join(abs, "manifest.used.yaml");
    const takeFile = path.join(abs, "take.json");
    if (!fs.existsSync(used)) throw new Error(`${p}: no manifest.used.yaml — point at an outputs/<name> folder that has been recorded, or at a manifest`);
    const manifest = parse(YAML.parse(fs.readFileSync(used, "utf8")), used);
    let take: Take | undefined;
    if (fs.existsSync(takeFile)) {
      take = JSON.parse(fs.readFileSync(takeFile, "utf8")) as Take;
      if (!take.ok) throw new Error(`${p}: its last take has failed steps — a reference learns from takes you are happy with`);
      if (take.brisk) throw new Error(`${p}: its last take was --brisk (no pacing) — record it properly before learning from it`);
      if (take.partial) throw new Error(`${p}: its last take is partial (${take.partial}) — learn from a whole take`);
    }
    return { name: manifest.name, from: abs, manifest, take, seconds: take ? shownSeconds(take, manifest) : undefined };
  }
  const data = abs.endsWith(".json") ? JSON.parse(fs.readFileSync(abs, "utf8")) : YAML.parse(fs.readFileSync(abs, "utf8"));
  const manifest = parse(data, abs);
  return { name: manifest.name, from: abs, manifest };
}

/** Seconds a viewer actually watches: the recording minus the trimmed head,
    divided by the render tempo. compressIdle is not modelled — it is a
    carried setting, so the new take gets the same treatment. */
export function shownSeconds(take: Take, m: Pick<Manifest, "tempo" | "trim">): number {
  const raw = Math.max(0, take.duration - (take.trimBefore ?? 0) - (m.trim?.head ?? 0) - (m.trim?.tail ?? 0));
  return round(raw / (m.tempo || 1));
}

/** One take, measured. Times are seconds of finished video. */
export function measure(take: Take, m: Manifest) {
  const t0 = take.trimBefore ?? 0;
  const end = take.duration;
  const tempo = m.tempo || 1;
  const tl = take.timeline.filter((e) => e.start >= t0 - 0.05);
  const scenes = tl.filter((e) => e.action === "scene");
  const shots: Shot[] = scenes.map((s, i) => ({
    label: s.label ?? `scene-${i + 1}`,
    ...(s.caption ? { caption: s.caption } : {}),
    seconds: round(((scenes[i + 1]?.start ?? end) - s.start) / tempo),
  }));
  const acts = tl.filter((e) => isAction(e));
  const openingHold = acts.length ? round((acts[0].start - t0) / tempo) : undefined;
  const lastAct = acts[acts.length - 1];
  const endingHold = lastAct ? round((end - lastAct.end) / tempo) : undefined;
  return { seconds: shownSeconds(take, m), shots, openingHold, endingHold };
}

/** A step a viewer sees DO something — not a pause, a marker, or a stub. */
function isAction(e: TimelineEntry): boolean {
  return !["wait", "scene", "stub", "screenshot", "evaluate"].includes(e.action);
}

// ---------------------------------------------------------------------------
// Learning

/** `baseline` is what Retake would use with nothing set (a bare manifest
    through the schema). A setting the examples agree on that is ALSO the
    baseline is not carried: it would be applied anyway, and listing it buries
    the few choices that actually make these examples look the way they do. */
export function learn(name: string, examples: Example[], about?: string, baseline: Record<string, unknown> = {}): Reference {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("a reference name is kebab-case: capture, tutor-mobile");
  if (!examples.length) throw new Error("learn needs at least one example — an outputs/<name> folder you are happy with");

  const defaults: Record<string, unknown> = {};
  const varies: string[] = [];
  for (const key of CARRIED) {
    const seen = examples.map((e) => (e.manifest as Record<string, unknown>)[key]);
    const set = seen.filter((v) => v !== undefined);
    if (!set.length) continue;
    const first = JSON.stringify(set[0]);
    // Agreement means EVERY example, including ones that left it unset. One
    // example at scale 2 and one at the preset's own scale do not agree.
    if (set.length === seen.length && set.every((v) => JSON.stringify(v) === first)) {
      if (first !== JSON.stringify(baseline[key])) defaults[key] = set[0];
    } else varies.push(key);
  }

  const measured = examples.filter((e) => e.take).map((e) => ({ e, m: measure(e.take!, e.manifest) }));
  const captions = examples.flatMap((e) => e.manifest.steps.flatMap((s) => (s.action === "scene" && s.caption?.trim() ? [words(s.caption)] : [])));
  const delays = examples.flatMap((e) => e.manifest.steps.flatMap((s) => (s.action === "type" && s.delay !== undefined ? [s.delay] : [])));

  const norms: Reference["norms"] = {};
  const put = <K extends keyof Reference["norms"]>(k: K, xs: (number | undefined)[]) => {
    const r = range(xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)));
    if (r) norms[k] = r;
  };
  put("duration", measured.map(({ m }) => m.seconds));
  put("scenes", examples.map((e) => e.manifest.steps.filter((s) => s.action === "scene").length));
  put("sceneSeconds", measured.flatMap(({ m }) => m.shots.map((s) => s.seconds)));
  put("captionWords", captions);
  put("openingHold", measured.map(({ m }) => m.openingHold));
  put("endingHold", measured.map(({ m }) => m.endingHold));
  put("typeDelayMs", delays);

  return {
    name,
    ...(about ? { about } : {}),
    learnedAt: new Date().toISOString(),
    examples: examples.map((e) => {
      const m = e.take ? measure(e.take, e.manifest) : undefined;
      const used = path.join(e.from, "manifest.used.yaml");
      return {
        name: e.name,
        from: e.from,
        manifest: fs.existsSync(used) ? used : e.from,
        ...(m ? { seconds: m.seconds, shots: m.shots } : {}),
      };
    }),
    defaults: defaults as Reference["defaults"],
    varies,
    norms,
  };
}

// ---------------------------------------------------------------------------
// Storing and finding

/** Where references live: `references/` at the workspace root, next to
    demos/ and outputs/. */
export function referenceDirs(manifestDir: string, projectRoot: string): string[] {
  return [...new Set([
    path.join(manifestDir, "references"),
    path.join(manifestDir, "..", "references"),
    path.join(projectRoot, "references"),
  ].map((d) => path.resolve(d)))];
}

export function findReference(name: string, dirs: string[]): string | null {
  for (const d of dirs) for (const ext of [".yaml", ".yml"]) {
    const f = path.join(d, name + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function readReference(file: string): Reference {
  const r = YAML.parse(fs.readFileSync(file, "utf8")) as Reference;
  if (!r || typeof r !== "object" || typeof r.name !== "string") throw new Error(`${file} is not a reference`);
  return { ...r, defaults: r.defaults ?? {}, varies: r.varies ?? [], norms: r.norms ?? {}, examples: r.examples ?? [] };
}

export function writeReference(dir: string, r: Reference): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.name}.yaml`);
  // Relative to the reference itself, so a workspace committed to git (or
  // moved to another machine) still points at its examples.
  const rel = (p?: string) => (p && path.isAbsolute(p) ? path.relative(dir, p) || "." : p);
  r = { ...r, examples: r.examples.map((e) => ({ ...e, from: rel(e.from)!, ...(e.manifest ? { manifest: rel(e.manifest) } : {}) })) };
  const head = [
    `# Learned by \`retake learn\` from ${r.examples.length} example${r.examples.length === 1 ? "" : "s"} — re-run it to relearn.`,
    "# defaults: applied to any manifest that says `like: " + r.name + "` and does not set them itself.",
    "# norms:    measured from the examples' takes; `retake compare` checks a new take against them.",
    "# examples: paths are relative to this file — open their manifests to see how the good ones were written.",
    "",
  ].join("\n");
  fs.writeFileSync(file, head + YAML.stringify(r));
  return file;
}

/** The reference's defaults under the manifest's own values. Runs on the raw
    parsed YAML, BEFORE schema defaults are filled in — after that, "the
    manifest did not say" and "the manifest said the default" look the same. */
export function applyReference(data: Record<string, unknown>, r: Pick<Reference, "defaults">): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const [k, v] of Object.entries(r.defaults ?? {})) {
    if (!(CARRIED as readonly string[]).includes(k)) continue; // a hand-edited reference cannot smuggle in steps or a url
    const mine = out[k];
    if (mine === undefined) out[k] = v;
    else if (isPlain(mine) && isPlain(v)) out[k] = { ...v, ...mine };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparing

export type Verdict = { ok: boolean; line: string };

/** Before the camera: what the manifest alone can say against the norms. */
export function planNotes(m: Manifest, r: Reference): string[] {
  const out: string[] = [];
  const n = r.norms;
  const scenes = m.steps.filter((s) => s.action === "scene");
  if (n.scenes && scenes.length > n.scenes.max * 1.5 + 1) out.push(`${scenes.length} scenes — "${r.name}" examples have ${span(n.scenes, "")}. Consider splitting this into two demos.`);
  if (n.captionWords) {
    const cap = Math.max(n.captionWords.max, Math.ceil(n.captionWords.median * 1.5));
    for (const s of scenes) if (s.caption && words(s.caption) > cap) out.push(`scene "${s.label}": caption is ${words(s.caption)} words — "${r.name}" captions run ${span(n.captionWords, " words")}.`);
  }
  for (const k of CARRIED) {
    const want = (r.defaults as Record<string, unknown>)[k];
    const have = (m as Record<string, unknown>)[k];
    if (want !== undefined && JSON.stringify(want) !== JSON.stringify(have)) out.push(`${k}: ${JSON.stringify(have)} overrides "${r.name}"'s ${JSON.stringify(want)} — fine if deliberate.`);
  }
  return out;
}

/** After the camera: the take against the examples. Ranges are widened by a
    margin, because "within what three examples happened to do" is a much
    narrower band than "good" — a check that cries wolf gets skimmed. */
export function compareTake(take: Take, m: Manifest, r: Reference): Verdict[] {
  const v: Verdict[] = [];
  const n = r.norms;
  const got = measure(take, m);
  const within = (x: number, rg: Range, lo = 0.75, hi = 1.3) => x >= rg.min * lo && x <= rg.max * hi;

  if (n.duration) v.push({ ok: within(got.seconds, n.duration), line: `length ${got.seconds.toFixed(1)}s — examples ${span(n.duration, "s")}` });
  if (n.sceneSeconds && got.shots.length) {
    const long = got.shots.filter((s) => s.seconds > n.sceneSeconds!.max * 1.5 && s.seconds > 4);
    const short = got.shots.filter((s) => s.seconds < n.sceneSeconds!.min * 0.5 && s.seconds < 1.5);
    const med = median(got.shots.map((s) => s.seconds));
    v.push({ ok: within(med, { ...n.sceneSeconds, min: n.sceneSeconds.median * 0.6, max: n.sceneSeconds.median * 1.6 }, 1, 1), line: `typical scene ${med.toFixed(1)}s — examples' median ${n.sceneSeconds.median.toFixed(1)}s` });
    for (const s of long) v.push({ ok: false, line: `scene "${s.label}" holds ${s.seconds.toFixed(1)}s — longest in the examples is ${n.sceneSeconds.max.toFixed(1)}s; the viewer waits here` });
    for (const s of short) v.push({ ok: false, line: `scene "${s.label}" is on screen ${s.seconds.toFixed(1)}s — too short to read; examples hold at least ${n.sceneSeconds.min.toFixed(1)}s` });
  }
  if (n.openingHold && got.openingHold !== undefined) v.push({ ok: got.openingHold <= Math.max(n.openingHold.max * 1.6, n.openingHold.max + 1), line: `first action at ${got.openingHold.toFixed(1)}s — examples ${span(n.openingHold, "s")}` });
  if (n.endingHold && got.endingHold !== undefined) v.push({ ok: got.endingHold >= n.endingHold.min * 0.5, line: `result held ${got.endingHold.toFixed(1)}s at the end — examples ${span(n.endingHold, "s")}` });
  if (n.captionWords) {
    const cap = Math.max(n.captionWords.max, Math.ceil(n.captionWords.median * 1.5));
    const wordy = m.steps.filter((s) => s.action === "scene" && s.caption && words(s.caption) > cap);
    v.push({ ok: !wordy.length, line: wordy.length ? `${wordy.length} caption(s) longer than the examples' ${cap} words` : `captions within the examples' length` });
  }
  const differs = CARRIED.filter((k) => {
    const want = (r.defaults as Record<string, unknown>)[k];
    return want !== undefined && JSON.stringify(want) !== JSON.stringify((m as Record<string, unknown>)[k]);
  });
  v.push({ ok: true, line: differs.length ? `look: overrides ${differs.join(", ")} (deliberate overrides are fine)` : `look: same settings as "${r.name}"` });
  return v;
}

// ---------------------------------------------------------------------------

function range(xs: number[]): Range | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return { min: round(s[0]), median: round(median(s)), max: round(s[s.length - 1]), n: s.length };
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round = (x: number) => Math.round(x * 10) / 10;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const span = (r: Range, unit: string) => (r.min === r.max ? `${r.min}${unit}` : `${r.min}–${r.max}${unit}`);
const isPlain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
