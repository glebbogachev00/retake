/**
 * The demo manifest — the one file a human (or later, an agent) writes.
 *
 * It is a superset of a testreel recording definition: the browser/steps
 * vocabulary is testreel's, plus Retake's own layers on top:
 *   - `seed`     what state the app should be in before the camera rolls
 *   - `scene`    step markers that become burned-in captions + the proof log
 *   - `outputs`  which artifacts to produce and how
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { DEFAULT_PRESET, PRESETS, type Layout, type Preset } from "./presets.js";

const Selector = z.string().min(1);

const Base = z.object({
  /** ms to rest after the step. */
  pauseAfter: z.number().nonnegative().optional(),
  /** Selector to wait for before running the step. */
  waitFor: Selector.optional(),
  timeout: z.number().positive().optional(),
  /** This step handles a secret. Its text is never logged, never written to the
      proof log, and never echoed to the UI. Put the value in .env and reference
      it as ${VAR} — do not paste passwords into a manifest. */
  secret: z.boolean().optional(),
});

export const Step = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("wait"), ms: z.number().nonnegative().default(1000) }),
  Base.extend({ action: z.literal("click"), selector: Selector, zoom: z.number().positive().optional() }),
  Base.extend({
    action: z.literal("type"),
    selector: Selector,
    text: z.string(),
    delay: z.number().nonnegative().optional(),
    clear: z.boolean().optional(),
  }),
  Base.extend({ action: z.literal("fill"), selector: Selector, text: z.string() }),
  Base.extend({ action: z.literal("hover"), selector: Selector }),
  /** Scroll by a pixel delta, or `to` a selector — which computes the delta so
      the element lands where you want it and animates there, so the viewer sees
      the page move rather than jumping. */
  Base.extend({
    action: z.literal("scroll"),
    x: z.number().optional(),
    y: z.number().optional(),
    to: Selector.optional(),
    /** Where the target should end up: top | center (default) | bottom. */
    align: z.enum(["top", "center", "bottom"]).default("center"),
  }),
  Base.extend({
    action: z.literal("zoom"),
    selector: Selector.optional(),
    scale: z.number().positive().default(2),
    x: z.number().optional(),
    y: z.number().optional(),
    duration: z.number().positive().optional(),
  }),
  Base.extend({ action: z.literal("keyboard"), key: z.string().min(1) }),
  Base.extend({ action: z.literal("navigate"), url: z.string().min(1) }),
  Base.extend({ action: z.literal("screenshot"), name: z.string().optional() }),
  /** Attach local files to a file input (no OS dialog is involved). */
  Base.extend({ action: z.literal("upload"), selector: Selector, files: z.union([z.string(), z.array(z.string())]) }),
  /** Click something that downloads, and catch the file. Saved next to the
      video as downloads/<name>; `expect` fails the step if the name mismatches. */
  Base.extend({ action: z.literal("download"), selector: Selector.optional(), saveAs: z.string().optional(), expect: z.string().optional() }),
  /** Wait for a selector to appear (Retake extra; the thing testreel's JSON lacks
      for AI-driven apps whose next screen arrives whenever the model answers). */
  Base.extend({ action: z.literal("waitFor"), selector: Selector }),
  /** Run JS in the page (Retake extra). Used for seeding, hiding chrome, etc. */
  Base.extend({ action: z.literal("evaluate"), script: z.string().min(1) }),
  /** Change what a stubbed endpoint answers, mid-take. This is how a demo shows
      something *arriving*: the queue is empty, an action happens, the stub is
      swapped, the next poll shows the new row. */
  Base.extend({
    action: z.literal("stub"),
    url: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    status: z.number().int().optional(),
    json: z.unknown().optional(),
    from: z.string().optional(),
  }),
  /** A named beat. Timestamps go into the proof log; `caption` gets burned into
      the video from this moment until the next scene (or `holdMs`). */
  Base.extend({
    action: z.literal("scene"),
    label: z.string().min(1),
    caption: z.string().optional(),
    holdMs: z.number().positive().optional(),
    /** Where the camera looks during this scene. Omitted → the manifest's
        `camera` policy (auto = focus on the last selector used, static = none). */
    camera: z
      .union([z.literal("static"), z.literal("auto"), z.object({ focus: Selector.optional(), zoom: z.number().min(1).max(3).optional() })])
      .optional(),
  }),
]);
export type Step = z.infer<typeof Step>;

/** Answer a network call with canned data for the length of a take.
    Lets a demo show populated screens when the real backend is unavailable,
    rate-limited, or full of data you must not put on camera. Every stubbed
    pattern is named in the proof log — a take never hides that it was faked. */
export const Stub = z.object({
  /** Glob or regex-ish pattern, Playwright style: "**\/api/requests*". */
  url: z.string().min(1),
  /** Only intercept this method; other methods pass through to the app. */
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  status: z.number().int().default(200),
  /** Inline JSON, or a file next to the manifest. One of the two. */
  json: z.unknown().optional(),
  from: z.string().optional(),
  contentType: z.string().default("application/json; charset=utf-8"),
});
export type Stub = z.infer<typeof Stub>;

export const Seed = z.discriminatedUnion("kind", [
  /** Write a JSON document to a file before the app is touched. Good for apps
      with a file-backed sync hub (Capture: SYNC_DATA_DIR/sync.json). */
  z.object({ kind: z.literal("file"), path: z.string(), from: z.string() }),
  /** Run JS in the page before recording starts, then reload. Good for
      IndexedDB / localStorage-backed apps. `from` is a JSON file exposed as
      `window.__seed` for the script. */
  z.object({ kind: z.literal("evaluate"), script: z.string(), from: z.string().optional() }),
  /** Shell command run before recording (e.g. `curl -X POST …/reset`). */
  z.object({ kind: z.literal("command"), run: z.string() }),
]);
export type Seed = z.infer<typeof Seed>;

export const Manifest = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "kebab-case only"),
  title: z.string().optional(),
  url: z.string().url(),
  /** Quality preset — the publishing format. Fields below override it. */
  preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).default(DEFAULT_PRESET),
  /** Recording viewport (video pixels). Default = the preset's canvas. Give a
      narrow app a narrower viewport (e.g. 1240×1080 for a 620px column at 2×)
      and the card layout centres it in the canvas. */
  viewport: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
  /** CSS zoom applied to the page (2 → app sees half the canvas in CSS px, renders crisp). */
  scale: z.number().min(0.5).max(4).optional(),
  fps: z.number().int().min(10).max(60).optional(),
  crf: z.number().int().min(10).max(35).optional(),
  /** band (default): the site fills the frame, caption strip below · card: the recording framed on a soft canvas · overlay-*: caption over the video · none */
  layout: z.enum(["band", "card", "overlay-bottom", "overlay-top", "none"]).optional(),
  /** auto: each scene zooms toward the last element the demo touched · static: no camera moves. */
  camera: z.union([z.literal("auto"), z.literal("static"), z.object({ zoom: z.number().min(1).max(3) })]).default("auto"),
  /** Seconds cut from the head/tail of the finished video. Render-only: change
      it and re-render, no re-recording. */
  trim: z.object({ head: z.number().nonnegative().default(0), tail: z.number().nonnegative().default(0) }).prefault({}),
  /** Sign in once, reuse the session. `storageState` is a Playwright state file
      (cookies + localStorage) written after `setup` and loaded on later runs, so
      the login only happens when the file is missing or stale. */
  auth: z.object({ storageState: z.string(), maxAgeHours: z.number().positive().default(72) }).optional(),
  captions: z.union([z.boolean(), z.object({ fontSize: z.number().int().optional(), color: z.string().optional() })]).default(true),
  theme: z.object({ background: z.string().optional(), ink: z.string().optional() }).prefault({}),
  colorScheme: z.enum(["light", "dark"]).default("light"),
  /** Ask the page for reduced motion. Apps that respect it lose their infinite
      spinners and entrance animations — steadier frames, smaller files. */
  reducedMotion: z.boolean().default(false),
  waitForSelector: Selector.optional(),
  speed: z.number().positive().default(1),
  /** Cursor overlay (testreel). false → none; {style: touch} → tap dot. Size is preset-scaled unless set. */
  cursor: z.union([z.boolean(), z.object({ style: z.enum(["default", "pointer", "text", "touch"]).optional(), size: z.number().optional(), idleHideMs: z.number().optional() })]).default(true),
  seed: z.array(Seed).default([]),
  /** Canned network responses, armed before the first navigation. */
  stub: z.array(Stub).default([]),
  /** Steps run before the camera rolls. */
  setup: z.array(Step).default([]),
  steps: z.array(Step).min(1),
  outputs: z
    .object({
      mp4: z.boolean().default(true),
      /** GIF is opt-in (secondary): true → preset's GIF settings (or 720px/15fps), or give width/fps. */
      gif: z.union([z.boolean(), z.object({ width: z.number().int().optional(), fps: z.number().int().optional() })]).default(false),
      /** Which scene's frame becomes the thumbnail; default = last scene. */
      thumbnail: z.union([z.boolean(), z.object({ scene: z.string() })]).default(true),
    })
    .prefault({}),
});
export type Manifest = z.infer<typeof Manifest>;

export type LoadedManifest = { manifest: Manifest; file: string; dir: string };

export function loadManifest(file: string): LoadedManifest {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, "utf8");
  const data = abs.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  const parsed = Manifest.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid manifest ${file}:\n${issues}`);
  }
  return { manifest: parsed.data, file: abs, dir: path.dirname(abs) };
}

/** Things worth saying out loud before a run. Not errors — the run proceeds. */
export function warnings(m: Manifest): string[] {
  const w: string[] = [];
  // Secrets typed during recorded steps end up in the video. In `setup` they do
  // not: setup runs before the camera and is trimmed off the front.
  const onCamera = m.steps.filter((s) => s.secret).length;
  if (onCamera) w.push(`${onCamera} step(s) marked secret are in \`steps\`, not \`setup\` — redaction hides them from the logs, but they will be VISIBLE IN THE VIDEO. Move the sign-in into \`setup\`.`);
  for (const s of [...m.steps, ...m.setup]) {
    if ((s.action === "type" || s.action === "fill") && !s.secret && /pass|secret|token|api[-_ ]?key/i.test(s.selector)) {
      w.push(`step "${s.action} ${s.selector}" looks like a credential field but is not marked \`secret: true\` — its text will be logged.`);
    }
  }
  if (m.auth && !m.setup.length) w.push("`auth.storageState` is set but `setup` has no sign-in steps — there is nothing to save a session from.");
  return w;
}

/** `${VAR}` substitution against process.env, like testreel. */
export function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
    const v = process.env[k];
    if (v === undefined) throw new Error(`manifest references \${${k}} but it is not set`);
    return v;
  });
}

/** The preset with the manifest's overrides applied. */
export type Resolved = Preset & {
  /** Recording viewport (video px); canvas is width/height. */
  viewport: { width: number; height: number };
  layout: Layout;
  gif: { width: number; fps: number } | false;
  cursor: false | { style: "default" | "pointer" | "text" | "touch"; size: number; idleHideMs: number };
  captions: false | { fontSize: number; color?: string };
  theme: { background: string; ink: string };
};

export function resolve(m: Manifest): Resolved {
  const p = PRESETS[m.preset] ?? PRESETS[DEFAULT_PRESET];
  const viewport = { width: m.viewport?.width ?? p.width, height: m.viewport?.height ?? p.height };
  const gifOverride = m.outputs.gif;
  const gif = gifOverride === false ? false : gifOverride === true ? p.gif : p.gif === false ? { width: gifOverride.width ?? 720, fps: gifOverride.fps ?? 15 } : { width: gifOverride.width ?? p.gif.width, fps: gifOverride.fps ?? p.gif.fps };
  const cursor = m.cursor === false ? (false as const) : { style: (m.cursor === true ? "default" : m.cursor.style ?? "default") as "default" | "pointer" | "text" | "touch", size: m.cursor === true ? p.cursorSize : m.cursor.size ?? p.cursorSize, idleHideMs: m.cursor === true ? 2000 : m.cursor.idleHideMs ?? 2000 };
  const captions = m.captions === false ? (false as const) : { fontSize: m.captions === true ? p.captionFontSize : m.captions.fontSize ?? p.captionFontSize, color: m.captions === true ? undefined : m.captions.color };
  return {
    ...p,
    viewport,
    scale: m.scale ?? p.scale,
    fps: m.fps ?? p.fps,
    crf: m.crf ?? p.crf,
    layout: m.layout ?? p.layout,
    cameraZoom: typeof m.camera === "object" ? m.camera.zoom : p.cameraZoom,
    gif,
    cursor,
    captions,
    theme: { background: m.theme.background ?? "#e6e9e2", ink: m.theme.ink ?? "#191d19" },
  };
}
