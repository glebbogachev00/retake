/* ─── setting up a new product ───────────────────────────────────────────────
   Capture's routine took a day of lost takes to get right: a reference, a card
   that looks like the brand, an environment that cannot reach the owner's real
   data, and a brief so the next agent does not relearn it all. A new product
   should get the same in one command — point at the app and at one video you
   love, and everything that can be read off those two arrives already decided.

   What cannot be read is said, once, as the next move. Nothing is guessed: a
   colour that is not clearly there stays Retake's, a logo that is not an
   image the card can draw stays out. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { RoutineSchema, type Routine } from "./routine.js";

export type Rgb = [number, number, number];

export const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function luminance([r, g, b]: Rgb): number {
  const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A raw rgb24 frame, small enough to count. */
export type Frame = { width: number; height: number; px: Buffer };

/** The colour most of these pixels share, and how many share it. Bins are
    coarse so a video's compression noise lands in one; the colour returned
    is the bin's average, so it is a real colour from the frame. */
export function dominant(f: Frame, keep: (x: number, y: number, c: Rgb) => boolean = () => true): { color: Rgb; share: number } {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const i = (y * f.width + x) * 3;
      const c: Rgb = [f.px[i], f.px[i + 1], f.px[i + 2]];
      if (!keep(x, y, c)) continue;
      total++;
      const k = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
      const bin = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++; bin.r += c[0]; bin.g += c[1]; bin.b += c[2];
      bins.set(k, bin);
    }
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const b of bins.values()) if (b.n > best.n) best = b;
  if (!best.n) return { color: [0, 0, 0], share: 0 };
  return { color: [best.r / best.n, best.g / best.n, best.b / best.n], share: best.n / total };
}

export type Look = {
  style: "showcase" | "fullscreen" | "mobile";
  /** Opens on a card: one flat ground with a mark and a line on it. */
  cards: boolean;
  card?: { background: string; ink: string };
  /** The matte around an inset app — the routine's theme. */
  theme?: { background: string; ink: string };
  notes: string[];
};

/**
 * Read a north star's look off three frames: just after it opens, the middle,
 * and just before it ends. A card is a frame that is almost all one colour;
 * an inset is a body whose outer ring is one colour and whose middle is not.
 */
export function readLook(frames: { intro: Frame; body: Frame; outro: Frame }, size: { width: number; height: number }): Look {
  const notes: string[] = [];
  const { intro, body, outro } = frames;

  const introGround = dominant(intro);
  const outroGround = dominant(outro);
  const bodyGround = dominant(body);
  // A card is flat; the app never is. Both ends flat and unlike the body.
  const flat = (g: { share: number }) => g.share >= 0.8;
  const cards = flat(introGround) && !(flat(bodyGround) && dist(introGround.color, bodyGround.color) <= 12);

  // The ring: the outer 4% of the body frame on every side.
  const ringW = Math.max(1, Math.round(body.width * 0.04));
  const ringH = Math.max(1, Math.round(body.height * 0.04));
  const inRing = (x: number, y: number) => x < ringW || y < ringH || x >= body.width - ringW || y >= body.height - ringH;
  const ring = dominant(body, (x, y) => inRing(x, y));
  const middle = dominant(body, (x, y) => !inRing(x, y));
  // A one-colour ring is not enough: a dark site is dark to its edges. An
  // inset app is a rectangle — on every row its edge starts at the same column.
  const inset = ring.share >= 0.85 && (middle.share < 0.85 || dist(ring.color, middle.color) > 24) && straightSides(body, ring.color);

  const style: Look["style"] = size.height > size.width ? "mobile" : inset ? "showcase" : "fullscreen";

  let card: Look["card"];
  if (cards) {
    const ground = introGround.color;
    // The ink: the commonest colour that is clearly not the ground — the
    // title's strokes. Anti-aliased edges scatter across bins; solid strokes
    // pile into one.
    const ink = dominant(intro, (_x, _y, c) => dist(c, ground) > 90);
    const inkShare = ink.share * (1 - introGround.share);
    const inkColor: Rgb | null = inkShare >= 0.002 && contrast(ink.color, ground) >= 3 ? ink.color : null;
    // A brand usually inks its card in its matte colour; prefer that exact
    // value when the strokes are close to it — compression shifts strokes.
    const chosen = inset && inkColor && dist(inkColor, ring.color) < 48 ? ring.color : inkColor ?? (inset && contrast(ring.color, ground) >= 3 ? ring.color : null);
    if (!chosen) notes.push("the card's ink could not be read — the title is drawn in black or white, whichever reads on the ground");
    const fallback: Rgb = luminance(ground) > 0.4 ? [17, 17, 17] : [250, 250, 250];
    card = { background: hex(ground), ink: hex(chosen ?? fallback) };
    if (!flat(outroGround)) notes.push("it opens on a card but does not close on one — the routine closes on one too, so the set stays alike");
  } else {
    notes.push("no opening card in the reference — the routine has none either");
  }

  let theme: Look["theme"];
  if (inset) {
    const bg = ring.color;
    const light: Rgb = card ? hexRgb(card.background) : [250, 250, 250];
    const ink = contrast(light, bg) >= 4.5 ? light : luminance(bg) > 0.4 ? [17, 17, 17] as Rgb : [250, 250, 250] as Rgb;
    theme = { background: hex(bg), ink: hex(ink) };
  }
  return { style, cards, card, theme, notes };
}

/** Do the app's left and right edges run straight down the frame, at the
    same column on nearly every row, the way a framed window's do? */
export function straightSides(f: Frame, matte: Rgb): boolean {
  const at = (x: number, y: number): Rgb => { const i = (y * f.width + x) * 3; return [f.px[i], f.px[i + 1], f.px[i + 2]]; };
  const side = (fromLeft: boolean) => {
    const edges: number[] = [];
    for (let y = Math.round(f.height * 0.3); y < Math.round(f.height * 0.7); y++) {
      for (let k = 0; k < f.width / 2; k++) {
        const x = fromLeft ? k : f.width - 1 - k;
        if (dist(at(x, y), matte) > 30) { edges.push(k); break; }
      }
    }
    if (!edges.length) return false;
    const counts = new Map<number, number>();
    for (const e of edges) counts.set(e, (counts.get(e) ?? 0) + 1);
    const [mode] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const near = edges.filter((e) => Math.abs(e - mode) <= 1).length;
    const rows = Math.round(f.height * 0.7) - Math.round(f.height * 0.3);
    return near / rows >= 0.8 && mode >= f.width * 0.01 && mode <= f.width * 0.25;
  };
  return side(true) && side(false);
}

export function hexRgb(h: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** One frame at `t` seconds, scaled down to count. */
export function grabFrame(ffmpeg: string, file: string, t: number, width = 192, height = 108): Frame {
  const px = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, t)), "-i", file,
    "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { maxBuffer: 1 << 24 });
  if (px.length < width * height * 3) throw new Error(`could not read a frame at ${t.toFixed(1)}s of ${file}`);
  return { width, height, px };
}

/* ─── the app ─────────────────────────────────────────────────────────────── */

export function productName(url: string, projectDir?: string): string {
  const raw = projectDir ? path.basename(projectDir) : new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product";
}

export function isLocal(url: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/.test(new URL(url).hostname);
}

/** The directory a local server was started from — the project to restart. */
export function projectOnPort(port: number): string | null {
  try {
    const pid = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
    if (!pid) return null;
    const out = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const dir = out.split("\n").find((l) => l.startsWith("n"))?.slice(1);
    return dir && fs.existsSync(dir) ? dir : null;
  } catch { return null; }
}

/**
 * Names in the project's .env files that can reach a real account or a real
 * database. Only the NAMES are read; a value never leaves the file. Each is
 * blanked for the recording, which is the lesson Capture paid for: its demo
 * instance served the owner's real board because one token in .env.local was
 * still set.
 */
export function reachingVariables(projectDir: string): string[] {
  const files = [".env", ".env.local", ".env.development", ".env.development.local"];
  const reaching = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|DATABASE|POSTGRES|MYSQL|MONGO|REDIS|UPSTASH|SUPABASE|FIREBASE|BLOB|S3_|R2_|STRIPE|CLERK|AUTH0|DSN)/i;
  const names = new Set<string>();
  for (const f of files) {
    const file = path.join(projectDir, f);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || !m[2].trim() || m[2].trim() === '""' || m[2].trim() === "''") continue;
      if (reaching.test(m[1])) names.add(m[1]);
    }
  }
  return [...names].sort();
}

/** A port nothing listens on, near the real one — a different origin, so the
    owner's open tabs and their saved state cannot reach the recording. */
export function isolatedPort(realPort: number, busy: (p: number) => boolean): number {
  for (let p = realPort + 19; p < realPort + 200; p++) if (!busy(p)) return p;
  return realPort + 200;
}

export function environmentYaml(o: { name: string; command: string; cwd: string; port: number; blank: string[]; path: string; present: string[] }): string {
  const doc = new YAML.Document({
    name: o.name,
    start: {
      command: o.command,
      cwd: o.cwd.replace(os.homedir(), "~"),
      port: o.port,
      readySeconds: 180,
      env: Object.fromEntries(o.blank.map((k) => [k, ""])),
    },
    reset: { restart: true, clear: [] },
    expect: { path: o.path, present: o.present, absent: [] },
  });
  doc.commentBefore = [
    ` The app under test, declared — drafted by \`retake routine setup\`.`,
    ` It runs on its own port so your open tabs cannot reach it.`,
  ].join("\n");
  const env = doc.getIn(["start", "env"], true) as YAML.YAMLMap | undefined;
  if (env && o.blank.length) env.commentBefore = ` Blanked, not unset: an explicit "" beats the value in .env.local, so a\n recording cannot reach your real account or database. If the app shows\n nothing without them, give it local data: \`seed\` writes it before start.`;
  const absent = doc.getIn(["expect", "absent"], true) as YAML.YAMLSeq | undefined;
  if (absent) absent.commentBefore = ` Name one thing from your REAL data that must never be on screen —\n a note title, a customer. It is how a leak is caught before it is recorded.`;
  return doc.toString({ lineWidth: 0 });
}

/* ─── the brief ───────────────────────────────────────────────────────────── */

export type Seen = { selector: string; text: string };

export function briefMarkdown(o: {
  name: string; title: string; url: string; reference?: string; facts?: string;
  local: boolean; environment?: string; blank: string[]; seen: Seen[]; hasStyle: boolean;
}): string {
  const rows = o.seen.slice(0, 18).map((s) => `| ${s.text.replace(/\|/g, "\\|").slice(0, 40) || "—"} | \`${s.selector.replace(/\|/g, "\\|")}\` |`);
  return [
    `# Recording ${o.title} — the brief`,
    ``,
    `Read all of this before writing a step. Drafted by \`retake routine setup\`;`,
    `every rule added below should be one that cost a take. If something here is`,
    `wrong, fix this file — the next agent reads it first.`,
    ``,
    `## What you are making`,
    ``,
    o.reference
      ? `A video that looks and sounds like the north star: \`${o.reference}\`${o.facts ? ` (${o.facts})` : ""}. Watch it first.`
      : `No north star yet. \`retake routine reference <video>\` sets the one every cut is held to.`,
    ``,
    `The \`${o.name}\` routine stamps the format, voice, cards and colours onto every`,
    `manifest (\`retake routine\` shows it). Never set \`preset\`, \`layout\`, \`scale\`,`,
    `\`captions\`, \`theme\`, \`card\`, \`intro\`, \`outro\`, \`voiceover.voice\`, \`voiceover.ratePercent\`,`,
    `\`voiceover.align\` or \`music\` yourself.`,
    ``,
    `**Your job is two things: the actions, and the words.**`,
    ``,
    `## The words`,
    ``,
    o.hasStyle ? `Follow \`demos/style.md\` → "Narration".` : `First person, the owner's own use. Why, never how — the viewer sees the cursor.`,
    `One narrated \`scene\` per paragraph, the scene marker before the actions it narrates.`,
    ``,
    `## The app`,
    ``,
    o.local
      ? [
          `Record against \`${o.url}\` only — the isolated instance in \`${o.environment}\`.`,
          `\`retake env up\` starts it, resets it and proves it before anything records.`,
          o.blank.length ? `These are blanked so a take cannot reach real data: ${o.blank.map((b) => `\`${b}\``).join(", ")}.` : `Nothing in its .env files reaches a real account.`,
          `Never open a browser tab on it yourself; probe with \`retake dry\`.`,
        ].join("\n")
      : `A live site: \`${o.url}\`. There is nothing to start or reset — a take shows what the site shows that day.`,
    ``,
    `## Selectors seen on the first screen`,
    ``,
    `Seen by \`retake routine setup\`, not yet proven by a dry run. Move a row to`,
    `"verified" once a dry run has resolved it.`,
    ``,
    `| What | Selector |`,
    `|---|---|`,
    ...(rows.length ? rows : [`| — | nothing interactive on the first screen |`]),
    ``,
    `## Pitfalls that cost takes`,
    ``,
    `None yet. Add each one the moment it costs a take.`,
    ``,
    `## Recording`,
    ``,
    "```bash",
    ...(o.local ? [`retake env up                       # isolated, reset, proven`] : []),
    `retake validate demos/<name>.yaml   # warnings mean something is wrong`,
    `retake dry demos/<name>.yaml        # every selector, no camera`,
    `retake routine run                  # record → render → check → deliver`,
    "```",
    ``,
  ].join("\n");
}

/* ─── the routine ─────────────────────────────────────────────────────────── */

export function routineFor(o: {
  look?: Look; narrated: boolean; inheritVoice?: { voice: string; rate: number };
  reference?: string; brief: string; environment?: string; logo?: string;
}): Routine {
  const look = o.look;
  const voice = o.narrated ? (o.inheritVoice?.voice && o.inheritVoice.voice !== "silent" ? o.inheritVoice.voice : "andrew") : "silent";
  return RoutineSchema.parse({
    style: look?.style ?? "showcase",
    voice,
    rate: o.narrated && o.inheritVoice && o.inheritVoice.voice === voice ? o.inheritVoice.rate : 0,
    captions: false,
    mode: look?.cards ? "launch" : "demo",
    ...(look?.theme ? { theme: look.theme } : {}),
    cards: look?.cards ?? false,
    ...(look?.card ? { card: { ...look.card, ...(o.logo ? { logo: o.logo } : {}) } } : {}),
    ...(o.reference ? { reference: o.reference } : {}),
    brief: o.brief,
    ...(o.environment ? { environment: o.environment } : {}),
  });
}

/* ─── the one command ─────────────────────────────────────────────────────── */

/** The project's own start command, moved to a port of ours. Dev servers
    disagree about flags and agree about $PORT, so both where it is safe. */
export function startOnPort(command: string, script: string, port: number): string {
  if (/^vercel dev\b/.test(command)) return `vercel dev --listen ${port}`;
  const takesFlag = /\b(next|vite|astro|nuxt|remix|react-router|svelte-kit|serve|http-server)\b/.test(script);
  return `PORT=${port} ${command}${takesFlag ? ` -- --port ${port}` : ""}`;
}

/** The brand's mark as the page declares it: an SVG, or a PNG big enough to
    sit on a 1080p card. A 16px favicon is not a mark; it is left out. */
export async function fetchMark(url: string, outBase: string): Promise<string | null> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 }).catch(() => undefined);
    const icons = (await page.evaluate(`[...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')]
      .map((l) => ({ href: l.href, rel: l.rel, type: l.type || "", sizes: (l.sizes && l.sizes.value) || "" }))`)) as { href: string; rel: string; type: string; sizes: string }[];
    const size = (s: string) => Math.max(0, ...s.split(/\s+/).map((v) => Number(v.split("x")[0]) || 0));
    const ranked = icons
      .filter((i) => i.href && !/\.ico(\?|$)/i.test(i.href) && !/mask-icon/.test(i.rel))
      .sort((a, b) => Number(/svg/.test(b.type + b.href)) - Number(/svg/.test(a.type + a.href)) || size(b.sizes) - size(a.sizes));
    for (const icon of ranked) {
      const res = await page.request.get(icon.href).catch(() => null);
      if (!res || !res.ok()) continue;
      const body = await res.body();
      const type = res.headers()["content-type"] ?? "";
      const ext = /svg/.test(type) || /\.svg(\?|$)/i.test(icon.href) ? ".svg" : /png/.test(type) || body.subarray(1, 4).toString() === "PNG" ? ".png" : null;
      if (!ext) continue;
      if (ext === ".png" && body.length > 24 && body.readUInt32BE(16) < 96) continue;
      fs.mkdirSync(path.dirname(outBase), { recursive: true });
      fs.writeFileSync(outBase + ext, body);
      return outBase + ext;
    }
    return null;
  } finally {
    await browser.close();
  }
}

export type SetupOptions = {
  url: string;
  like?: string;
  name?: string;
  /** The project, when nothing is running yet to read it from. */
  dir?: string;
  demosDir: string;
  log: (line: string) => void;
};

export type SetupResult = { name: string; routine: Routine; wrote: string[]; next: string[] };

export async function setupProduct(o: SetupOptions): Promise<SetupResult> {
  const { readRoutines, writeRoutines, starter, measure, preflightAgainst } = await import("./routine.js");
  const url = new URL(o.url);
  const local = isLocal(o.url);
  const realPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const projectDir = local ? (o.dir ? path.resolve(o.dir.replace(/^~/, os.homedir())) : projectOnPort(realPort)) : undefined;
  if (local && !projectDir) {
    throw new Error(`nothing is listening on :${realPort} to learn the project from — start the app once the way you normally do, or pass --dir <project>`);
  }
  const name = o.name ?? productName(o.url, projectDir ?? undefined);
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("the name must be kebab-case — pass --as <name>");
  const existing = readRoutines(o.demosDir);
  if (existing?.routines[name]) throw new Error(`a routine called "${name}" already exists — \`retake routine use ${name}\`, or pass --as <another-name>`);

  const wrote: string[] = [];
  const next: string[] = [];
  const rel = (f: string) => path.relative(process.cwd(), f) || f;
  fs.mkdirSync(o.demosDir, { recursive: true });

  // 1 · the north star — read before anything else, because the card's
  // colours and the frame's shape come from it.
  let reference: string | undefined;
  let look: Look | undefined;
  let narrated = false;
  let facts: string | undefined;
  if (o.like) {
    const src = path.resolve(o.like.replace(/^~/, os.homedir()));
    if (!fs.existsSync(src)) throw new Error(`no such video: ${src}`);
    reference = path.join(o.demosDir, "reference", `${name}${path.extname(src) || ".mp4"}`);
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    if (path.resolve(src) !== path.resolve(reference)) fs.copyFileSync(src, reference);
    wrote.push(rel(reference));
    const { ffmpegBin } = await import("./media-bin.js");
    const ff = ffmpegBin();
    const [m] = await measure([{ name, file: reference }], ff);
    narrated = m.hasAudio;
    facts = `${m.width}×${m.height} · ${m.seconds.toFixed(0)}s · ${m.hasAudio ? "narrated" : "silent"}`;
    look = readLook({
      intro: grabFrame(ff, reference, Math.min(0.8, m.seconds / 4)),
      body: grabFrame(ff, reference, m.seconds / 2),
      outro: grabFrame(ff, reference, Math.max(0, m.seconds - 0.8)),
    }, m);
    o.log(`  north star  ${facts} — ${look.style}${look.cards ? `, cards on ${look.card!.background} in ${look.card!.ink}` : ", no cards"}${look.theme ? `, inset on ${look.theme.background}` : ""}`);
    for (const n of look.notes) o.log(`             ${n}`);
  } else {
    next.push(`retake routine reference <video>   — the one cut you would be happy to get every time; the cards and colours come from it`);
  }

  // 2 · the app — for a local one, its own isolated instance. Nothing below
  // ever opens the port you work on: a browser there carries your real data.
  let target = o.url;
  let environment: string | undefined;
  let blank: string[] = [];
  if (local && projectDir) {
    const { startOffer } = await import("./appserver.js");
    const offer = startOffer(projectDir);
    if (!offer) throw new Error(`${projectDir} has no dev/start script to run — add one, or write the environment by hand (see demos/environment.yaml in the docs)`);
    const { portBusy } = await import("./recording-env.js");
    const port = isolatedPort(realPort, portBusy);
    blank = reachingVariables(projectDir);
    target = `http://localhost:${port}${url.pathname}${url.search}`;
    environment = path.join(o.demosDir, "environments", `${name}.yaml`);
    fs.mkdirSync(path.dirname(environment), { recursive: true });
    const draft = { name, command: startOnPort(offer.command, offer.script, port), cwd: projectDir, port, blank, path: url.pathname || "/", present: [] as string[] };
    fs.writeFileSync(environment, environmentYaml(draft));
    wrote.push(rel(environment));
    o.log(`  app         ${projectDir.replace(os.homedir(), "~")} · \`${draft.command}\` on :${port}, not :${realPort}`);
    if (blank.length) o.log(`             blanked for every take: ${blank.join(", ")} — a recording cannot reach your real account`);

    const { bringUp, loadEnvSpec } = await import("./recording-env.js");
    try {
      await bringUp(loadEnvSpec(environment), (l) => o.log(`  ${l.trim()}`));
    } catch (e) {
      next.unshift(`the isolated app did not start: ${(e as Error).message}. Fix that, then \`retake env up\`.`);
      target = "";
    }
  }

  // 3 · what is on the first screen, and the brand's mark — read from the
  // isolated instance or the live site, never from your own tab.
  let seen: Seen[] = [];
  let logo: string | undefined;
  if (target) {
    const { scout } = await import("./describe.js");
    try {
      const s = await scout(target, { timeoutMs: 30_000 });
      seen = s.elements
        .map((e) => ({ selector: e.selector, text: (e.text || e.placeholder || "").trim() }))
        .filter((e) => e.text);
      o.log(`  first screen “${s.title || target}” — ${seen.length} things to act on`);
    } catch (e) {
      o.log(`  could not read the first screen: ${(e as Error).message.split("\n")[0]}`);
    }
    if (look?.cards) {
      const mark = await fetchMark(target, path.join(o.demosDir, "brand", `${name}-mark`)).catch(() => null);
      if (mark) { logo = rel(mark); wrote.push(logo); o.log(`  mark        ${logo}`); }
      else next.push(`no mark the card can draw was found on the page (an SVG or a large PNG) — put one at demos/brand/${name}-mark.svg and \`retake routine set\` will not need touching: setup reads it on the next run`);
    }
    if (environment && seen.length) {
      // Proof the right app answered: two things the first screen showed.
      const spec = YAML.parseDocument(fs.readFileSync(environment, "utf8"));
      spec.setIn(["expect", "present"], seen.slice(0, 2).map((s) => s.selector));
      fs.writeFileSync(environment, spec.toString({ lineWidth: 0 }));
    }
  }

  // 4 · the brief the next agent reads first.
  const brief = path.join(o.demosDir, `${name}.md`);
  if (fs.existsSync(brief)) {
    o.log(`  brief       ${rel(brief)} already exists — kept as it is`);
  } else {
    fs.writeFileSync(brief, briefMarkdown({
      name, title: name.replace(/(^|-)([a-z])/g, (_m, d, c) => (d ? " " : "") + c.toUpperCase()),
      url: target || o.url, reference: reference && rel(reference), facts, local,
      environment: environment && rel(environment), blank, seen,
      hasStyle: fs.existsSync(path.join(o.demosDir, "style.md")),
    }));
    wrote.push(rel(brief));
  }

  // 5 · the routine itself, made the one in use.
  const current = existing ? existing.routines[existing.use] : undefined;
  const routine = routineFor({
    look, narrated,
    inheritVoice: current ? { voice: current.voice, rate: current.rate } : undefined,
    reference: reference && rel(reference), brief: rel(brief), environment: environment && rel(environment), logo,
  });
  const file = existing ?? starter();
  if (!existing) delete (file.routines as Record<string, Routine>).default;
  file.routines[name] = routine;
  const previous = existing?.use;
  file.use = name;
  writeRoutines(o.demosDir, file);
  wrote.push(rel(path.join(o.demosDir, "routine.json")));

  if (reference) {
    const { ffmpegBin } = await import("./media-bin.js");
    const [ref] = await measure([{ name, file: reference }], ffmpegBin());
    for (const g of preflightAgainst(ref, routine)) next.push(g);
  }
  if (look?.cards) next.push(`the north star closes on a card, and its words cannot be read off a video — \`retake routine set outro "<its line>"\``);
  if (environment && target) next.push(`the isolated app is still running on ${new URL(target).host} — \`retake env down\` stops it`);
  if (environment) next.push(`name one thing from your real data in ${rel(environment)} → expect.absent — the check that catches a leak before it is recorded`);
  if (previous && previous !== name) next.push(`\`retake routine use ${previous}\` switches back`);
  return { name, routine, wrote, next };
}
