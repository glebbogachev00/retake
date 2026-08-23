/**
 * Describe mode: URL + one sentence → a draft manifest in the editor.
 *
 * The model never records. Retake scouts the page with Playwright (what is on
 * it, what can be clicked, real selectors), hands that plus the user's sentence
 * to a model, and asks for YAML that fits our schema. The draft is validated;
 * one retry with the validation errors; then it is the user's to edit and run.
 *
 * Providers:
 *   RETAKE_MODEL=claude-code   the `claude` CLI already signed in on this machine (claude -p) — no key
 *   RETAKE_MODEL=codex         the `codex` CLI already signed in on this machine (codex exec) — no key
 *   RETAKE_MODEL=groq          GROQ_API_KEY      RETAKE_GROQ_MODEL     (default openai/gpt-oss-120b)
 *   RETAKE_MODEL=mistral       MISTRAL_API_KEY   RETAKE_MISTRAL_MODEL  (default mistral-small-latest)
 *   RETAKE_MODEL=local         RETAKE_LOCAL_URL  RETAKE_LOCAL_MODEL    (http://localhost:11434/v1 + llama3.1 — Ollama/LM Studio)
 * The hosted ones speak OpenAI-compatible chat/completions via plain fetch; the CLIs are spawned.
 * If RETAKE_MODEL is unset, the first available in the order above is used.
 * A `.env` in the Retake root is loaded at startup (KEY=value lines).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { chromium } from "playwright";
import YAML from "yaml";
import { Manifest } from "./manifest.js";
import { digest, type Digest } from "./digest.js";

export function loadDotenv(root: string, files = [".env"]) {
  // One parser for every reader of .env (see env.ts), so a password written
  // by the window or `retake secret` is typed back exactly as entered.
  for (const name of files) {
    for (const [k, v] of Object.entries(parseEnvText(root, name))) if (process.env[k] === undefined) process.env[k] = v;
  }
}
function parseEnvText(root: string, name: string): Record<string, string> {
  const f = path.join(root, name);
  if (!fs.existsSync(f)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) { try { out[m[1]] = JSON.parse(v); continue; } catch { /* literal */ } }
    out[m[1]] = v.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export type Provider = { name: "claude-code" | "codex" | "groq" | "mistral" | "local"; baseUrl: string; key: string; model: string };

function cliPath(bin: string): string | null {
  const home = os.homedir();
  for (const p of [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`, `${home}/.local/bin/${bin}`, `${home}/.npm-global/bin/${bin}`]) if (fs.existsSync(p)) return p;
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function pickProvider(): Provider | null {
  const want = process.env.RETAKE_MODEL;
  const claude = cliPath("claude"), codex = cliPath("codex");
  const all: (Provider | null)[] = [
    claude ? { name: "claude-code", baseUrl: claude, key: "", model: process.env.RETAKE_CLAUDE_MODEL ?? "default" } : null,
    codex ? { name: "codex", baseUrl: codex, key: "", model: process.env.RETAKE_CODEX_MODEL ?? "default" } : null,
    process.env.GROQ_API_KEY
      ? { name: "groq", baseUrl: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY, model: process.env.RETAKE_GROQ_MODEL ?? "openai/gpt-oss-120b" }
      : null,
    process.env.MISTRAL_API_KEY
      ? { name: "mistral", baseUrl: "https://api.mistral.ai/v1", key: process.env.MISTRAL_API_KEY, model: process.env.RETAKE_MISTRAL_MODEL ?? "mistral-small-latest" }
      : null,
    process.env.RETAKE_LOCAL_URL
      ? { name: "local", baseUrl: process.env.RETAKE_LOCAL_URL.replace(/\/$/, ""), key: process.env.RETAKE_LOCAL_KEY ?? "local", model: process.env.RETAKE_LOCAL_MODEL ?? "llama3.1" }
      : null,
  ];
  if (want) return all.find((p) => p?.name === want) ?? null;
  return all.find(Boolean) ?? null;
}

export function providerStatus(): { active: string | null; available: string[] } {
  const p = pickProvider();
  const available = ["claude-code", "codex", "groq", "mistral", "local"].filter((n) => (n === "claude-code" && cliPath("claude")) || (n === "codex" && cliPath("codex")) || (n === "groq" && process.env.GROQ_API_KEY) || (n === "mistral" && process.env.MISTRAL_API_KEY) || (n === "local" && process.env.RETAKE_LOCAL_URL));
  return { active: p ? `${p.name} · ${p.model}` : null, available };
}

async function chat(p: Provider, system: string, user: string, projectDir?: string): Promise<string> {
  if (p.name === "claude-code" || p.name === "codex") return chatCli(p, system, user, projectDir);
  const r = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
    body: JSON.stringify({ model: p.model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`${p.name} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error(`${p.name} returned no text`);
  return text;
}

/** The signed-in CLIs: one prompt in, text out. No tools, no keys, uses the user's own subscription. */
function chatCli(p: Provider, system: string, user: string, projectDir?: string): string {
  const prompt = `${system}\n\n${user}`;
  const modelArgs = p.model && p.model !== "default" ? ["--model", p.model] : [];
  // A clean env: when Retake itself runs inside a Claude Code session, the
  // inherited CLAUDE*/ANTHROPIC* vars would point the child at the wrong auth.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v;
  let r;
  if (p.name === "claude-code") {
    // With a project folder, let it read the repo itself — that is where the
    // routes, the login and the real selectors live. Read-only tools only.
    const args = projectDir
      ? ["-p", "--output-format", "text", "--add-dir", projectDir, "--allowedTools", "Read,Grep,Glob", ...modelArgs]
      : ["-p", "--output-format", "text", "--disallowedTools", "*", ...modelArgs];
    r = spawnSync(p.baseUrl, args, { input: prompt, encoding: "utf8", timeout: 180_000, maxBuffer: 8e6, env });
    if (r.status !== 0 && /401|revoked|authenticate/i.test(r.stdout + r.stderr)) {
      // Nested inside another Claude Code session the keychain entry can be a
      // revoked session token; a minimal env falls back to the saved login.
      r = spawnSync(p.baseUrl, args, { input: prompt, encoding: "utf8", timeout: 180_000, maxBuffer: 8e6, env: { HOME: env.HOME ?? os.homedir(), PATH: env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" } });
    }
  } else {
    const out = path.join(os.tmpdir(), `retake-codex-${process.pid}.txt`);
    const catalogPath = path.join(os.tmpdir(), `retake-codex-models-${process.pid}.json`);
    try {
      const bundled = spawnSync(p.baseUrl, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4e6, env });
      if (bundled.status !== 0 || !bundled.stdout) throw new Error(`could not read Codex's bundled model catalog: ${bundled.stderr || "no output"}`);
      JSON.parse(bundled.stdout);
      fs.writeFileSync(catalogPath, bundled.stdout);
      r = spawnSync(p.baseUrl, ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never", "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`, ...(process.env.RETAKE_CODEX_REASONING ? ["-c", `model_reasoning_effort=${JSON.stringify(process.env.RETAKE_CODEX_REASONING)}`] : []), ...(projectDir ? ["-C", projectDir] : []), "-o", out, ...(modelArgs.length ? ["-m", p.model] : []), "-"], { input: prompt, encoding: "utf8", timeout: 180_000, maxBuffer: 8e6, env });
      if (fs.existsSync(out)) { const t = fs.readFileSync(out, "utf8"); fs.rmSync(out, { force: true }); if (t.trim()) return t; }
    } finally { fs.rmSync(catalogPath, { force: true }); }
  }
  if (r.error) throw new Error(`${p.name}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${p.name} exited ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  const text = (r.stdout || "").trim();
  if (!text) throw new Error(`${p.name} returned no text`);
  return text;
}

// --- scouting ---------------------------------------------------------------

const SCOUT_SCRIPT = String.raw`(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const uniq = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const selectorFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("id");
    if (id && uniq("#" + cssEsc(id))) return "#" + cssEsc(id);
    const tid = el.getAttribute("data-testid");
    if (tid) return '[data-testid="' + tid + '"]';
    const aria = el.getAttribute("aria-label");
    if (aria && uniq(tag + '[aria-label="' + aria + '"]')) return tag + '[aria-label="' + aria + '"]';
    const ph = el.getAttribute("placeholder");
    if (ph && uniq(tag + '[placeholder="' + ph + '"]')) return tag + '[placeholder="' + ph + '"]';
    const cls = Array.from(el.classList).filter((c) => !/^\d|^(on|active|selected|focus|hover)$/.test(c)).slice(0, 2);
    if (cls.length && uniq(tag + "." + cls.map(cssEsc).join("."))) return tag + "." + cls.map(cssEsc).join(".");
    const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (txt && (tag === "button" || tag === "a")) {
      // Playwright's nth counts hidden matches too, so index over all of them.
      const same = Array.from(document.querySelectorAll(tag)).filter((o) => (o.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) === txt);
      const base = tag + ':has-text("' + txt.replace(/"/g, '\\"') + '")';
      return same.length > 1 ? base + " >> nth=" + same.indexOf(el) : base;
    }
    if (cls.length) return tag + "." + cls.map(cssEsc).join(".");
    return tag;
  };
  const els = Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=tab], [contenteditable=true]"))
    .filter(vis).slice(0, 80)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("value") || "").trim().replace(/\s+/g, " ").slice(0, 60),
      role: el.getAttribute("role") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      href: el.getAttribute("href") || undefined,
    }));
  const headings = Array.from(document.querySelectorAll("h1,h2,h3")).filter(vis).map((h) => (h.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80)).filter(Boolean).slice(0, 20);
  const text = (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1800);
  return { title: document.title, headings, text, elements: els };
})()`;

export type Scout = {
  url: string;
  title: string;
  headings: string[];
  text: string;
  elements: { tag: string; selector: string; text: string; role?: string; placeholder?: string; href?: string }[];
};

export async function scout(url: string, opts: { viewport?: { width: number; height: number }; timeoutMs?: number } = {}): Promise<Scout> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1000, height: 700 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs ?? 20_000 });
    await page.waitForTimeout(600);
    // A string, not a function: tsx/esbuild's keepNames would inject a `__name`
    // helper that does not exist inside the page.
    const scouted = (await page.evaluate(SCOUT_SCRIPT)) as Omit<Scout, "url">;
    return { url, ...scouted };
  } finally {
    await browser.close();
  }
}

// --- ideas -------------------------------------------------------------------

export type Idea = { title: string; story: string; length: string; why: string };

/** Look at an app (its page, and its source when given) and propose demos worth
    recording. Output is a markdown file you can keep, plus a parsed list the UI
    turns into one-click starting points. */
export async function suggestIdeas(input: { url: string; scout: Scout; provider: Provider; project?: string }): Promise<{ markdown: string; ideas: Idea[] }> {
  const { url, scout: sc, provider } = input;
  const dg = input.project ? digest(input.project) : undefined;
  const system = [
    "You propose short silent product demos worth recording — the kind that make someone understand an app in 30 seconds.",
    "Answer in markdown, nothing else. For each idea use exactly this shape:",
    "",
    "## <short title>",
    "**Story:** one sentence a person could act out in the app, naming the concrete screens/actions.",
    "**Length:** ~25s",
    "**Why it lands:** one sentence on what a viewer understands afterwards.",
    "",
    "Rules: 5 to 7 ideas, best first. Every idea must be recordable in ONE continuous browser run with no new tabs. Prefer flows that end in a visible result, not tours of menus. Use the app's real vocabulary. No marketing adjectives.",
  ].join("\n");
  const user = [
    `App: ${url}`,
    `Page title: ${sc.title}`,
    `Headings: ${sc.headings.join(" | ")}`,
    `Visible controls: ${sc.elements.map((e) => e.text || e.placeholder || e.selector).filter(Boolean).slice(0, 40).join(" · ")}`,
    `Page text: ${sc.text.slice(0, 1200)}`,
    ...(dg ? ["", "The project's source says:", dg.text] : []),
    "",
    "Propose the demos.",
  ].join("\n");
  const markdown = (await chat(provider, system, user, input.project)).replace(/^```[a-z]*\n?/im, "").replace(/```\s*$/m, "").trim();
  const ideas: Idea[] = [];
  for (const block of markdown.split(/^##\s+/m).slice(1)) {
    const lines = block.split("\n");
    const title = lines[0].trim();
    const field = (k: string) => (new RegExp(`\\*\\*${k}:?\\*\\*\\s*(.+)`, "i").exec(block)?.[1] ?? "").trim();
    if (title) ideas.push({ title, story: field("Story"), length: field("Length"), why: field("Why it lands") });
  }
  return { markdown, ideas };
}

// --- fixing ------------------------------------------------------------------

/** A small, fixed vocabulary of edits. The model picks from these; Retake
    applies them to the YAML document (comments kept) and already knows which
    ones need the browser again. Deliberately narrow — reliability first. */
export const EDIT_VERBS = [
  "set_caption",      // {scene, caption}
  "set_camera",       // {scene, camera: "auto"|"static"|number}
  "set_hold",         // {scene, holdMs}
  "set_trim",         // {head?, tail?}  seconds off each end
  "set_format",       // {preset}
  "set_layout",       // {layout}
  "add_wait",         // {after: <step index>, ms}
  "wait_for",         // {step: <step index>, selector}   turn a fixed pause into waiting for something to appear (or insert after that step)
  "set_wait",         // {step: <step index>, ms}
  "set_text",         // {step: <step index>, text}   for type/fill steps
  "replace_selector", // {step: <step index>, selector}
  "delete_step",      // {step: <step index>}
  "insert_step",      // {after: <step index, -1 for the start>, step: {action: ..., ...}}   add one step, validated
  "set_step",         // {step: <step index>, value: {action: ..., ...}}   replace one step in place, validated
  "set_cursor",       // {cursor: "default"|"touch"|"none"}
  "rerecord",         // {}  throw the recording away and record again
] as const;
export type Edit = { op: (typeof EDIT_VERBS)[number]; [k: string]: unknown };

export async function proposeEdits(input: { instruction: string; yaml: string; receipts: string; provider: Provider }): Promise<{ edits: Edit[]; note: string }> {
  const system = [
    "You edit a Retake demo manifest in response to plain-English feedback about the video it produced.",
    "Respond with JSON only: {\"edits\": [...], \"note\": \"one short sentence saying what you changed\"}.",
    "Each edit is one of:",
    '  {"op":"set_caption","scene":"<label>","caption":"..."}',
    '  {"op":"set_camera","scene":"<label>","camera":"auto"|"static"|<zoom number 1.1-1.6>}',
    '  {"op":"set_hold","scene":"<label>","holdMs":<ms>}',
    '  {"op":"set_trim","head":<sec>,"tail":<sec>}',
    '  {"op":"set_format","preset":"post-landscape"|"post-square"|"post-vertical"|"docs-gif"}',
    '  {"op":"set_layout","layout":"band"|"card"|"overlay-bottom"|"overlay-top"|"none"}',
    '  {"op":"add_wait","after":<step index>,"ms":<ms>}     — slow down after a step',
    '  {"op":"wait_for","step":<step index>,"selector":"..."} — replace a fixed wait with waiting for an element to appear (if that step is not a wait, the waitFor is inserted after it)',
    '  {"op":"set_wait","step":<step index>,"ms":<ms>}      — change an existing wait',
    '  {"op":"set_text","step":<step index>,"text":"..."}   — what gets typed',
    '  {"op":"replace_selector","step":<step index>,"selector":"..."}',
    '  {"op":"delete_step","step":<step index>}',
    '  {"op":"insert_step","after":<step index or -1>,"step":{"action":"click","selector":"..."}}  — add one step after that index (any step shape: click, type, waitFor, scroll, scene…)',
    '  {"op":"set_step","step":<step index>,"value":{"action":"waitFor","selector":"..."}}        — replace one step in place',
    '  {"op":"set_cursor","cursor":"default"|"touch"|"none"}',
    '  {"op":"rerecord"}',
    "Rules: make the SMALLEST change that does what was asked; never rewrite things that were not mentioned; use scene labels and step indexes exactly as given; if the request is impossible or unclear, return an empty edits list and say why in note.",
  ].join("\n");
  const user = `Feedback: ${input.instruction}\n\nReceipts from the last take (what actually happened, with step indexes and scene labels):\n${input.receipts}\n\nCurrent manifest:\n${input.yaml}`;
  const raw = await chat(input.provider, system, user);
  const text = raw.replace(/^```[a-z]*\n?/im, "").replace(/```\s*$/m, "").trim();
  const start = text.indexOf("{");
  const parsed = JSON.parse(text.slice(start)) as { edits?: Edit[]; note?: string };
  const edits = (parsed.edits ?? []).filter((e) => (EDIT_VERBS as readonly string[]).includes(e.op));
  return { edits, note: parsed.note ?? "" };
}

// --- drafting ---------------------------------------------------------------

const SCHEMA_DOC = `
Manifest YAML fields:
  name (kebab-case), title, url, preset: post-landscape, waitForSelector (selector present when page is ready),
  camera: auto, setup: [steps run before recording], steps: [...], outputs: {mp4: true, gif: true, thumbnail: {scene: <label>}}
  Do NOT set viewport, cursor, chrome, background, fps, crf or captions — the preset handles quality.
Steps (each may have pauseAfter ms, waitFor selector, timeout ms):
  {action: scene, label, caption, camera?: static | {focus: selector, zoom: 1.25}}   a named beat; caption is burned in until the next scene (under 60 chars). Set camera: static on every scene unless the thing being shown is genuinely too small to read at full frame — a calm, still demo reads as more real than a zooming one. If the person asked for zooms (or stillness), that wins.
  {action: wait, ms}
  {action: click, selector, zoom: 1.3}   zoom is optional
  {action: type, selector, text, delay: 30}
  {action: fill, selector, text}
  {action: hover, selector}
  {action: scroll, y}
  {action: keyboard, key}
  {action: waitFor, selector, timeout: 30000}      wait for something to appear (use after actions that trigger async work)
  {action: evaluate, script}
Rules: never invent field names or add "?" to keys; 15–35 seconds total; 3–6 scenes; open with a scene; every click uses a selector from the scouted list verbatim (selectors ending in \">> nth=N\" are already disambiguated — keep them exactly); after any action that loads or computes something, waitFor an element that only appears as a result (never one that is already on the page) — if you cannot know it from the scout, use {action: wait, ms: 3000} instead; end with a wait of ~2000ms on the payoff; do not use zoom steps — scenes carry the camera.
`;

/** The person's standing taste — demos/style.md, written once, read by every
    draft. "No zooms, cursor visible, captions plain" should not need repeating. */
export function styleNote(demosDir: string): string | null {
  try { const t = fs.readFileSync(path.join(demosDir, "style.md"), "utf8").trim(); return t || null; } catch { return null; }
}

export async function draftManifest(input: { name: string; url: string; describe: string; scout: Scout; provider: Provider; project?: string; demosDir?: string }): Promise<{ yaml: string; provider: string; retried: boolean; digest?: Digest }> {
  const { name, url, describe, scout: sc, provider } = input;
  const dg = input.project ? digest(input.project) : undefined;
  const style = input.demosDir ? styleNote(input.demosDir) : null;
  const system = `You write Retake demo manifests: YAML that drives a Playwright walkthrough of a web app to make a short silent product demo video. Output ONLY the YAML document, no prose, no code fences.\n${SCHEMA_DOC}`;
  const user = [
    `name: ${name}`,
    `url: ${url}`,
    `What to record: ${describe}`,
    ...(style ? ["", "The person's standing style preferences — these always win over defaults:", style] : []),
    ``,
    ...(dg ? ["The project's own source code says:", dg.text, "", "Use the routes and selectors above when they fit the story — they are more reliable than anything guessed. Add `reducedMotion: true` if infinite animations were flagged. If a sign-in is needed, put it in `setup` with ${ENV} placeholders and `secret: true`, never literal passwords.", ""] : []),
    `Scouted page — title: ${sc.title}`,
    `Headings: ${sc.headings.join(" | ")}`,
    `Visible interactive elements (tag · selector · text/placeholder):`,
    ...sc.elements.map((e) => `- ${e.tag} · ${e.selector} · ${e.text || e.placeholder || e.href || ""}`),
    ``,
    `Page text excerpt: ${sc.text}`,
    ``,
    `Write the manifest.`,
  ].join("\n");

  const clean = (t: string) => t.replace(/^```[a-z]*\n?/im, "").replace(/```\s*$/m, "").trim();
  let text = clean(await chat(provider, system, user, input.project));
  let retried = false;
  const check = (t: string) => {
    const parsed = Manifest.safeParse(YAML.parse(t));
    return parsed.success ? null : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  };
  let err: string | null;
  try {
    err = check(text);
  } catch (e) {
    err = `not valid YAML: ${(e as Error).message}`;
  }
  if (err) {
    retried = true;
    text = clean(await chat(provider, system, `${user}\n\nYour previous draft failed validation:\n${err}\n\nPrevious draft:\n${text}\n\nReturn a corrected full YAML document only.`));
    try {
      err = check(text);
    } catch (e) {
      err = `not valid YAML: ${(e as Error).message}`;
    }
    if (err) throw new Error(`draft did not validate after retry:\n${err}\n\n${text}`);
  }
  // Force the name the user chose and normalise the header comment.
  const doc = YAML.parse(text) as Record<string, unknown>;
  doc.name = name;
  if (!doc.url) doc.url = url;
  const header = `# ${describe.trim()}\n# Drafted by ${provider.name} (${provider.model}) from a scouting pass of ${url}${dg ? ` and the source in ${dg.dir}` : ""}.\n# Read it, fix selectors/captions, run it. It is yours now.\n\n`;
  return { yaml: header + YAML.stringify(doc), provider: `${provider.name} · ${provider.model}`, retried, digest: dg };
}
