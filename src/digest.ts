/**
 * Project digest — what a repo says about itself.
 *
 * Scouting a live page shows the DOM of *one* screen. Reading the project shows
 * the map: every route, how it starts, whether there is a login, which
 * selectors the code actually uses, and what will make a recording flaky. The
 * digest is deterministic and local (no model), and it goes into the drafting
 * prompt next to the scout.
 *
 * Deliberately bounded: a fixed file budget and a character cap, so a big repo
 * cannot blow up the prompt.
 */
import fs from "node:fs";
import path from "node:path";

export type Digest = {
  dir: string;
  name: string;
  stack: string[];
  scripts: Record<string, string>;
  routes: string[];
  auth: string[];
  selectors: string[];
  flaky: string[];
  env: string[];
  readme: string;
  files: number;
  text: string;
};

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo", ".vercel", "vendor", "__pycache__", ".venv", "target", "outputs"]);
const CODE = /\.(tsx?|jsx?|mjs|cjs|svelte|vue|astro|html|php|erb)$/;
const MAX_FILES = 900;
const MAX_CHARS = 9000;

function walk(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > MAX_FILES) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length > MAX_FILES) break;
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(full, depth + 1, out);
    } else out.push(full);
  }
  return out;
}

const read = (f: string, cap = 60_000) => {
  try {
    return fs.readFileSync(f, "utf8").slice(0, cap);
  } catch {
    return "";
  }
};

/** Framework conventions → the URL paths a person can actually visit. */
function routesFrom(files: string[], root: string): string[] {
  const routes = new Set<string>();
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    // Next.js app router: app/**/page.tsx ; pages router: pages/**/*.tsx
    let m = /(?:^|\/)app\/(.+)\/page\.(tsx?|jsx?)$/.exec(rel) ?? /(?:^|\/)app\/page\.(tsx?|jsx?)$/.exec(rel);
    if (m) {
      const seg = m[1] ?? "";
      const url = "/" + seg.split("/").filter((s) => !/^\(.*\)$/.test(s)).join("/");
      routes.add(url.replace(/\/+$/, "") || "/");
      continue;
    }
    m = /(?:^|\/)pages\/(.+)\.(tsx?|jsx?)$/.exec(rel);
    if (m && !/^_/.test(path.basename(m[1]))) {
      routes.add("/" + m[1].replace(/\/index$/, "").replace(/^index$/, ""));
      continue;
    }
    // SvelteKit / Remix-ish
    m = /(?:^|\/)routes\/(.+)\/\+page\.svelte$/.exec(rel);
    if (m) routes.add("/" + m[1]);
    // Plain static sites: public/*.html or top-level *.html
    m = /(?:^|\/)(?:public|static|www|dist)?\/?([\w-]+)\.html$/.exec(rel);
    if (m && rel.split("/").length <= 3) routes.add("/" + (m[1] === "index" ? "" : m[1]));
  }
  return [...routes].sort().slice(0, 40);
}

export function digest(dir: string): Digest {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`not a folder: ${root}`);
  const files = walk(root);
  const rel = (f: string) => path.relative(root, f).replace(/\\/g, "/");

  // --- how it starts -------------------------------------------------------
  const pkgFile = path.join(root, "package.json");
  let scripts: Record<string, string> = {};
  let stack: string[] = [];
  let name = path.basename(root);
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(read(pkgFile)) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      name = pkg.name ?? name;
      scripts = pkg.scripts ?? {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const k of ["next", "react", "vue", "svelte", "@sveltejs/kit", "astro", "vite", "remix", "nuxt", "express", "tailwindcss"]) if (deps[k]) stack.push(k);
    } catch { /* ignore */ }
  }
  if (!stack.length && files.some((f) => /\.html$/.test(f))) stack.push("static html");
  if (fs.existsSync(path.join(root, "vercel.json")) || fs.existsSync(path.join(root, "api"))) stack.push("vercel");

  // --- what to visit -------------------------------------------------------
  const routes = routesFrom(files, root);

  // --- signals worth quoting ----------------------------------------------
  const auth = new Set<string>();
  const selectors = new Set<string>();
  const flaky = new Set<string>();
  const envKeys = new Set<string>();
  let scanned = 0;
  for (const f of files) {
    if (!CODE.test(f) || scanned > 260) continue;
    const body = read(f, 220_000);
    if (!body) continue;
    scanned++;
    const r = rel(f);
    if (/sign[-_ ]?in|log[-_ ]?in|password|session|middleware|auth/i.test(r) || /type="password"/i.test(body)) {
      for (const mm of body.matchAll(/(?:id|name|placeholder|aria-label)=["']([^"']{2,40})["']/g)) {
        if (/user|email|pass|login|sign|otp|code/i.test(mm[1])) auth.add(`${r}: ${mm[0]}`);
      }
      if (/type="password"/i.test(body)) auth.add(`${r}: has a password field`);
      if (/oauth|redirect_uri|nextauth|clerk|supabase\.auth|magic ?link/i.test(body)) auth.add(`${r}: OAuth/third-party auth mentioned`);
    }
    for (const mm of body.matchAll(/data-testid=["']([^"']+)["']/g)) selectors.add(`[data-testid="${mm[1]}"]`);
    for (const mm of body.matchAll(/aria-label=["']([^"']{2,40})["']/g)) selectors.add(`[aria-label="${mm[1]}"]`);
    if (/window\.open\(/.test(body)) flaky.add(`${r}: window.open — would need a second tab`);
    if (/target=["']_blank["']/.test(body)) flaky.add(`${r}: target="_blank" links`);
    if (/Math\.random\(/.test(body)) flaky.add(`${r}: Math.random — values differ every run`);
    if (/animation:[^;]*infinite/.test(body)) flaky.add(`${r}: infinite animation (set reducedMotion)`);
    if (/type=["']file["']/.test(body)) flaky.add(`${r}: file input (upload step available)`);
    if (/download=|createObjectURL/.test(body)) flaky.add(`${r}: triggers a download (download step available)`);
    for (const mm of body.matchAll(/process\.env\.([A-Z0-9_]{3,})/g)) envKeys.add(mm[1]);
  }
  for (const f of [".env.example", ".env.local.example"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) for (const line of read(p, 4000).split("\n")) { const k = /^([A-Z0-9_]+)=/.exec(line.trim()); if (k) envKeys.add(k[1]); }
  }

  const readmeFile = files.find((f) => /^readme\.md$/i.test(path.basename(f)));
  const readme = readmeFile ? read(readmeFile, 1200) : "";

  const d: Digest = {
    dir: root, name, stack, scripts, routes,
    auth: [...auth].slice(0, 12),
    selectors: [...selectors].slice(0, 60),
    flaky: [...flaky].slice(0, 12),
    env: [...envKeys].slice(0, 25),
    readme, files: files.length, text: "",
  };
  d.text = format(d);
  return d;
}

function format(d: Digest): string {
  const L: string[] = [];
  L.push(`Project: ${d.name} (${d.dir})`);
  if (d.stack.length) L.push(`Stack: ${d.stack.join(", ")}`);
  const dev = Object.entries(d.scripts).filter(([k]) => /^(dev|start|serve|preview)$/.test(k));
  if (dev.length) L.push(`Start commands: ${dev.map(([k, v]) => `${k} → ${v}`).join(" | ")}`);
  if (d.routes.length) L.push(`Routes found in the code: ${d.routes.join(" ")}`);
  if (d.auth.length) L.push(`Sign-in signals:\n${d.auth.map((a) => "- " + a).join("\n")}`);
  if (d.selectors.length) L.push(`Stable selectors used in the code (prefer these):\n${d.selectors.map((s) => "- " + s).join("\n")}`);
  if (d.flaky.length) L.push(`Things that can break a recording:\n${d.flaky.map((s) => "- " + s).join("\n")}`);
  if (d.env.length) L.push(`Env vars referenced: ${d.env.join(", ")}`);
  if (d.readme) L.push(`README (start):\n${d.readme}`);
  return L.join("\n\n").slice(0, MAX_CHARS);
}
