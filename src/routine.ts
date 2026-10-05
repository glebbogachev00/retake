/**
 * Routines — the standard, applied by the machine instead of described to a model.
 *
 * `demos/style.md` is prose an agent READS while drafting, so every draft is a
 * fresh interpretation of it. That is why one video comes back narrated too
 * fast, the next too slow, and a third in a voice nobody asked for: nothing is
 * wrong with the note, it is just being re-read by a model with a vote.
 *
 * A routine is the other half. The handful of decisions that must come out
 * identical every time — format, captions, music, voice, speaking rate — are
 * held as data and STAMPED onto the manifest after it is drafted. The model
 * writes the story; the routine writes the settings; they never argue.
 *
 * The split is the whole idea: taste that needs judgement stays in style.md,
 * settings that only need to be consistent live here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

/* ─── the three styles ───────────────────────────────────────────────────────
   Three, deliberately. A style is a shape, not a theme: the frame the app sits
   in and where the words go. Everything else about how a demo looks is the
   recording being done properly. */

export type StyleName = "showcase" | "fullscreen" | "mobile";

export type Style = {
  label: string;
  note: string;
  preset: string;
  /** `card` insets the app in the canvas and paints the routine's theme behind
      it — the matte. `none` lets it fill the frame. A caption band appears
      under `card` and `band` only when captions are on. */
  layout: "card" | "none" | "band";
  /** Page zoom. Lower means more of the app in frame at the same crispness. */
  scale: number;
  /** The pointer. Two takes with different cursor sizes read as two products. */
  cursorSize: number;
};

export const STYLES: Record<StyleName, Style> = {
  showcase: {
    label: "Showcase",
    note: "The app inset on your own colour, with a shadow. The look of every Capture demo.",
    preset: "post-landscape",
    layout: "card",
    scale: 1.7,
    cursorSize: 28,
  },
  fullscreen: {
    label: "Full screen",
    note: "The app fills all 1920×1080. Nothing around it.",
    preset: "post-landscape",
    layout: "none",
    scale: 2,
    cursorSize: 32,
  },
  mobile: {
    label: "Mobile",
    note: "1080×1920 for shorts and reels, inset the same way.",
    preset: "post-vertical",
    layout: "card",
    scale: 1.4,
    cursorSize: 26,
  },
};

/* ─── the voices ─────────────────────────────────────────────────────────────
   Named so nobody types an engine string, and rate-locked so nobody argues
   with the speed again. `rate` stays adjustable in one place for the whole
   workspace; it is not a per-video decision and never was. The language rides
   on the voice — a Vietnamese routine is a Vietnamese voice id, not a separate
   setting that would have to agree with this one. */

export const VOICES: Record<string, { id: string; note: string }> = {
  ryan: { id: "en-GB-RyanNeural", note: "British, easy, positive. The one the Capture demos use." },
  andrew: { id: "en-US-AndrewNeural", note: "Warm, confident, unhurried." },
  ava: { id: "en-US-AvaNeural", note: "Expressive and friendly, a little closer in." },
  brian: { id: "en-US-BrianNeural", note: "Casual and sincere — least like a narrator." },
  emma: { id: "en-US-EmmaNeural", note: "Clear and conversational, good over fast UI." },
  aria: { id: "en-US-AriaNeural", note: "A news read: even, flat, no colour." },
};

/** A routine's `voice` is a name above, "silent", or a raw edge-tts voice id
 *  (`vi-VN-HoaiMyNeural`) for a language the named set does not cover. */
export function voiceId(voice: string): string {
  return VOICES[voice]?.id ?? voice;
}

/* ─── the file ─────────────────────────────────────────────────────────────── */

export const RoutineSchema = z.object({
  style: z.enum(["showcase", "fullscreen", "mobile"]).default("showcase"),
  /** A VOICES name, "silent", or a raw edge-tts id. */
  voice: z.string().default("silent"),
  /** Speaking rate, percent. Decided once here; bounded as the manifest bounds it. */
  rate: z.number().int().min(-50).max(50).default(0),
  /** A music bed, or false. Music makes a video `mode: launch`; the stamp does that for you. */
  music: z.union([z.literal(false), z.string()]).default(false),
  /** OFF by default, and deliberately: a caption under a narrated video is the
      same words twice. Captions are for silent cuts. */
  captions: z.boolean().default(false),
  /** `launch` presents the product and may carry title cards and a matte;
      `demo` proves an interaction and wants nothing else in frame. */
  mode: z.enum(["demo", "launch"]).default("demo"),
  /** The matte and caption colours — the workspace's brand, not the shape's. */
  theme: z.object({ background: z.string(), ink: z.string() }).optional(),
  typing: z.enum(["natural", "brisk"]).default("natural"),
  /** Show the app's own long waits as ~1.5s each. Your pacing waits are untouched. */
  compressIdle: z.boolean().default(false),
  /** Still by default. `auto` eases toward whatever was last touched, which
      makes two takes of the same app move differently — a per-video decision
      that has no place in a standard. */
  camera: z.enum(["static", "auto"]).default("static"),
  /** Where narration lands. "scenes": one performance, each paragraph placed
      on its narrated scene — how a north-star narration is made. "start":
      one read from the first frame. */
  narration: z.enum(["scenes", "start"]).default("scenes"),
  /** The app's own light/dark. Left to the machine it follows whoever recorded. */
  colorScheme: z.enum(["light", "dark"]).default("light"),
  /** Title and end cards. Every shipped Capture demo opens and closes on one;
      leaving them per-video is how a set of videos ends up with some that have
      them and some that do not. The intro's words come from the manifest's own
      `title` — that part IS per video — but whether there is a card at all,
      how long it holds and how it joins the body belong to the standard. */
  cards: z.boolean().default(false),
  cardMs: z.number().int().min(800).max(6000).default(2600),
  cardTransition: z.enum(["cut", "fade", "dissolve"]).default("fade"),
  /** The closing card. The one piece of furniture that is identical every time. */
  outro: z.object({ title: z.string().max(60), subtitle: z.string().max(90).optional() }).optional(),
  /** The opening card's words, when they are the brand's rather than the
      video's — a north star that opens every video on the same line. Absent:
      the card says the manifest's own `title`. */
  intro: z.object({ title: z.string().max(60), subtitle: z.string().max(90).optional() }).optional(),
  /** One approved video — the north star — that every cut is compared to. */
  reference: z.string().optional(),
  /** Where a finished video goes once it matches the reference. One that does
      not match never lands here: the folder you post from only ever holds
      videos that passed. */
  deliver: z.string().optional(),
  /** What a new agent must read before writing a single step for this product
      — its environment, seed, selectors and pitfalls. The \`routine\` tool
      returns it, so the first thing an agent sees is everything it needs. */
  brief: z.string().optional(),
  /** The app this routine records, declared: how it starts, what it must and
      must not show. Absent: demos/environment.yaml, if there is one. Two
      products in one workspace each need their own. */
  environment: z.string().optional(),
  /** How the cards look: the brand's ground, ink, mark and typeface. Without
      it they are Retake's own card, which is not what a north-star card is. */
  card: z.object({
    background: z.string(), ink: z.string(),
    logo: z.string().optional(), font: z.string().optional(),
    weight: z.number().int().min(100).max(900).default(560),
    ornament: z.enum(["circles", "none"]).default("none"),
    orb: z.string().optional(),
  }).optional(),
  note: z.string().optional(),
});
export type Routine = z.infer<typeof RoutineSchema>;

const FileSchema = z.object({
  use: z.string().optional(),
  routines: z.record(z.string(), RoutineSchema),
});
export type RoutineFile = { use: string; routines: Record<string, Routine> };

/** The environment a routine records against: its own, or the workspace's. */
export function environmentFor(demosDir: string, r?: Routine): string | undefined {
  if (r?.environment) return path.resolve(r.environment.replace(/^~/, os.homedir()));
  const shared = path.join(demosDir, "environment.yaml");
  return fs.existsSync(shared) ? shared : undefined;
}

export function routineFile(demosDir: string): string {
  return path.join(demosDir, "routine.json");
}

/** The standard a fresh workspace gets: silent, showcase, captions on. Silent
 *  because an unheard synthetic voice is worse than no voice, and because the
 *  first video should exist before anyone is asked about narration. */
export function starter(): RoutineFile {
  return { use: "default", routines: { default: RoutineSchema.parse({ note: "The house standard. Change it here, not per video." }) } };
}

export function readRoutines(demosDir: string): RoutineFile | null {
  const f = routineFile(demosDir);
  if (!fs.existsSync(f)) return null;
  const parsed = FileSchema.safeParse(JSON.parse(fs.readFileSync(f, "utf8")));
  if (!parsed.success) throw new Error(`${path.relative(process.cwd(), f)} is not a valid routine file — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const names = Object.keys(parsed.data.routines);
  if (!names.length) throw new Error(`${path.relative(process.cwd(), f)} has no routines in it`);
  return { use: parsed.data.use ?? names[0], routines: parsed.data.routines };
}

export function writeRoutines(demosDir: string, data: RoutineFile): void {
  fs.mkdirSync(demosDir, { recursive: true });
  fs.writeFileSync(routineFile(demosDir), JSON.stringify(data, null, 2) + "\n");
}

export function pick(demosDir: string, name?: string): { name: string; routine: Routine } {
  const file = readRoutines(demosDir);
  if (!file) throw new Error("no routine yet — `retake routine init` writes one, then `retake routine` shows it");
  const which = name ?? file.use;
  const routine = file.routines[which];
  if (!routine) throw new Error(`no routine called "${which}" — have: ${Object.keys(file.routines).join(", ")}`);
  return { name: which, routine };
}

/* ─── the stamp ───────────────────────────────────────────────────────────── */

export type Stamped = { changed: string[]; skipped: string[] };

/**
 * Write the routine's settings into one manifest, in place, comments intact.
 *
 * Two things it deliberately will NOT do:
 *
 *  - turn voiceover ON. A manifest with no narration written stays silent; the
 *    routine only fixes the voice and rate of narration that already exists.
 *    Narration needs a script and a person who has heard it, and that gate is
 *    not a setting to automate away.
 *  - keep a pinned `viewport` or `scale`. A manifest that pins its own size
 *    silently beats the preset, and that is the one way two takes of the same
 *    app come out different shapes.
 */
export function applyToManifest(file: string, r: Routine): Stamped {
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  const changed: string[] = [];
  const skipped: string[] = [];
  // A key the routine owns is a key a person should stop annotating: a note
  // explaining the old value ("# too fast") becomes a lie the moment the
  // routine corrects it, and a lying comment is worse than no comment. New
  // keys go in with the other settings rather than after `steps`, because
  // these files get read.
  const settings = (): YAML.YAMLMap | null => (YAML.isMap(doc.contents) ? doc.contents : null);
  // setIn() with a plain key makes a Pair whose key is a bare string, while a
  // parsed one is a Scalar node. Match either, or new keys are invisible here.
  const keyOf = (i: { key: unknown }) => (YAML.isScalar(i.key) ? i.key.value : i.key);
  const pairFor = (key: string) => settings()?.items.find((i) => keyOf(i) === key);
  const set = (key: string, value: unknown) => {
    if (JSON.stringify(doc.getIn([key], false) ?? null) === JSON.stringify(value ?? null)) return;
    const existed = doc.hasIn([key]);
    doc.setIn([key], value);
    const pair = pairFor(key);
    if (pair) {
      if (YAML.isNode(pair.key)) pair.key.comment = null;
      if (YAML.isNode(pair.value)) { pair.value.comment = null; pair.value.commentBefore = null; }
      const map = settings();
      if (!existed && map) {
        const steps = map.items.findIndex((i) => keyOf(i) === "steps");
        const here = map.items.indexOf(pair);
        if (steps >= 0 && here > steps) { map.items.splice(here, 1); map.items.splice(steps, 0, pair); }
      }
    }
    changed.push(`${key}: ${typeof value === "object" ? YAML.stringify(value).trim().replace(/\n/g, " ") : String(value)}`);
  };
  const drop = (key: string) => {
    if (doc.hasIn([key])) { doc.deleteIn([key]); changed.push(`${key}: removed`); }
  };

  const style = STYLES[r.style];
  set("preset", style.preset);
  set("layout", style.layout);
  set("scale", style.scale);
  set("captions", r.captions);
  set("mode", r.mode);
  set("typing", r.typing);
  set("compressIdle", r.compressIdle);
  set("camera", r.camera);
  set("colorScheme", r.colorScheme);
  set("cursor", { style: "default", size: style.cursorSize, idleHide: false });
  // Animation that differs run to run is the enemy of two takes matching.
  set("reducedMotion", true);

  if (r.cards) {
    // The words are the video's; the furniture is the standard's. A manifest
    // with no `title` gets no card rather than a card reading "undefined".
    const own = doc.getIn(["title"], false);
    const title = r.intro?.title ?? (typeof own === "string" ? own : undefined);
    if (typeof title === "string" && title.trim()) {
      set("intro", { title, ...(r.intro?.subtitle ? { subtitle: r.intro.subtitle } : {}), ms: r.cardMs });
    } else {
      skipped.push("intro card: this manifest has no `title:`, so there is nothing for the card to say");
    }
    if (r.outro) set("outro", { ...r.outro, ms: r.cardMs });
    set("cardTransition", { style: r.cardTransition, ms: 450 });
    if (r.card) set("card", { ...r.card });
    // Cards are launch furniture; `mode: demo` warns about them, correctly.
    if (doc.getIn(["mode"], false) !== "launch") { doc.setIn(["mode"], "launch"); changed.push("mode: launch (cards belong to a launch cut)"); }
  }
  if (r.theme) set("theme", { background: r.theme.background, ink: r.theme.ink });
  // A pinned viewport silently beats the preset; `scale` is the style's, so a
  // hand-set one is dropped by being overwritten above rather than removed.
  drop("viewport");

  if (r.voice === "silent") {
    set("voiceover", false);
  } else {
    const vo = doc.getIn(["voiceover"], false);
    if (vo && typeof vo === "object" && YAML.isMap(vo)) {
      const clear = (k: string) => {
        const pr = vo.items.find((i) => (YAML.isScalar(i.key) ? i.key.value : i.key) === k);
        if (!pr) return;
        if (YAML.isNode(pr.key)) pr.key.comment = null;
        if (YAML.isNode(pr.value)) { pr.value.comment = null; pr.value.commentBefore = null; }
      };
      if (vo.get("voice") !== voiceId(r.voice)) { vo.set("voice", voiceId(r.voice)); clear("voice"); changed.push(`voiceover.voice: ${voiceId(r.voice)}`); }
      if (vo.get("ratePercent") !== r.rate) { vo.set("ratePercent", r.rate); clear("ratePercent"); changed.push(`voiceover.ratePercent: ${r.rate}`); }
      if (vo.get("align") !== r.narration) { vo.set("align", r.narration); clear("align"); changed.push(`voiceover.align: ${r.narration}`); }
    } else {
      skipped.push(`voiceover: this demo has none written. The routine's voice (${voiceId(r.voice)} at ${r.rate >= 0 ? "+" : ""}${r.rate}%) applies the moment one is.`);
    }
  }

  if (r.music === false) drop("music");
  else {
    set("music", r.music);
    if (doc.getIn(["mode"], false) !== "launch") { doc.setIn(["mode"], "launch"); changed.push("mode: launch (music belongs to a launch cut)"); }
  }

  // lineWidth 0 disables the writer's 80-column wrap. Without it, stamping a
  // manifest silently reflows every long step a person wrote by hand — the
  // file comes back correct and completely rearranged, which reads as damage.
  if (changed.length) fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return { changed, skipped };
}

/* ─── reading it back ─────────────────────────────────────────────────────── */

export function describe(name: string, r: Routine): string {
  const s = STYLES[r.style];
  const voice = r.voice === "silent" ? "silent" : `${voiceId(r.voice)} at ${r.rate >= 0 ? "+" : ""}${r.rate}%${VOICES[r.voice] ? ` (${r.voice})` : ""}`;
  return [
    `routine ${name}${r.note ? ` — ${r.note}` : ""}`,
    ``,
    `  style      ${s.label.toLowerCase()} · ${s.preset} · ${s.layout === "card" ? "inset on your colour" : s.layout === "none" ? "full bleed" : "caption band"}`,
    `  captions   ${r.captions ? "on" : "off"}`,
    `  voice      ${voice}`,
    `  music      ${r.music === false ? "none" : r.music}`,
    `  mode       ${r.mode}${r.mode === "launch" ? " — title cards and a matte are allowed" : " — nothing in frame but the product"}`,
    `  colour     ${r.theme ? `${r.theme.background} behind, ${r.theme.ink} ink` : "Retake's default"}`,
    `  typing     ${r.typing}${r.compressIdle ? " · idle compressed" : ""}`,
    `  cards      ${r.cards ? `title + ${r.outro ? `“${r.outro.title}”` : "no end card"} · ${r.cardMs}ms · ${r.cardTransition}` : "none"}`,
    ``,
    ...(r.reference ? [`  north star ${r.reference}`] : []),
    ...(r.deliver ? [`  delivers  ${r.deliver} — only videos that match the north star`] : []),
    ...(r.brief ? [`  brief      ${r.brief} — read it before writing anything for this product`] : []),
    ...(r.environment ? [`  app        ${r.environment} — \`retake env up\` starts it isolated and proves it`] : []),
    ``,
    `  Every demo recorded by this routine comes out this way. Change it here,`,
    `  never per video: \`retake routine set <key> <value>\`.`,
  ].join("\n");
}

/* ─── learning it from work that already exists ──────────────────────────────
   The first routine a workspace gets used to be Retake's defaults, which is a
   guess wearing the clothes of a standard — and a guess the machine then stamps
   onto every video with confidence. Read it off the manifests instead: they are
   the record of what was actually recorded and approved. */

export type Learned = { routine: Routine; from: string[]; notes: string[] };

export function learnFrom(files: string[]): Learned {
  if (!files.length) throw new Error("nothing to learn from — point this at the manifests of demos you already like");
  const seen: Record<string, unknown[]> = {};
  const push = (k: string, v: unknown) => { if (v !== undefined) (seen[k] ??= []).push(v); };
  const read: string[] = [];

  for (const f of files) {
    let doc: Record<string, unknown>;
    try { doc = YAML.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>; } catch { continue; }
    if (!doc || typeof doc !== "object") continue;
    read.push(path.basename(f));
    push("preset", doc.preset);
    push("layout", doc.layout);
    push("scale", doc.scale);
    push("captions", doc.captions);
    push("mode", doc.mode);
    push("typing", doc.typing);
    push("compressIdle", doc.compressIdle);
    push("theme", doc.theme);
    push("cards", Boolean(doc.intro || doc.outro));
    push("outro", doc.outro);
    push("cardTransition", (doc.cardTransition as { style?: string } | undefined)?.style);
    push("music", doc.music);
    const vo = doc.voiceover as { voice?: string; ratePercent?: number } | boolean | undefined;
    if (vo && typeof vo === "object") { push("voice", vo.voice); push("rate", vo.ratePercent); }
    else if (vo === false || vo === undefined) push("voice", "silent");
  }
  if (!read.length) throw new Error("none of those files parsed as a manifest");

  // The most common answer wins; a split is reported rather than silently picked.
  const notes: string[] = [];
  const winner = <T,>(k: string, fallback: T): T => {
    const vals = seen[k] ?? [];
    if (!vals.length) return fallback;
    const tally = new Map<string, { v: unknown; n: number }>();
    for (const v of vals) {
      const key = JSON.stringify(v);
      tally.set(key, { v, n: (tally.get(key)?.n ?? 0) + 1 });
    }
    const ranked = [...tally.values()].sort((a, b) => b.n - a.n);
    if (ranked.length > 1) notes.push(`${k}: ${ranked.map((r) => `${JSON.stringify(r.v)}×${r.n}`).join(", ")} — took ${JSON.stringify(ranked[0].v)}`);
    return ranked[0].v as T;
  };

  const layout = winner<string>("layout", "card");
  const preset = winner<string>("preset", "post-landscape");
  const style: StyleName = preset === "post-vertical" ? "mobile" : layout === "none" ? "fullscreen" : "showcase";

  const rawVoice = winner<string>("voice", "silent");
  const named = Object.entries(VOICES).find(([, v]) => v.id === rawVoice)?.[0];
  const music = winner<unknown>("music", false);

  const routine = RoutineSchema.parse({
    style,
    voice: named ?? rawVoice,
    rate: winner<number>("rate", 0),
    captions: winner<boolean>("captions", false),
    mode: winner<string>("mode", "demo"),
    theme: winner<{ background: string; ink: string } | undefined>("theme", undefined),
    typing: winner<string>("typing", "natural"),
    compressIdle: Boolean(winner<unknown>("compressIdle", false)),
    cards: Boolean(winner<boolean>("cards", false)),
    cardTransition: winner<string>("cardTransition", "fade"),
    outro: (() => { const o = winner<{ title?: string; subtitle?: string } | undefined>("outro", undefined); return o?.title ? { title: o.title, subtitle: o.subtitle } : undefined; })(),
    music: typeof music === "string" ? music : music && typeof music === "object" ? (music as { file: string }).file : false,
    note: `Read from ${read.length} manifest${read.length === 1 ? "" : "s"} already recorded here.`,
  });

  const learnedScale = winner<number | undefined>("scale", undefined);
  if (learnedScale !== undefined && learnedScale !== STYLES[style].scale) {
    notes.push(`scale: your manifests use ${learnedScale}, the ${style} style uses ${STYLES[style].scale} — the style wins, so two takes cannot come out different sizes`);
  }
  return { routine, from: read, notes };
}

/* ─── the plan, and working through it ───────────────────────────────────────
   The plan is the queue: names and one-sentence stories, written by whoever
   has the ideas. A routine never invents one — the settings are the machine's
   job and the stories are not. */

export type PlanItem = { name: string; story: string; status: "todo" | "recorded" | "final" | "failed"; note?: string };

export function planPath(demosDir: string): string {
  return path.join(demosDir, "plan.json");
}
export function readPlan(demosDir: string): PlanItem[] {
  try { return JSON.parse(fs.readFileSync(planPath(demosDir), "utf8")) as PlanItem[]; } catch { return []; }
}
export function writePlan(demosDir: string, items: PlanItem[]): void {
  fs.mkdirSync(demosDir, { recursive: true });
  fs.writeFileSync(planPath(demosDir), JSON.stringify(items, null, 2));
}

export function manifestFor(demosDir: string, name: string): string {
  for (const ext of ["yaml", "yml", "json"]) {
    const p = path.join(demosDir, `${name}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no ${path.relative(process.cwd(), path.join(demosDir, `${name}.yaml`))}`);
}

export type RoutineRun = {
  demosDir: string;
  outRoot: string;
  routine: Routine;
  /** Record exactly these, whatever their status. Default: everything not done. */
  only?: string[];
  /** Stop after this many. "I want three videos" is a number, not a schedule. */
  limit?: number;
  /** Stop at the preview capture instead of closing the cycle at full quality. */
  previewOnly?: boolean;
  /** An environment file. When present, the app is brought up clean and proven
      before the first take — and the batch refuses to start if it is not what
      it claims, because an unproven environment costs a take to discover. */
  envFile?: string;
  log: (line: string) => void;
};

export type ItemResult = { name: string; status: PlanItem["status"]; note?: string };

/**
 * Work the plan: stamp, dry-run, record, finish — one item at a time, writing
 * progress to plan.json as it goes so an interrupted batch resumes where it
 * stopped. A failure is recorded and the batch continues; one broken selector
 * should not cost the other four videos.
 */
export async function runRoutine(o: RoutineRun): Promise<ItemResult[]> {
  const { entry } = await import("./paths.js");
  const { spawnSync } = await import("node:child_process");
  const bin = entry("cli");
  const retake = (args: string[]): number => spawnSync(bin.command, [...bin.args, ...args], { stdio: "inherit" }).status ?? 1;

  const items = readPlan(o.demosDir);
  if (!items.length) throw new Error(`no plan in ${path.relative(process.cwd(), planPath(o.demosDir))} — a routine records a list, it does not invent one. Ask your agent for a plan first.`);
  if (o.only?.length) {
    const missing = o.only.filter((n) => !items.some((i) => i.name === n));
    if (missing.length) throw new Error(`not in the plan: ${missing.join(", ")} — have: ${items.map((i) => i.name).join(", ")}`);
  }
  const pending = o.only?.length ? items.filter((i) => o.only!.includes(i.name)) : items.filter((i) => i.status === "todo" || i.status === "failed");
  const queue = o.limit ? pending.slice(0, o.limit) : pending;
  if (!queue.length) { o.log("nothing to record — every plan item is done. `--only <name>` re-records one."); return []; }

  // Bringing the environment up is not a once-per-batch job. A dry run DRIVES
  // the app — it clicks the same buttons the take will — so by the time the
  // camera starts, the app is in the state the dry run left it in. A demo that
  // turns a setting ON then found it already on, turned it off, and waited for
  // "on" until it timed out. So: reset before the dry run, and again before
  // the take, and again before every item after the first.
  const { bringUp, loadEnvSpec, verify } = o.envFile ? await import("./recording-env.js") : ({} as never);
  const spec = o.envFile ? loadEnvSpec(o.envFile) : undefined;
  const freshEnvironment = async (why: string) => {
    if (!spec) return;
    o.log(`environment ${spec.name} — ${why}`);
    const up = await bringUp(spec, o.log);
    o.log(`  up at ${up.url}${up.restarted ? " (restarted)" : ""}`);
    const v = await verify(spec, o.log);
    if (!v.ok) throw new Error("the environment is not what it claims — nothing was recorded. Fix it, or run with no environment file and accept whatever is on screen.");
    o.log("");
  };
  if (spec) await freshEnvironment("before the batch");

  const preset = STYLES[o.routine.style].preset;
  const results: ItemResult[] = [];
  const finish = (item: PlanItem, status: PlanItem["status"], note?: string) => {
    item.status = status; item.note = note;
    writePlan(o.demosDir, items);
    results.push({ name: item.name, status, note });
  };

  o.log(`${queue.length} to record · ${o.routine.style} · ${o.routine.voice === "silent" ? "silent" : voiceId(o.routine.voice)} · captions ${o.routine.captions ? "on" : "off"}`);

  for (const [n, item] of queue.entries()) {
    o.log(`\n── ${n + 1}/${queue.length}  ${item.name} — ${item.story}`);
    let file: string;
    try {
      file = manifestFor(o.demosDir, item.name);
    } catch (e) {
      o.log(`   ✗ ${(e as Error).message}`);
      finish(item, "failed", "no manifest — draft it first");
      continue;
    }

    const { changed, skipped } = applyToManifest(file, o.routine);
    if (changed.length) o.log(`   standard applied — ${changed.join(", ")}`);
    for (const s of skipped) o.log(`   ℹ ${s}`);

    if (spec && n > 0) await freshEnvironment(`before ${item.name}`);
    if (retake(["dry", file]) !== 0) {
      finish(item, "failed", "dry run failed — the app or a selector did not answer");
      // Two in a row usually means the app is not up, not that two demos are
      // wrong. Stopping costs one failure; carrying on costs the whole batch.
      if (results.slice(-2).length === 2 && results.slice(-2).every((x) => x.status === "failed")) {
        o.log(`\nstopped after two failures in a row — is the app running? Start it, then \`retake routine run\` again; the ones already finished are skipped.`);
        break;
      }
      continue;
    }
    // A finished take refuses to record over itself, which is right — the
    // preview cycle is a receipt, and half-clearing it leaves a state where the
    // capture is new and the receipt says a render already happened. `--only`
    // promises a re-record, so give it a genuinely empty folder to land in.
    const out = path.join(o.outRoot, item.name);
    const redo = !!o.only?.length || item.status === "final" || item.status === "recorded";
    if (redo && fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
    // The dry run just drove the app. Put it back before the camera starts.
    if (spec) await freshEnvironment("after the dry run, before the take");
    if (retake(["run", file, "--out", o.outRoot, "--preview"]) !== 0) { finish(item, "failed", "the take stopped — see its proof log"); continue; }
    if (o.previewOnly) { finish(item, "recorded", "preview only"); continue; }

    if (retake(["render", out, file, "--final", "--preset", preset, "--no-master"]) !== 0) { finish(item, "recorded", "preview good, final render failed"); continue; }

    // Held to the north star before it goes anywhere a person will post from.
    const mp4 = path.join(out, "demo.mp4");
    const verdict = await judge(mp4, o.routine, out, o.log);
    if (!verdict.ok) { finish(item, "recorded", `does not match the reference: ${verdict.why.join("; ")}`); continue; }
    if (o.routine.deliver) {
      const dest = path.join(o.routine.deliver.replace(/^~/, os.homedir()), `${item.name}.mp4`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(mp4, dest);
      o.log(`   ✓ delivered → ${dest}`);
    }
    finish(item, "final");
  }

  const final = results.filter((r) => r.status === "final").length;
  const failed = results.filter((r) => r.status === "failed");
  o.log(`\n${final}/${queue.length} finished${failed.length ? ` · ${failed.length} failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  return results;
}

/* ─── proving they match ─────────────────────────────────────────────────────
   A standard nobody measures is a hope. This reads the finished files back —
   the shape, the frame rate, whether there is a voice and how loud it is — and
   says whether a person watching them one after another would see one set or
   several. It reads the OUTPUT, not the manifest, because the manifest is what
   was asked for and the file is what happened. */

export type Measured = {
  name: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  hasAudio: boolean;
  /** Integrated loudness, LUFS. Two voices at different levels is the thing
      people notice first when a playlist moves from one video to the next. */
  lufs: number | null;
};

export type Consistency = { measured: Measured[]; problems: string[] };

export async function measure(files: { name: string; file: string }[], ffmpeg: string): Promise<Measured[]> {
  const { execFile } = await import("node:child_process");
  const run = (args: string[]) => new Promise<string>((done) => {
    execFile(ffmpeg, args, { maxBuffer: 1 << 24 }, (_e, _o, stderr) => done(String(stderr ?? "")));
  });

  const out: Measured[] = [];
  for (const { name, file } of files) {
    const info = await run(["-hide_banner", "-i", file]);
    const dim = /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(info);
    const fps = /,\s*([\d.]+)\s*fps/.exec(info);
    const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(info);
    const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(info);
    let lufs: number | null = null;
    if (hasAudio) {
      const l = await run(["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
      const m = /I:\s*(-?[\d.]+)\s*LUFS/.exec(l.split("Summary").pop() ?? "");
      if (m) lufs = Number(m[1]);
    }
    out.push({
      name,
      width: dim ? Number(dim[1]) : 0,
      height: dim ? Number(dim[2]) : 0,
      fps: fps ? Number(fps[1]) : 0,
      seconds: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
      hasAudio,
      lufs,
    });
  }
  return out;
}

/** What makes a viewer feel they are watching one set rather than several. */
export function compare(measured: Measured[], r: Routine, want?: { width: number; height: number; fps: number }): Consistency {
  const problems: string[] = [];

  // Against the STANDARD first. Two videos can agree with each other and both
  // be wrong — a batch whose final render failed leaves two preview-quality
  // files that match perfectly at the wrong frame rate.
  if (want) {
    for (const m of measured) {
      if (m.width !== want.width || m.height !== want.height) problems.push(`${m.name}: ${m.width}×${m.height}, but ${r.style} is ${want.width}×${want.height}`);
      if (Math.abs(m.fps - want.fps) > 0.5) problems.push(`${m.name}: ${m.fps}fps, but ${r.style} is ${want.fps}fps — this is a preview render that never got finished`);
    }
  }
  if (measured.length < 2) return { measured, problems };

  const group = <T,>(pick: (m: Measured) => T, label: string) => {
    const by = new Map<string, string[]>();
    for (const m of measured) {
      const k = JSON.stringify(pick(m));
      by.set(k, [...(by.get(k) ?? []), m.name]);
    }
    if (by.size > 1) {
      problems.push(`${label} differs — ${[...by.entries()].map(([k, names]) => `${k}: ${names.join(", ")}`).join(" · ")}`);
    }
  };

  group((m) => `${m.width}×${m.height}`, "size");
  group((m) => `${m.fps}fps`, "frame rate");
  group((m) => (m.hasAudio ? "narrated" : "silent"), "sound");

  const wantSilent = r.voice === "silent";
  for (const m of measured) {
    if (wantSilent && m.hasAudio) problems.push(`${m.name}: has a voice, but the routine says silent`);
    if (!wantSilent && !m.hasAudio) problems.push(`${m.name}: silent, but the routine says ${voiceId(r.voice)} — its manifest has no approved script yet`);
  }

  // Loudness is the one people notice without being able to name it: the next
  // video in the playlist is suddenly quieter and they reach for the volume.
  const louds = measured.map((m) => m.lufs).filter((v): v is number => v !== null);
  if (louds.length > 1) {
    const spread = Math.max(...louds) - Math.min(...louds);
    if (spread > 2) problems.push(`loudness spread is ${spread.toFixed(1)} LUFS — anything over 2 makes a viewer reach for the volume between videos`);
  }
  return { measured, problems };
}

/* ─── the north star ─────────────────────────────────────────────────────────
   A routine used to be a list of settings and a hope. Every miss in the
   session this was written in — no cards, the wrong card, captions on, the
   wrong voice, the spacing — was found by a person watching. None of it was
   found by Retake, because Retake had no picture of "right".

   Now a routine can hold one approved video, and Retake compares against it
   twice: BEFORE recording, what the routine cannot reproduce (so a take is
   not the thing that discovers it), and AFTER, how close each cut actually
   came — the opening card, the closing card, the frame around the app, the
   shape and the sound. */

export type ReferenceFacts = { width: number; height: number; fps: number; seconds: number; hasAudio: boolean; lufs: number | null };

/** What the routine cannot reproduce, said before a single take. */
export function preflightAgainst(ref: ReferenceFacts, r: Routine): string[] {
  const out: string[] = [];
  const want = STYLES[r.style];
  const presetSize: Record<string, [number, number]> = { "post-landscape": [1920, 1080], "post-vertical": [1080, 1920], "post-square": [1080, 1080] };
  const size = presetSize[want.preset];
  if (size && (size[0] !== ref.width || size[1] !== ref.height)) out.push(`size: the reference is ${ref.width}×${ref.height}, the ${r.style} style makes ${size[0]}×${size[1]}`);
  if (ref.hasAudio && r.voice === "silent") out.push("sound: the reference is narrated, the routine is silent");
  if (!ref.hasAudio && r.voice !== "silent") out.push("sound: the reference is silent, the routine narrates");
  if (!r.cards) out.push("cards: the routine makes no title or end card — check whether the reference opens on one");
  else if (!r.card) out.push("cards: the routine uses Retake's own card, not a branded one — the reference's card will not be reproduced");
  return out;
}

export type Comparison = { label: string; score: number; pass: boolean; note: string };

/** Structural similarity of two frames, 0..1, via ffmpeg's ssim filter. */
async function ssim(ffmpeg: string, a: string, b: string): Promise<number> {
  const { execFile } = await import("node:child_process");
  const err = await new Promise<string>((done) => execFile(ffmpeg, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=960:540,format=gray[x];[1]scale=960:540,format=gray[y];[x][y]ssim", "-f", "null", "-"], { maxBuffer: 1 << 22 }, (_e, _o, se) => done(String(se ?? ""))));
  const m = /All:([\d.]+)/.exec(err);
  return m ? Number(m[1]) : 0;
}

async function frameAt(ffmpeg: string, video: string, at: number, fromEnd: boolean, out: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const args = fromEnd ? ["-sseof", String(-at)] : ["-ss", String(at)];
  await new Promise<void>((done) => execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, "-i", video, "-frames:v", "1", out], () => done()));
  return out;
}

/** How close one finished cut came to the north star. */
export async function compareToReference(ffmpeg: string, reference: string, candidate: string, r: Routine, work: string): Promise<Comparison[]> {
  fs.mkdirSync(work, { recursive: true });
  const out: Comparison[] = [];
  // A settled moment inside each card: past the fade-in, before the fade-out.
  const settle = Math.max(0.8, Math.min(1.6, r.cardMs / 1000 * 0.55));
  if (r.cards) {
    const [ri, ci] = await Promise.all([frameAt(ffmpeg, reference, settle, false, path.join(work, "ref-intro.png")), frameAt(ffmpeg, candidate, settle, false, path.join(work, "cut-intro.png"))]);
    const si = await ssim(ffmpeg, ri, ci);
    out.push({ label: "opening card", score: si, pass: si >= 0.9, note: si >= 0.9 ? "matches" : "does not look like the reference's opening card" });
    const [ro, co] = await Promise.all([frameAt(ffmpeg, reference, settle, true, path.join(work, "ref-outro.png")), frameAt(ffmpeg, candidate, settle, true, path.join(work, "cut-outro.png"))]);
    const so = await ssim(ffmpeg, ro, co);
    out.push({ label: "closing card", score: so, pass: so >= 0.9, note: so >= 0.9 ? "matches" : "does not look like the reference's closing card" });
  }
  // The frame around the app — the matte and where the app sits — compared on
  // a body frame with the app's own contents blanked: only the border counts.
  const mid = async (v: string, name: string) => {
    const { execFile } = await import("node:child_process");
    const dur = await new Promise<number>((done) => execFile(ffmpeg, ["-hide_banner", "-i", v], (_e, _o, se) => { const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(String(se)); done(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 10); }));
    const f = path.join(work, `${name}-body.png`);
    await new Promise<void>((done) => execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(dur / 2), "-i", v, "-frames:v", "1", "-vf", "drawbox=x=iw*0.08:y=ih*0.09:w=iw*0.84:h=ih*0.82:color=black:t=fill", f], () => done()));
    return f;
  };
  const [rb, cb] = await Promise.all([mid(reference, "ref"), mid(candidate, "cut")]);
  const sb = await ssim(ffmpeg, rb, cb);
  out.push({ label: "frame around the app", score: sb, pass: sb >= 0.95, note: sb >= 0.95 ? "same matte, same inset" : "the matte or the inset differs from the reference" });
  return out;
}


/** Does this cut match the routine's north star? Shape, frame rate, sound and
    loudness against the standard; the cards and the frame against the video. */
export async function judge(mp4: string, r: Routine, workDir: string, log: (l: string) => void): Promise<{ ok: boolean; why: string[] }> {
  const why: string[] = [];
  const { ffmpegBin } = await import("./media-bin.js");
  const { PRESETS } = await import("./presets.js");
  const [m] = await measure([{ name: "cut", file: mp4 }], ffmpegBin());
  const want = PRESETS[STYLES[r.style].preset];
  if (m.width !== want.width || m.height !== want.height) why.push(`${m.width}×${m.height}, not ${want.width}×${want.height}`);
  if (Math.abs(m.fps - want.fps) > 0.5) why.push(`${m.fps}fps, not ${want.fps}`);
  if (r.voice !== "silent" && !m.hasAudio) why.push("silent, but the routine narrates");
  if (r.reference && fs.existsSync(r.reference)) {
    const [ref] = await measure([{ name: "reference", file: r.reference }], ffmpegBin());
    if (ref.lufs !== null && m.lufs !== null && Math.abs(ref.lufs - m.lufs) > 2) why.push(`voice at ${m.lufs.toFixed(1)} LUFS, the reference at ${ref.lufs.toFixed(1)}`);
    for (const sc of await compareToReference(ffmpegBin(), r.reference, mp4, r, path.join(workDir, ".reference"))) {
      log(`   ${sc.pass ? "✓" : "✗"} ${sc.label.padEnd(22)} ${(sc.score * 100).toFixed(1)}%`);
      if (!sc.pass) why.push(`${sc.label} ${(sc.score * 100).toFixed(1)}% alike`);
    }
  }
  return { ok: why.length === 0, why };
}
