/**
 * Journeys from an address. A person gives the app's address and nothing
 * else; Retake looks around it (its pages, its navigation, its forms, its
 * sign-in) and proposes the handful of flows worth watching, each in plain
 * words with one line on what it checks, and marked as reading only or as
 * changing data.
 *
 *   explore(url)                 a real browser: the entry page, the pages its
 *                                navigation leads to, signed in when a test
 *                                account is saved for the site
 *   proposeJourneys(explored)    4–8 proposals: from the drafting model
 *                                (describe's), checked, or read straight off
 *                                the pages when there is no model
 *   journeySource(proposal)      the journey file, written from the proposal's
 *                                steps (or the person's agent writes its own)
 *   addJourneys(…)               each one runs once first; only a run that
 *                                passes is added, and the run becomes its normal
 *
 * A journey that changes data is only added, and only ever runs, where the
 * app is marked as a test space (src/watch/spaces.ts).
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { launchChromium } from "../browser-home.js";
import { hasLogin, siteOf } from "../logins.js";
import { journeyNameOk, journeysDir, listJourneys } from "./journey-store.js";
import { alreadyWatched, hostName, isTestSpace, originOf, withScheme } from "./spaces.js";
import { readJson, writeJson } from "./session.js";
import type { RunRecord } from "./journey-store.js";

// ---------- looking around ----------

export type Field = { selector: string; label: string; type: string; name: string; required: boolean; options?: string[] };
export type FormFacts = { selector: string; method: string; fields: Field[]; submit: { selector: string; text: string } | null; signIn: boolean; search: boolean };
export type PageFacts = {
  url: string; path: string; title: string; h1: string; headings: string[];
  links: { path: string; text: string; nav: boolean }[];
  buttons: { selector: string; text: string }[];
  forms: FormFacts[];
  password: boolean;
  /** Reached without signing in. */
  public: boolean;
  /** The words the person would use for this page: its link's text. */
  name: string;
};
export type Exploration = {
  origin: string; entry: string;
  pages: PageFacts[];
  /** Where the sign-in is, when the app has one. */
  signIn: { url: string } | null;
  /** A test account was saved and the exploration used it. */
  signedIn: boolean;
  /** Why the signed-in part could not be seen, when it could not. */
  signInError?: string;
};

const FACTS_SCRIPT = String.raw`(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const words = (el) => (el ? (el.innerText || el.textContent || "") : "").trim().replace(/\s+/g, " ");
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const uniq = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const q = (s) => s.replace(/"/g, '\\"');
  const sel = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("id");
    if (id && uniq("#" + esc(id))) return "#" + esc(id);
    const tid = el.getAttribute("data-testid");
    if (tid && uniq('[data-testid="' + q(tid) + '"]')) return '[data-testid="' + q(tid) + '"]';
    const name = el.getAttribute("name");
    if (name && uniq(tag + '[name="' + q(name) + '"]')) return tag + '[name="' + q(name) + '"]';
    const aria = el.getAttribute("aria-label");
    if (aria && uniq(tag + '[aria-label="' + q(aria) + '"]')) return tag + '[aria-label="' + q(aria) + '"]';
    const ph = el.getAttribute("placeholder");
    if (ph && uniq(tag + '[placeholder="' + q(ph) + '"]')) return tag + '[placeholder="' + q(ph) + '"]';
    const t = words(el).slice(0, 40);
    if (t && (tag === "button" || tag === "a")) {
      const same = Array.from(document.querySelectorAll(tag)).filter((o) => words(o).slice(0, 40) === t);
      const base = tag + ':has-text("' + q(t) + '")';
      return same.length > 1 ? base + " >> nth=" + same.indexOf(el) : base;
    }
    return null;
  };
  const labelOf = (inp) => {
    const id = inp.getAttribute("id");
    const l = (id && document.querySelector('label[for="' + esc(id) + '"]')) || inp.closest("label");
    return (words(l) || inp.getAttribute("aria-label") || inp.getAttribute("placeholder") || inp.getAttribute("name") || "").slice(0, 60);
  };
  const forms = Array.from(document.querySelectorAll("form")).filter(vis).slice(0, 6).map((f) => {
    const fields = Array.from(f.querySelectorAll("input, textarea, select")).filter((i) => vis(i) && !/^(hidden|submit|button|reset|image)$/i.test(i.type || ""))
      .map((i) => ({ selector: sel(i), label: labelOf(i), type: (i.tagName === "INPUT" ? (i.type || "text") : i.tagName.toLowerCase()).toLowerCase(), name: i.getAttribute("name") || "", required: !!i.required,
        options: i.tagName === "SELECT" ? Array.from(i.options).map((o) => o.value).filter(Boolean).slice(0, 6) : undefined }))
      .filter((x) => x.selector);
    const b = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
    const submit = b && vis(b) && sel(b) ? { selector: sel(b), text: (words(b) || b.getAttribute("value") || "").slice(0, 40) } : null;
    const method = (f.getAttribute("method") || "get").toLowerCase();
    const password = fields.some((x) => x.type === "password");
    const search = f.getAttribute("role") === "search" || fields.some((x) => x.type === "search") || (method === "get" && fields.length === 1);
    return { selector: sel(f) || "form", method, fields, submit, signIn: password && fields.length <= 3, search };
  });
  const navEls = new Set(Array.from(document.querySelectorAll("nav a[href], header a[href], aside a[href], [role=navigation] a[href]")));
  const links = Array.from(document.querySelectorAll("a[href]")).filter(vis).map((a) => {
    let u; try { u = new URL(a.getAttribute("href"), location.href); } catch { return null; }
    if (u.origin !== location.origin || /^(mailto|tel|javascript):/.test(a.getAttribute("href"))) return null;
    return { path: u.pathname + u.search, text: words(a).slice(0, 40), nav: navEls.has(a) };
  }).filter((x) => x && x.text).slice(0, 60);
  const inForm = new Set(Array.from(document.querySelectorAll("form button, form input")));
  const buttons = Array.from(document.querySelectorAll("button, [role=button]")).filter((b) => vis(b) && !inForm.has(b)).map((b) => ({ selector: sel(b), text: words(b).slice(0, 40) })).filter((b) => b.selector && b.text).slice(0, 20);
  const heads = Array.from(document.querySelectorAll("h1,h2,h3")).filter(vis).map(words).filter(Boolean).slice(0, 8);
  const h1 = words(Array.from(document.querySelectorAll("h1")).find(vis) || null).slice(0, 80);
  return { title: document.title, h1, headings: heads, links, buttons, forms, password: !!Array.from(document.querySelectorAll('input[type="password"]')).find(vis) };
})()`;

const SIGN_IN_WORDS = /\b(sign ?in|log ?in|login)\b/i;
const LEAVE_WORDS = /\b(sign ?out|log ?out|logout|delete|remove|unsubscribe|cancel (my )?(account|subscription))\b/i;

async function facts(page: Page, isPublic: boolean, name: string): Promise<PageFacts> {
  const f = (await page.evaluate(FACTS_SCRIPT)) as Omit<PageFacts, "url" | "path" | "public" | "name">;
  const u = new URL(page.url());
  return { ...f, url: u.href, path: u.pathname + u.search, public: isPublic, name: name || f.h1 || f.title || u.pathname };
}

async function open(page: Page, url: string) {
  const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
  return r;
}

/** Same-origin links worth a look, from the navigation first, never twice,
    never one that signs out or deletes. */
function nextLinks(pages: PageFacts[], seen: Set<string>, limit: number): { path: string; text: string }[] {
  const all = pages.flatMap((p) => p.links).sort((a, b) => Number(b.nav) - Number(a.nav));
  const out: { path: string; text: string }[] = [];
  for (const l of all) {
    const key = l.path.split("#")[0];
    if (seen.has(key) || LEAVE_WORDS.test(l.text) || /\.(pdf|zip|png|jpe?g|csv)$/i.test(key)) continue;
    seen.add(key);
    out.push({ path: key, text: l.text });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Look around an app: the entry page and up to six pages its navigation
 * leads to, without signing in; then, when a test account is saved for the
 * site and the app has a sign-in, the same signed in.
 */
export async function explore(url: string, o: { log?: (l: string) => void; maxPages?: number } = {}): Promise<Exploration> {
  const log = o.log ?? (() => {});
  const origin = originOf(url);
  if (!origin) throw new Error(`"${url}" is not an app's address — something like https://app.example.com`);
  const entry = withScheme(url);
  const max = o.maxPages ?? 6;
  const browser = await launchChromium({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const r = await open(page, entry);
    if (!r) throw new Error(`nothing answered at ${entry}`);
    if (r.status() >= 500) throw new Error(`${hostName(origin)} answered with an error (${r.status()})`);
    const pages: PageFacts[] = [];
    const seen = new Set<string>();
    let signIn: { url: string } | null = null;
    const first = await facts(page, true, "Home");
    // Sent to a sign-in straight away: the app is behind it.
    first.public = !first.password;
    pages.push(first);
    seen.add(new URL(entry).pathname);
    seen.add(first.path);
    if (first.password) signIn = { url: first.url };
    log(`Looked at ${first.path}`);
    for (const l of nextLinks(pages, seen, max)) {
      await open(page, origin + l.path);
      const f = await facts(page, true, l.text);
      if (f.password || SIGN_IN_WORDS.test(l.text)) { signIn ??= { url: f.url }; f.public = false; }
      // Sent somewhere else (to the sign-in, mostly): not this page.
      if (f.path.split("?")[0] !== l.path.split("?")[0]) { seen.add(f.path); if (!f.password) continue; f.public = false; }
      pages.push(f);
      log(`Looked at ${f.path}`);
    }
    let signedIn = false, signInError: string | undefined;
    if (signIn && hasLogin(siteOf(origin))) {
      try {
        const { signInOn } = await import("./journeys.js");
        await open(page, signIn.url);
        await signInOn(page, origin);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        signedIn = true;
        const landing = await facts(page, false, "");
        log(`Signed in, at ${landing.path}`);
        const inside: PageFacts[] = [landing];
        const insideSeen = new Set<string>(pages.filter((p) => p.public).map((p) => p.path.split("?")[0]));
        insideSeen.add(landing.path.split("?")[0]);
        if (!pages.some((p) => p.path === landing.path && p.public)) pages.push(landing);
        for (const l of nextLinks(inside, insideSeen, max)) {
          await open(page, origin + l.path);
          const f = await facts(page, false, l.text);
          if (f.password || f.path.split("?")[0] !== l.path.split("?")[0]) continue;
          const had = pages.findIndex((p) => p.path === f.path);
          if (had >= 0) pages[had] = { ...f, public: false }; else pages.push(f);
          log(`Looked at ${f.path}`);
        }
      } catch (e) { signInError = (e as Error).message.split("\n")[0]; }
    }
    return { origin, entry, pages, signIn, signedIn, ...(signInError ? { signInError } : {}) };
  } finally { await browser.close().catch(() => {}); }
}

// ---------- proposals ----------

export type Step =
  | { do: "signIn" }
  | { do: "open"; path: string; label?: string }
  | { do: "click"; selector: string; label?: string }
  | { do: "fill"; selector: string; value: string; label?: string }
  | { do: "select"; selector: string; value: string; label?: string }
  | { do: "see"; text: string };
export type Proposal = { title: string; checks: string; changes: "reads" | "data"; steps: Step[] };

export const MIN_PROPOSALS = 4;
export const MAX_PROPOSALS = 8;

const sentence = (s: string) => { const t = s.trim().replace(/\s+/g, " "); return t ? t[0].toUpperCase() + t.slice(1) : t; };
const lower = (s: string) => (s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s);
/** A button's words, said as a thing to do. "Create project" → "Create a project". */
const asTask = (s: string) => {
  const t = sentence(s).replace(/[.!…]+$/, "");
  const m = /^(Create|Add|Invite|Start|Open|Book|Send|Make|New)\s+(?!a |an |the |your |my )([a-z][\w-]*)(.*)$/i.exec(t);
  if (!m) return t;
  const verb = /^new$/i.test(m[1]) ? "Create" : sentence(m[1].toLowerCase());
  return `${verb} ${/^[aeiou]/i.test(m[2]) ? "an" : "a"} ${m[2].toLowerCase()}${m[3]}`;
};
/** A page's name, said as a place. */
const pageName = (p: PageFacts) => sentence((p.name || p.h1 || p.path).replace(/\s*[|·–—-].*$/, "")).slice(0, 40);

/** Words that, on a button, mean pressing it changes something. */
const WRITE_WORDS = /\b(create|add|new|save|submit|send|invite|publish|post|delete|remove|archive|update|pay|buy|order|book|confirm|approve|upload|import|reset)\b/i;

/** A value to type into a field: the same every run, so the page it leads to looks the same every run. */
export function sampleValue(f: Field): string {
  const k = `${f.type} ${f.name} ${f.label}`.toLowerCase();
  if (/email/.test(k)) return "watch-check@example.com";
  if (/\burl\b|website|link/.test(k)) return "https://example.com";
  if (/number|qty|quantity|amount|count|seats?/.test(k)) return "1";
  if (/tel|phone/.test(k)) return "+1 555 0100";
  if (/date/.test(k)) return "2030-01-15";
  if (f.type === "textarea") return "Written by a Retake Watch journey.";
  if (/name|title/.test(k)) return "Watch check";
  return "Watch check";
}

/** Proposals read straight off the pages, for when there is no model, and to
    top up a model's when it gives too few. */
export function plainProposals(x: Exploration): Proposal[] {
  const out: Proposal[] = [];
  const signedIn = x.signIn !== null;
  const landing = x.signIn ? x.pages.find((p) => !p.public && !p.password) : undefined;
  if (x.signIn) {
    out.push({ title: "Sign in", checks: `Signs in with the test account${landing?.h1 ? ` and lands on “${landing.h1}”` : ""}`, changes: "reads",
      steps: [{ do: "signIn" }, ...(landing?.h1 ? [{ do: "see" as const, text: landing.h1 }] : [])] });
  }
  // The page the sign-in lands on is what "Sign in" already checks.
  for (const p of x.pages.filter((q) => !q.password && q !== landing)) {
    if (!p.h1 || out.some((q) => q.steps.some((s) => s.do === "open" && s.path === p.path))) continue;
    const name = pageName(p);
    out.push({ title: `Check the ${lower(name)} page`, checks: `The ${lower(name)} page opens and shows “${p.h1}”`, changes: "reads",
      steps: [...(!p.public && signedIn ? [{ do: "signIn" as const }] : []), { do: "open", path: p.path, label: `the ${lower(name)} page` }, { do: "see", text: p.h1 }] });
  }
  const forms: Proposal[] = [];
  for (const p of x.pages) for (const f of p.forms) {
    if (f.signIn || f.search || !f.submit || !f.fields.length || f.fields.some((fl) => fl.type === "password")) continue;
    const first = f.fields.find((fl) => /^(text|email|textarea|search|url)$/.test(fl.type));
    const fills: Step[] = f.fields.map((fl) => fl.type === "select-one" || fl.type === "select"
      ? { do: "select", selector: fl.selector, value: fl.options?.[0] ?? "", label: fl.label }
      : fl.type === "checkbox" || fl.type === "radio" ? { do: "click", selector: fl.selector, label: fl.label }
      : { do: "fill", selector: fl.selector, value: sampleValue(fl), label: fl.label });
    const task = asTask(f.submit.text || `Send the ${lower(pageName(p))} form`);
    if (forms.some((q) => q.title === task)) continue;
    const labels = f.fields.map((fl) => lower(fl.label || fl.name)).filter(Boolean);
    forms.push({ title: task, checks: `Fills in ${labels.length > 2 ? labels.slice(0, 2).join(", ") + " and more" : labels.join(" and ")} on ${lower(pageName(p))}, presses “${f.submit.text}” and sees it land`, changes: "data",
      steps: [...(!p.public && signedIn ? [{ do: "signIn" as const }] : []), { do: "open", path: p.path, label: `the ${lower(pageName(p))} page` }, ...fills, { do: "click", selector: f.submit.selector, label: f.submit.text },
        ...(first ? [{ do: "see" as const, text: sampleValue(first) }] : [])] });
  }
  // A mix: sign-in, then up to five pages, then the forms; never more than eight.
  const reads = out.slice(0, x.signIn ? 6 : 5);
  return [...reads, ...forms].slice(0, MAX_PROPOSALS);
}

const STEP_DO = new Set(["signIn", "open", "click", "fill", "select", "see"]);

/** Is this proposal one that writes? Never trust the label alone: anything that
    types, chooses, or presses a button that sends or creates, changes data. */
export function changesData(steps: Step[], x?: Exploration): boolean {
  const submits = new Set((x?.pages ?? []).flatMap((p) => p.forms.filter((f) => !f.signIn && !f.search && f.submit).map((f) => f.submit!.selector)));
  return steps.some((s) => s.do === "fill" || s.do === "select" || (s.do === "click" && (submits.has(s.selector) || WRITE_WORDS.test(`${s.label ?? ""} ${s.selector}`))));
}

/**
 * The model's answer, read: a JSON list (bare, fenced, or under "journeys")
 * of { title, checks, changes, steps }. Anything malformed is dropped rather
 * than guessed at; anything that writes is marked as changing data whatever
 * it was labelled; the same title twice is one.
 */
export function parseProposals(text: string, x?: Exploration): Proposal[] {
  const t = text.replace(/^```[a-z]*\s*/im, "").replace(/```\s*$/m, "").trim();
  const starts = [t.indexOf("["), t.indexOf("{")].filter((i) => i >= 0);
  if (!starts.length) return [];
  let raw: unknown;
  const from = Math.min(...starts);
  for (const end of [t.lastIndexOf("]"), t.lastIndexOf("}")].filter((i) => i > from).sort((a, b) => b - a)) {
    try { raw = JSON.parse(t.slice(from, end + 1)); break; } catch { /* the other end */ }
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { journeys?: unknown }).journeys) ? (raw as { journeys: unknown[] }).journeys : [];
  const out: Proposal[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const title = sentence(String(r.title ?? "")).slice(0, 60);
    const checks = sentence(String(r.checks ?? r.check ?? r.what ?? "")).replace(/\.$/, "").slice(0, 140);
    if (!title || !checks || out.some((p) => p.title.toLowerCase() === title.toLowerCase())) continue;
    const steps: Step[] = [];
    let ok = Array.isArray(r.steps) && r.steps.length > 0;
    for (const s of (Array.isArray(r.steps) ? r.steps : []) as Record<string, unknown>[]) {
      const d = String(s?.do ?? "");
      if (!STEP_DO.has(d)) { ok = false; break; }
      const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string).trim() : "");
      if (d === "signIn") steps.push({ do: "signIn" });
      else if (d === "open") { const p = str("path") || str("url"); const o = x ? originOf(p) : null; const rel = o && x && o === x.origin ? new URL(p).pathname + new URL(p).search : p; if (!rel.startsWith("/")) { ok = false; break; } steps.push({ do: "open", path: rel, ...(str("label") ? { label: str("label") } : {}) }); }
      else if (d === "see") { if (!str("text")) { ok = false; break; } steps.push({ do: "see", text: str("text").slice(0, 80) }); }
      else {
        if (!str("selector")) { ok = false; break; }
        const label = str("label") || undefined;
        if (d === "click") steps.push({ do: "click", selector: str("selector"), ...(label ? { label } : {}) });
        else steps.push({ do: d as "fill" | "select", selector: str("selector"), value: str("value") || "Watch check", ...(label ? { label } : {}) });
      }
    }
    if (!ok) continue;
    const safe = throughSignIn(steps, x);
    const said = String(r.changes ?? r.kind ?? "").toLowerCase();
    // A sign-in is never data: it is the saved test account, through the kit.
    const signsInOnly = safe.every((st) => st.do === "signIn" || st.do === "see" || st.do === "open");
    const data = (!signsInOnly && /data|write|change/.test(said)) || changesData(safe, x);
    out.push({ title, checks, changes: data ? "data" : "reads", steps: safe });
  }
  return out.slice(0, MAX_PROPOSALS);
}

/**
 * Nothing is ever typed into the sign-in form but the saved test account:
 * any step on it (opening the sign-in page, filling its fields, pressing its
 * button, or any password field anywhere) becomes the kit's one signIn.
 */
export function throughSignIn(steps: Step[], x?: Exploration): Step[] {
  const signInPaths = new Set((x?.pages ?? []).filter((p) => p.password).map((p) => p.path.split("?")[0]));
  const signInSels = new Set((x?.pages ?? []).flatMap((p) => p.forms.filter((f) => f.signIn).flatMap((f) => [...f.fields.map((fl) => fl.selector), ...(f.submit ? [f.submit.selector] : [])])));
  const isSignIn = (s: Step) =>
    (s.do === "open" && signInPaths.has(s.path.split("?")[0])) ||
    ((s.do === "fill" || s.do === "click" || s.do === "select") && (signInSels.has(s.selector) || /password|type=["']?password/i.test(s.selector) || (s.do === "fill" && /password/i.test(s.label ?? ""))));
  const out: Step[] = [];
  for (const s of steps) {
    if (s.do === "signIn" || isSignIn(s)) { if (!out.some((o) => o.do === "signIn")) out.push({ do: "signIn" }); continue; }
    out.push(s);
  }
  return out;
}

function explorationText(x: Exploration): string {
  const lines = [`App: ${x.origin}`, `Sign-in: ${x.signIn ? `${x.signIn.url}${x.signedIn ? " (explored signed in with a saved test account)" : " (not signed in: no test account saved yet)"}` : "none found"}`, ""];
  for (const p of x.pages) {
    lines.push(`## ${p.path} — “${p.h1 || p.title}”${p.public ? "" : " (behind the sign-in)"}${p.password ? " (the sign-in page)" : ""}`);
    if (p.headings.length) lines.push(`headings: ${p.headings.join(" | ")}`);
    const nav = p.links.filter((l) => l.nav).map((l) => `${l.text} → ${l.path}`);
    if (nav.length) lines.push(`navigation: ${nav.slice(0, 12).join(" · ")}`);
    for (const b of p.buttons.slice(0, 10)) lines.push(`button · ${b.selector} · ${b.text}`);
    for (const f of p.forms) {
      lines.push(`form (${f.method}${f.signIn ? ", sign-in" : f.search ? ", search" : ""}): ${f.fields.map((fl) => `${fl.selector} [${fl.type}] “${fl.label}”`).join(", ")}${f.submit ? `; submit ${f.submit.selector} “${f.submit.text}”` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const SYSTEM = [
  "You propose the journeys worth watching on a web app: the few flows a team would want to know still work after every deploy.",
  "Answer with JSON only: a list of 4 to 8 objects, best first, each:",
  '{"title": "Sign in", "checks": "one plain line on what it checks", "changes": "reads" | "data", "steps": [...]}',
  "Steps, in order (nothing else is allowed):",
  '  {"do":"signIn"}                                   sign in with the saved test account (first, for anything behind the sign-in)',
  '  {"do":"open","path":"/projects"}                 go to a page of this app',
  '  {"do":"click","selector":"<a selector from the list>","label":"<its words>"}',
  '  {"do":"fill","selector":"<a selector from the list>","value":"<a plain test value>","label":"<the field>"}',
  '  {"do":"select","selector":"<a selector>","value":"<an option value>"}',
  '  {"do":"see","text":"<words that must be on the page after the step before>"}',
  "Rules: use only selectors given below, verbatim. Every journey ends with a see. Never open the sign-in page or type into its fields: {\"do\":\"signIn\"} does that with the saved test account. Titles are short tasks in the app's own words (\"Create a project\", \"Invite a teammate\", \"Check the pricing page\"). changes is \"data\" for anything that creates, sends, saves or deletes; otherwise \"reads\". Prefer reads-only journeys; at most three that change data. No sign-out, no deleting, no payments. Test values are plain and the same every time (\"Watch check\").",
].join("\n");

/** 4–8 proposals for an explored app: the drafting model's (the one `describe`
    uses), checked, topped up from the pages; or the pages alone. */
export async function proposeJourneys(x: Exploration, o: { model?: boolean; log?: (l: string) => void } = {}): Promise<{ proposals: Proposal[]; by: string }> {
  const plain = plainProposals(x);
  if (o.model !== false) {
    const { pickProvider, chat } = await import("../describe.js");
    const p = pickProvider();
    if (p) {
      try {
        o.log?.(`Asking ${p.name} which journeys are worth watching…`);
        const got = parseProposals(await chat(p, SYSTEM, explorationText(x) + "\nPropose the journeys."), x);
        if (got.length) {
          const extra = plain.filter((q) => !got.some((g) => g.title.toLowerCase() === q.title.toLowerCase()));
          const merged = got.length >= MIN_PROPOSALS ? got : [...got, ...extra].slice(0, Math.max(MIN_PROPOSALS, got.length));
          return { proposals: merged.slice(0, MAX_PROPOSALS), by: `${p.name} · ${p.model}` };
        }
      } catch (e) { o.log?.(`${p.name} did not answer usefully (${(e as Error).message.split("\n")[0]}) — reading the pages instead`); }
    }
  }
  return { proposals: plain, by: "the pages" };
}

// ---------- the journey file ----------

const js = (s: string) => JSON.stringify(s);
const intentOf = (s: Step, x: { signInUrl: string | null }) =>
  s.do === "signIn" ? "Sign in" : s.do === "open" ? `Open ${s.label || s.path}` : s.do === "click" ? `Press “${s.label || s.selector}”` : s.do === "fill" ? `Fill in “${s.label || s.selector}”` : s.do === "select" ? `Choose ${s.value}${s.label ? ` for ${s.label}` : ""}` : `See “${(s as { text: string }).text}”`;

/** The journey, as a file a person (or their agent) can read and change. */
export function journeySource(p: Proposal, o: { origin: string; signInUrl?: string | null; from?: string; at?: Date }): string {
  const signInUrl = o.signInUrl ?? null;
  // A value typed in and then looked for after a press: something was created.
  const typed = new Set(p.steps.flatMap((s) => (s.do === "fill" ? [s.value] : [])));
  const lands = new Set(p.steps.flatMap((s, i) => (s.do === "click" && p.steps[i + 1]?.do === "see" && typed.has((p.steps[i + 1] as { text: string }).text) ? [i] : [])));
  const madeValues = [...lands].map((i) => (p.steps[i + 1] as { text: string }).text);
  const lines: string[] = [
    `// ${p.title}: ${p.checks}.`,
    `// Drafted by Retake from a look at ${o.origin}${o.from ? ` (${o.from})` : ""} on ${(o.at ?? new Date()).toISOString().slice(0, 10)}. Yours to change.`,
    `export const title = ${js(p.title)};`,
    `export const url = ${js(o.origin)};`,
    ...(p.changes === "data" ? [`export const changesData = true;   // runs only where this app is marked as a test space`] : []),
    // What it makes, by its exact text: hidden from every journey's comparison on this app, so a
    // list that grows each run never reads as a change, here or in the journeys that only look.
    ...(p.changes === "data" && madeValues.length ? [`export const makes = ${JSON.stringify(madeValues)};`] : []),
    ``,
    `const seen = (page, text) => page.getByText(text).first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);`,
    ...(lands.size ? [
      `// One more of it than before: what was just sent landed.`,
      `const grew = async (page, text, before) => { for (let i = 0; i < 20; i++) { if ((await page.getByText(text, { exact: true }).count()) > before) return true; await page.waitForTimeout(500); } return false; };`,
    ] : []),
    ``,
    `export default async function (page, w, { signIn }) {`,
  ];
  const steps = p.steps;
  // Something is made: one step, whose check is that one more of it appeared.
  // What it made (`makes`) is hidden from every capture on this app, so the
  // list it lands in looks the same run after run.
  const landsAt = [...lands][0];
  if (p.changes === "data" && landsAt !== undefined) {
    const made = (steps[landsAt + 1] as { text: string }).text;
    lines.push(`  await w.step(${js(p.title)}, ${js(`One more “${made}” appears`)});`);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (i === landsAt) {
        lines.push(`  const before = await page.getByText(${js(made)}, { exact: true }).count();`, `  await page.click(${js((s as { selector: string }).selector)}, { timeout: 10_000 });`,
          `  const landed = await grew(page, ${js(made)}, before);`, `  await w.result(landed, landed ? ${js(`“${made}” is there`)} : ${js(`“${made}” did not appear`)});`);
        break;
      }
      if (s.do === "signIn") lines.push(`  await page.goto(${js(signInUrl ?? o.origin)});`, `  await signIn(url);`);
      else if (s.do === "open") lines.push(`  await page.goto(new URL(${js(s.path)}, url).href);`);
      else if (s.do === "fill") lines.push(`  await page.fill(${js(s.selector)}, ${js(s.value)}, { timeout: 10_000 });`);
      else if (s.do === "select") lines.push(`  await page.selectOption(${js(s.selector)}, ${js(s.value)}, { timeout: 10_000 });`);
      else if (s.do === "click") lines.push(`  await page.click(${js(s.selector)}, { timeout: 10_000 });`);
      else if (s.do === "see") lines.push(`  await seen(page, ${js(s.text)});`);
    }
    lines.push(`}`, ``);
    return lines.join("\n");
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.do === "see") {
      // A see with nothing before it is a step of its own.
      lines.push(`  await w.step(${js(intentOf(s, { signInUrl }))}, ${js(`“${s.text}” is on the page`)});`, `  await w.result(await seen(page, ${js(s.text)}), ${js(`“${s.text}”`)});`);
      continue;
    }
    const next = steps[i + 1]?.do === "see" ? (steps[i + 1] as { text: string }).text : null;
    const expect = next && lands.has(i) ? `“${next}” is added` : next ? `“${next}” is on the page` : s.do === "open" ? "The page opens" : s.do === "signIn" ? "The app opens, signed in" : "It works";
    lines.push(`  await w.step(${js(intentOf(s, { signInUrl }))}, ${js(expect)});`);
    if (s.do === "signIn") {
      lines.push(`  await page.goto(${js(signInUrl ?? o.origin)});`, `  await signIn(url);`);
    } else if (s.do === "open") {
      lines.push(`  const r${i} = await page.goto(new URL(${js(s.path)}, url).href);`, ...(next ? [] : [`  await w.result(!r${i} || r${i}.status() < 400, r${i} ? "Answered " + r${i}.status() : "");`]));
    } else if (s.do === "click" && lands.has(i)) {
      lines.push(`  const before${i} = await page.getByText(${js(next!)}, { exact: true }).count();`, `  await page.click(${js(s.selector)}, { timeout: 10_000 });`,
        `  const landed${i} = await grew(page, ${js(next!)}, before${i});`, `  await w.result(landed${i}, landed${i} ? ${js(`“${next}” is there`)} : ${js(`“${next}” did not appear`)});`);
      i++;
      continue;
    } else if (s.do === "click") {
      lines.push(`  await page.click(${js(s.selector)}, { timeout: 10_000 });`);
    } else if (s.do === "fill") {
      lines.push(`  await page.fill(${js(s.selector)}, ${js(s.value)}, { timeout: 10_000 });`);
    } else if (s.do === "select") {
      lines.push(`  await page.selectOption(${js(s.selector)}, ${js(s.value)}, { timeout: 10_000 });`);
    }
    if (next) { lines.push(`  await w.result(await seen(page, ${js(next)}), ${js(`“${next}”`)});`); i++; }
    else if (s.do !== "open") lines.push(`  await w.result(true);`);
  }
  lines.push(`}`, ``);
  return lines.join("\n");
}

// ---------- kept proposals ----------

export type Suggestion = { origin: string; at: string; by: string; signIn: { url: string } | null; signedIn: boolean; proposals: Proposal[] };
const suggestFile = (root: string, origin: string) => path.join(journeysDir(root), ".suggest", `${hostName(origin).replace(/[^a-z0-9.-]+/gi, "-")}.json`);
export const readSuggestion = (root: string, url: string) => { const o = originOf(url); return o ? readJson<Suggestion | null>(suggestFile(root, o), null) : null; };
export function keepSuggestion(root: string, s: Suggestion) {
  fs.mkdirSync(path.dirname(suggestFile(root, s.origin)), { recursive: true });
  writeJson(suggestFile(root, s.origin), s);
}

/** Look, propose, and keep the proposals so `add --pick` means the same list. */
export async function suggest(root: string, url: string, o: { model?: boolean; log?: (l: string) => void } = {}): Promise<{ suggestion: Suggestion; exploration: Exploration }> {
  const x = await explore(url, { log: o.log });
  const { proposals, by } = await proposeJourneys(x, o);
  const s: Suggestion = { origin: x.origin, at: new Date().toISOString(), by, signIn: x.signIn, signedIn: x.signedIn, proposals };
  keepSuggestion(root, s);
  return { suggestion: s, exploration: x };
}

/** "1,3,4" → [1, 3, 4], each one of the proposals. */
export function parsePick(pick: string, count: number): number[] {
  const out: number[] = [];
  for (const part of pick.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`"${part}" is not one of the proposals — pick from 1 to ${count}`);
    if (!out.includes(n)) out.push(n);
  }
  if (!out.length) throw new Error("pick at least one, e.g. --pick 1,3");
  return out;
}

export const nameFor = (title: string, taken: Set<string>) => {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "journey";
  let n = journeyNameOk(base) ? base : `j-${base}`.slice(0, 48);
  for (let i = 2; taken.has(n); i++) n = `${base.slice(0, 44)}-${i}`;
  taken.add(n);
  return n;
};

// ---------- adding, behind one dry run ----------

export type Added = { title: string; added: boolean; name?: string; why?: string; already?: boolean };

/** Does this proposal sign in first? */
export const signsIn = (p: Proposal) => p.steps.some((s) => s.do === "signIn");



/** Why a dry run did not pass, in one sentence. */
export function whyNot(r: Pick<RunRecord, "error" | "status"> & { steps?: number }, failedStep?: { intent: string; note: string } | null): string {
  const e = r.error ?? "";
  const login = /no saved login for (\S+)/.exec(e);
  if (login) return `It needs a test account for ${login[1]}: save one, then add it again.`;
  if (failedStep) return `It did not pass its first run: “${failedStep.intent}” failed${failedStep.note ? ` (${failedStep.note.replace(/[.\s]+$/, "")})` : ""}.`;
  return `It did not pass its first run${e ? `: ${e.replace(/[.\s]+$/, "")}` : ""}.`;
}

/**
 * Write each picked journey, run it once, and keep it only if that run
 * passes; the run is then its normal. `code` is the person's agent's own
 * file for a proposal, by its number, instead of Retake's.
 */
export async function addJourneys(o: {
  root: string; out: string; suggestion: Suggestion; pick: number[]; code?: Record<number, string>;
  log?: (l: string) => void;
  run?: (a: { root: string; name: string; file: string; out: string }) => Promise<RunRecord>;
}): Promise<Added[]> {
  const log = o.log ?? (() => {});
  const taken = new Set(listJourneys(o.root).map((j) => j.name));
  const results: Added[] = [];
  const run = o.run ?? (async (a) => (await import("./journeys.js")).runJourney({ ...a, ui: false }));
  const { readSteps } = await import("./session.js");
  for (const n of o.pick) {
    const p = o.suggestion.proposals[n - 1];
    if (!p) { results.push({ title: `#${n}`, added: false, why: "There is no such proposal." }); continue; }
    const own = o.code?.[n];
    const have = alreadyWatched(o.root, o.suggestion.origin, p);
    if (have) { results.push({ title: p.title, added: false, already: true, name: have, why: `Already watched, as watch/${have}.mjs.` }); continue; }
    const changes = p.changes === "data" || (own ? /export\s+const\s+changesData\s*=\s*true/.test(own) : false);
    if (changes && !isTestSpace(o.root, o.suggestion.origin)) {
      results.push({ title: p.title, added: false, why: `It changes data, and ${hostName(o.suggestion.origin)} is not marked as a test space.` });
      continue;
    }
    const name = nameFor(p.title, taken);
    const staged = path.join(journeysDir(o.root), ".new", `${name}.mjs`);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    let src = own ?? journeySource(p, { origin: o.suggestion.origin, signInUrl: o.suggestion.signIn?.url ?? null, from: o.suggestion.by });
    // An agent's file still has to say which app it is about, and whether it writes.
    if (own && !/export\s+const\s+url\s*=/.test(src)) src = `export const url = ${js(o.suggestion.origin)};\n${src}`;
    if (own && changes && !/export\s+const\s+changesData\s*=/.test(src)) src = `export const changesData = true;\n${src}`;
    fs.writeFileSync(staged, src);
    log(`▶ ${p.title}: its first run`);
    const state = path.join(journeysDir(o.root), ".journeys", name);
    let r: RunRecord | null = null, error: string | null = null;
    try { r = await run({ root: o.root, name, file: staged, out: o.out }); } catch (e) { error = (e as Error).message.split("\n")[0]; }
    if (r && r.status !== "failed") {
      fs.renameSync(staged, path.join(journeysDir(o.root), `${name}.mjs`));
      results.push({ title: p.title, added: true, name });
      log(`✓ ${p.title} added as watch/${name}.mjs`);
      continue;
    }
    const failed = r?.dir ? readSteps(r.dir).find((s) => s.result === "fail") : null;
    const why = r ? whyNot(r, failed ? { intent: failed.intent, note: failed.note } : null) : whyNot({ error, status: "failed" });
    fs.rmSync(staged, { force: true });
    fs.rmSync(state, { recursive: true, force: true });
    if (r?.dir && r.dir.includes(`${path.sep}watch${path.sep}`)) fs.rmSync(r.dir, { recursive: true, force: true });
    taken.delete(name);
    results.push({ title: p.title, added: false, why });
    log(`✗ ${p.title} not added — ${why}`);
  }
  try { fs.rmdirSync(path.join(journeysDir(o.root), ".new")); } catch { /* not empty, or gone */ }
  return results;
}
