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
import { createHmac } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { DEFAULT_PRESET, PRESETS, type Layout, type Preset } from "./presets.js";

const Selector = z.string().min(1);

/** Where a pointer goes: a selector (its centre), a raw viewport point, or a
    selector plus an offset. Points are resolved by reading the rect in the
    page rather than through Playwright's locator engine, because canvas
    editors (Blockly, PixiJS) intercept pointer events and make ordinary
    locators time out. */
export const Point = z.union([
  Selector,
  z.object({ x: z.number(), y: z.number() }),
  z.object({ selector: Selector, dx: z.number().default(0), dy: z.number().default(0) }),
]);
export type Point = z.infer<typeof Point>;

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
  Base.extend({ action: z.literal("click"), selector: Selector.optional(), at: Point.optional(), zoom: z.number().positive().optional() }),
  Base.extend({
    action: z.literal("type"),
    selector: Selector,
    text: z.string(),
    delay: z.number().nonnegative().optional(),
    clear: z.boolean().optional(),
  }),
  Base.extend({ action: z.literal("fill"), selector: Selector, text: z.string() }),
  Base.extend({ action: z.literal("hover"), selector: Selector.optional(), at: Point.optional() }),
  /** Scroll by a pixel delta, or `to` a selector — which computes the delta so
      the element lands where you want it and animates there, so the viewer sees
      the page move rather than jumping. */
  /** Press at one point, move, release: the gesture that block editors,
      canvases and sortable lists are built on. The cursor overlay gets two
      keyframes (start, end) while the page gets many small moves, so a drag
      costs the overlay no more than a click does. */
  Base.extend({
    action: z.literal("drag"),
    from: Point,
    to: Point,
    /** Intermediate mouse moves. The page needs several to believe a drag. */
    steps: z.number().int().min(4).max(60).default(16),
    /** Pause after pressing, before moving. Some editors need it. */
    holdMs: z.number().int().min(0).max(2000).default(120),
    /** How long the move takes, ms. */
    durationMs: z.number().int().min(120).max(6000).default(700),
  }),
  Base.extend({
    action: z.literal("scroll"),
    x: z.number().optional(),
    y: z.number().optional(),
    /** A selector to bring into view, or "top" / "bottom" of the page.
        (x/y are a relative nudge in pixels — y: 0 moves nothing.) */
    to: z.union([z.literal("top"), z.literal("bottom"), Selector]).optional(),
    /** Where the target should end up: top | center (default) | bottom. */
    align: z.enum(["top", "center", "bottom"]).default("center"),
    /** How fast to move. 1 is the default 600ms; below 1 is slower, so
        `speed: 0.4` takes 1.5s. A long scroll at full speed reads as a jump —
        slow it down and the viewer can follow what went past. */
    speed: z.number().positive().max(4).optional(),
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
]).superRefine((st, ctx) => {
  if ((st.action === "click" || st.action === "hover") && !st.selector && !st.at) {
    ctx.addIssue({ code: "custom", message: `${st.action} needs either a selector or an \`at\` point` });
  }
});
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
  z.object({
    kind: z.literal("file"), path: z.string(), from: z.string(),
    /** Resolve "-12d", "+6h", "now" strings in the JSON to epoch ms at seed
        time, so a fixture that says "three days ago" still says it next
        month. Every app with relative dates in its UI needs this. */
    relativeDates: z.boolean().default(false),
  }),
  /** Run JS in the page before recording starts, then reload. Good for
      IndexedDB / localStorage-backed apps. `from` is a JSON file exposed as
      `window.__seed` for the script. */
  z.object({ kind: z.literal("evaluate"), script: z.string(), from: z.string().optional() }),
  /** Shell command run before recording (e.g. `curl -X POST …/reset`). */
  z.object({ kind: z.literal("command"), run: z.string() }),
]);
export type Seed = z.infer<typeof Seed>;

const ManifestShape = z.object({
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
  /** Still by default. A zoom is something a person asks for after seeing a
      take, never something that happens to them: a calm demo reads as real
      and can never crop the wrong thing. `auto` eases toward the last thing
      touched; a scene can override either way. */
  camera: z.union([z.literal("auto"), z.literal("static"), z.object({ zoom: z.number().min(1).max(3) })]).default("static"),
  /** Seconds cut from the head/tail of the finished video. Render-only: change
      it and re-render, no re-recording. */
  trim: z.object({ head: z.number().nonnegative().default(0), tail: z.number().nonnegative().default(0) }).prefault({}),
  /** Sign in once, reuse the session. `storageState` is a Playwright state file
      (cookies + localStorage) written after `setup` and loaded on later runs, so
      the login only happens when the file is missing or stale. */
  auth: z
    .object({
      storageState: z.string(),
      maxAgeHours: z.number().positive().default(72),
      /** The sign-in steps themselves. These are the ONLY steps skipped when a
          saved session is reused — `setup` always runs, because it usually
          contains things that have nothing to do with logging in. */
      setup: z.array(Step).default([]),
    })
    .optional(),
  captions: z.union([z.boolean(), z.object({ fontSize: z.number().int().optional(), color: z.string().optional() })]).default(true),
  theme: z.object({ background: z.string().optional(), ink: z.string().optional() }).prefault({}),
  colorScheme: z.enum(["light", "dark"]).default("light"),
  /** Ask the page for reduced motion. Apps that respect it lose their infinite
      spinners and entrance animations — steadier frames, smaller files. */
  reducedMotion: z.boolean().default(false),
  waitForSelector: Selector.optional(),
  speed: z.number().positive().default(1),
  /** Cursor overlay (testreel). false → none; {style: touch} → tap dot. Size is preset-scaled unless set. */
  /** cursor.idleHide: fade the cursor out when idle (testreel default). Long
      demos used to lose it (nested-if depth in ffmpeg); the flat cursor
      expressions lifted that, so it is simply on unless you say otherwise. */
  cursor: z.union([z.boolean(), z.object({ style: z.enum(["default", "pointer", "text", "touch"]).optional(), size: z.number().optional(), idleHideMs: z.number().optional(), idleHide: z.boolean().optional() })]).default(true),
  seed: z.array(Seed).default([]),
  /** What a failed step does to the take. "stop" (default): the camera stops
      at the failure, so nobody gets one interaction and ten minutes of
      nothing. "continue": keep rolling — for demos that tolerate a miss. */
  /** A demo that opens a second tab loses its subject: Retake records one
      page. By default new tabs are folded back into this one (window.open and
      target=_blank navigate in place), so the flow stays on camera. Set false
      when a demo genuinely needs a separate window. */
  keepInTab: z.boolean().default(true),
  /** Demos that share live state (one Capture hub, one test account) must
      not run at once: the second take's seed wipes the first take's board
      mid-video. Name the shared thing; takes holding the same name queue. */
  lock: z.string().regex(/^[a-z0-9-]+$/).optional(),
  onFail: z.enum(["stop", "continue"]).default("stop"),
  /** Playback tempo applied at render time: 0.8 slows the whole take for a
      client who needs it gentler; 1.2 tightens it. Cursor and clicks stay in
      sync by construction (they are pixels in the recording); captions are
      retimed to match. Re-render only — never a re-record. */
  tempo: z.number().min(0.5).max(2).default(1),
  /** Hard ceiling on a take, seconds. Unset, it scales with the demo
      (≈10s per step plus the explicit waits, never under 240s): the cap is
      for a take that is stuck, not one that is long. Set it to override. */
  maxSeconds: z.number().int().min(10).max(3600).optional(),
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
      /** One PNG per scene, into outputs/<name>/stills/. */
      stills: z.boolean().default(true),
    })
    .prefault({}),
});
export const Manifest = ManifestShape.superRefine((m, ctx) => {
  [...m.steps, ...m.setup].forEach((st, i) => {
    if ((st.action === "click" || st.action === "hover") && !st.selector && !st.at) {
      ctx.addIssue({ code: "custom", path: ["steps", i], message: `${st.action} needs either a selector or an \`at\` point` });
    }
  });
  // Scenes are addressed by label (thumbnail, captions, camera, stills,
  // until); two with the same label make every one of those ambiguous.
  const seen = new Map<string, number>();
  m.steps.forEach((st, i) => {
    if (st.action !== "scene") return;
    if (seen.has(st.label)) ctx.addIssue({ code: "custom", path: ["steps", i, "label"], message: `duplicate scene label "${st.label}" (also step ${seen.get(st.label)}) — labels must be unique` });
    else seen.set(st.label, i);
  });
});
export type Manifest = z.infer<typeof Manifest>;

export type LoadedManifest = { manifest: Manifest; file: string; dir: string };

export function loadManifest(file: string): LoadedManifest {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, "utf8");
  let data: unknown;
  try {
    data = abs.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  } catch (e) {
    // The classic trap: a one-line JS object literal under `script:` is a
    // YAML mapping, and the parser fails before validation ever runs. Find
    // the line it choked on; if that line carries a script, say so.
    const err = e as Error & { linePos?: { line: number }[] };
    const line = err.linePos?.[0]?.line;
    const src = line ? raw.split("\n")[line - 1] ?? "" : "";
    const hint = /\bscript:/.test(src) || /compact mappings/.test(err.message) ? "\n  hint: a one-line script with braces parses as YAML, not JS — write it as a block:\n    script: |\n      window.scrollTo({ top: 0 })" : "";
    throw new Error(`Could not parse ${file}: ${err.message.split("\n")[0]}${hint}`);
  }
  const parsed = Manifest.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const where = i.path.join(".") || "(root)";
      // The classic trap: a one-line JS object literal under `script:` parses
      // as a YAML mapping. Name it, or everyone hits it once.
      const hint = where.endsWith(".script") && /expected string/i.test(i.message) ? " — a one-line script with braces parses as YAML; write it as a block:  script: |" : "";
      return `  - ${where}: ${i.message}${hint}`;
    }).join("\n");
    throw new Error(`Invalid manifest ${file}:\n${issues}`);
  }
  const dir = path.dirname(abs);
  // A fixture page can live next to its manifest: `url: file://./page.html`
  // resolves against the manifest's folder, so a cloned repo's demos work.
  const m = parsed.data;
  const rel = /^file:\/\/(\.{1,2}\/.*)$/.exec(m.url);
  if (rel) m.url = "file://" + path.resolve(dir, rel[1]);
  return { manifest: m, file: abs, dir };
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
  if (m.auth && !m.auth.setup.length && !m.setup.length) w.push("`auth.storageState` is set but there are no sign-in steps under `auth.setup` — there is nothing to save a session from.");
  const moves = m.steps.filter((st) => ["click", "type", "fill", "hover", "scroll", "upload"].includes(st.action)).length;
  if (m.cursor !== false && moves > 180) w.push(`~${moves} cursor moves — past ~180 in one take the cursor filter no longer fits in one ffmpeg argument and the overlay will be MISSING. Split the demo into chapters, or set \`cursor: false\`.`);
  m.steps.forEach((st, i) => {
    if (st.action !== "scene") return;
    const rest = m.steps.slice(i + 1);
    const nextScene = rest.findIndex((x) => x.action === "scene");
    const between = nextScene === -1 ? rest : rest.slice(0, nextScene);
    // A closing hold on the payoff is normal; only a waits-only scene *followed by another* is empty.
    if (nextScene !== -1 && between.length && between.every((x) => x.action === "wait")) w.push(`scene "${st.label}" has only waits before the next scene — nothing happens on camera in it.`);
  });
  return w;
}

/** `${VAR}` substitution against process.env, like testreel. */
export function expandEnv(s: string): string {
  return s.replace(/\$\{(TOTP:)?([A-Z0-9_]+)\}/g, (_, fn: string | undefined, k: string) => {
    const v = process.env[k];
    // `APP_USER=` with nothing after it is the template, not a value — a blank
    // login that "succeeds" is worse than a loud stop.
    if (v === undefined || v.trim() === "") throw new Error(`manifest references \${${k}} but it is not set — add it to .env (a demo account, never a real one)`);
    // ${TOTP:APP_TOTP_SECRET}: the six-digit code for right now, from an
    // authenticator enrolment secret. Computed at fill time, so it is valid.
    return fn ? totp(v) : v;
  });
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s) from a base32 secret — what every
    authenticator app enrols with. */
export function totp(base32Secret: string, nowMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

/** The preset with the manifest's overrides applied. */
export type Resolved = Preset & {
  /** Recording viewport (video px); canvas is width/height. */
  viewport: { width: number; height: number };
  layout: Layout;
  gif: { width: number; fps: number } | false;
  cursor: false | { style: "default" | "pointer" | "text" | "touch"; size: number; idleHideMs: number; idleHide: boolean | undefined };
  captions: false | { fontSize: number; color?: string };
  theme: { background: string; ink: string };
};

export function resolve(m: Manifest): Resolved {
  const p = PRESETS[m.preset] ?? PRESETS[DEFAULT_PRESET];
  const viewport = { width: m.viewport?.width ?? p.width, height: m.viewport?.height ?? p.height };
  const gifOverride = m.outputs.gif;
  /* `gif: true` means "yes, a GIF" on any preset. Only docs-gif carries GIF
     settings, so asking for one anywhere else used to resolve to the preset's
     `false` and produce nothing, silently. */
  const GIF_DEFAULT = { width: 900, fps: 15 };
  const gif = gifOverride === false ? false
    : gifOverride === true ? (p.gif === false ? GIF_DEFAULT : p.gif)
    : p.gif === false ? { width: gifOverride.width ?? GIF_DEFAULT.width, fps: gifOverride.fps ?? GIF_DEFAULT.fps }
    : { width: gifOverride.width ?? p.gif.width, fps: gifOverride.fps ?? p.gif.fps };
  const cursor = m.cursor === false ? (false as const) : { style: (m.cursor === true ? "default" : m.cursor.style ?? "default") as "default" | "pointer" | "text" | "touch", size: m.cursor === true ? p.cursorSize : m.cursor.size ?? p.cursorSize, idleHideMs: m.cursor === true ? 2000 : m.cursor.idleHideMs ?? 2000, idleHide: m.cursor === true ? undefined : m.cursor.idleHide };
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
