/**
 * Running a journey: a company's key flow, written once as a script, run
 * under Watch so it leaves a session like any other, and put against the
 * run that was accepted as normal.
 *
 *   // watch/licences.mjs
 *   export const title = "Portal – licences";              // optional
 *   export const viewport = { width: 390, height: 844 };   // optional; 480 wide or less is a phone
 *   export default async function (page, w, { signIn }) {
 *     await w.step("Sign in", "The portal opens");
 *     await signIn("https://portal.example.com");          // the login saved with `retake login`
 *     await w.result(true);
 *     await w.step("Open Licences", "The licence is listed");
 *     await page.click("nav >> text=Licences");
 *     await w.result(await page.isVisible("table"), "Listed");
 *   }
 *
 * At every `w.result` the page is captured as it is then: its visible text
 * (masked parts left out) and its picture. That is what the next run is
 * compared with.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { launchChromium } from "../browser-home.js";
import { readLogin, siteOf } from "../logins.js";
import { totp } from "../manifest.js";
import { startWatch, type Watch } from "../watch.js";
import { compareSnapshots, verdict, type Rect, type Snapshot } from "./compare.js";
import { acceptRun, baselineDir, loadPicture, pruneQuietRuns, readBaseline, readSnapshots, writeRun, type RunRecord } from "./journey-store.js";
import { readSteps, writeJson } from "./session.js";

export const DESKTOP = { width: 1280, height: 800 };
/** A journey that does not finish in this long has stopped, whatever it is waiting for. */
export const JOURNEY_TIMEOUT_MS = 10 * 60_000;

export type SignInOptions = {
  /** Where the username goes, if the page's own field is not found. */
  user?: string;
  password?: string;
  code?: string;
  /** Stop as soon as this screen shows, with nothing typed into it: for a
      journey that looks at the sign-in screens themselves. */
  until?: "password" | "code";
};

export type JourneyKit = {
  /** Sign in with the login saved for this site (`retake login <url>`): the
      username, the password and, when one is saved, the authenticator code,
      on as many screens as the sign-in takes. Each field is masked before
      anything is typed into it. Never retries a refused password. */
  signIn(url?: string, o?: SignInOptions): Promise<void>;
  /** True when the journey runs at phone width. */
  phone: boolean;
};

export type JourneyModule = {
  default: (page: Page, w: Watch, kit: JourneyKit) => Promise<void>;
  title?: string;
  viewport?: { width: number; height: number };
};

/** No login is saved for the site a journey signs in to. */
export class MissingLogin extends Error {
  constructor(readonly site: string, readonly url: string) {
    super(`no saved login for ${site} — run \`retake login ${url}\` once, with the test account's e-mail, password and authenticator key`);
  }
}

// ---------- capture ----------

/** The page's visible text, one line per block, leaving out anything a mask
    covers and Retake's own cursor. */
const TEXT_SCRIPT = `(() => {
  const sels = (window.__retakeMask && window.__retakeMask.list()) || [];
  const hidden = (el) => { if (el.closest('[data-retake]')) return true; for (const s of sels) { try { if (el.closest(s)) return true; } catch {} } return false; };
  const blocks = new Map();
  const blockOf = (el) => {
    const chain = [];
    let e = el;
    while (e && e !== document.body) { if (blocks.has(e)) break; chain.push(e); const d = getComputedStyle(e).display; if (!d.startsWith('inline') && d !== 'contents') break; e = e.parentElement; }
    const b = e && blocks.has(e) ? blocks.get(e) : (e || document.body);
    for (const c of chain) blocks.set(c, b);
    return b;
  };
  const out = []; let cur = ''; let last = null;
  if (!document.body) return out;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    const t = (n.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    if (hidden(el)) continue;
    if (el.checkVisibility ? !el.checkVisibility({ checkOpacity: true, visibilityProperty: true }) : !el.getClientRects().length) continue;
    const b = blockOf(el);
    if (b !== last) { if (cur) out.push(cur); cur = ''; last = b; }
    cur = cur ? cur + ' ' + t : t;
  }
  if (cur) out.push(cur);
  return out;
})()`;

/** Where the masks (and the cursor) are, in CSS pixels of the viewport. */
const MASKS_SCRIPT = `(() => {
  const sels = ((window.__retakeMask && window.__retakeMask.list()) || []).concat(['[data-retake="cursor"]']);
  const out = [];
  for (const s of sels) {
    let els = [];
    try { els = document.querySelectorAll(s); } catch { continue; }
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      out.push({ x: r.left - 6, y: r.top - 6, width: r.width + 12, height: r.height + 12 });
    }
  }
  return { rects: out, width: innerWidth };
})()`;

/** The picture once it has stopped moving: two in a row the same, or the
    last of four. */
async function stillShot(page: Page): Promise<Buffer> {
  let prev = await page.screenshot({ type: "png", caret: "hide", timeout: 10_000 });
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(300);
    const next = await page.screenshot({ type: "png", caret: "hide", timeout: 10_000 });
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

async function capture(page: Page, dir: string, n: number): Promise<Pick<Snapshot, "text" | "shot" | "masks" | "width" | "height">> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  let text: string[] = [], shot: string | null = null, masks: Rect[] = [], width = 0, height = 0;
  try { text = (await page.evaluate(TEXT_SCRIPT)) as string[]; } catch { /* a page mid-navigation has no text yet */ }
  try {
    const png = await stillShot(page);
    const rel = `snapshots/step-${String(n).padStart(2, "0")}.png`;
    fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), png);
    shot = rel;
    width = png.readUInt32BE(16); height = png.readUInt32BE(20);
    const m = (await page.evaluate(MASKS_SCRIPT).catch(() => null)) as { rects: Rect[]; width: number } | null;
    if (m) { const k = width / (m.width || width); masks = m.rects.map((r) => ({ x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k })); }
  } catch { /* no picture: the text still counts */ }
  return { text, shot, masks, width, height };
}

/** The Watch the journey is given: the same calls, plus a capture at every
    result, kept as snapshots.json in the session folder. */
function tracked(w: Watch, page: Page): { w: Watch; open: () => boolean; snapshots: Snapshot[] } {
  let n = 0, open = false;
  const snapshots: Snapshot[] = [];
  const t: Watch = {
    get dir() { return w.dir; },
    get link() { return w.link; },
    scenario: (name) => w.scenario(name),
    async step(intent, expect) { await w.step(intent, expect); n++; open = true; },
    async result(ok, note) {
      if (n === 0) n = 1;
      const snap = await capture(page, w.dir, n);
      await w.result(ok, note);
      open = false;
      const s = readSteps(w.dir).find((x) => x.n === n);
      const rec: Snapshot = { n, scenario: s?.scenario ?? null, intent: s?.intent ?? "", result: s?.result ?? (ok ? "pass" : "fail"), url: s?.url ?? page.url(), t: s?.t ?? 0, tEnd: s?.tEnd ?? null, ...snap };
      const i = snapshots.findIndex((x) => x.n === n);
      if (i >= 0) snapshots[i] = rec; else snapshots.push(rec);
      writeJson(path.join(w.dir, "snapshots.json"), snapshots);
    },
    beat: () => w.beat(),
    mask: (x) => w.mask(x),
    unmask: (x) => w.unmask(x),
    end: () => w.end(),
  };
  return { w: t, open: () => open, snapshots };
}

// ---------- signing in ----------

const USER_SEL = 'input[autocomplete="username"], input[type="email"], input[name="loginName"], input[name="username"], input[name="email"], input[name="login"]';
const PASS_SEL = 'input[type="password"]';
const CODE_SEL = 'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[name="totp"], input#code';
let lastCode = "";

async function visible(page: Page, sel: string) {
  const l = page.locator(sel);
  const n = await l.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i);
  return null;
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(300);
}

function makeKit(page: Page, w: Watch, phone: boolean, secrets: Set<string>): JourneyKit {
  return {
    phone,
    async signIn(url, o = {}) {
      const target = url ?? page.url();
      const full = /^[a-z]+:\/\//i.test(target) ? target : `https://${target}`;
      const site = siteOf(full);
      const user = readLogin(site, "user"), password = readLogin(site, "password"), key = readLogin(site, "totp");
      if (!user || !password) throw new MissingLogin(site, new URL(full).origin);
      for (const v of [user, password, key]) if (v) secrets.add(v);
      const userSel = o.user ?? USER_SEL, passSel = o.password ?? PASS_SEL, codeSel = o.code ?? CODE_SEL;
      // Hidden before anything is typed: the stream, the video, the pictures and the compared text.
      await w.mask([userSel, passSel, codeSel]);
      if (siteOf(page.url()) !== site) await page.goto(full, { waitUntil: "domcontentloaded" });
      const tries = { user: 0, password: 0, code: 0 };
      for (let screen = 0; screen < 10; screen++) {
        await settle(page);
        const code = key ? await visible(page, codeSel) : null;
        const pass = await visible(page, passSel);
        const name = await visible(page, userSel);
        if (o.until === "password" && pass) return;
        if (o.until === "code" && (code ?? (await visible(page, codeSel)))) return;
        if (!code && !pass && !name) {
          if (siteOf(page.url()) === site) return;
          throw new Error(`the sign-in stopped on a screen it does not know (${new URL(page.url()).host}, “${(await page.title().catch(() => "")).slice(0, 60)}”)`);
        }
        if (code) {
          if (++tries.code > 2) throw new Error("the authenticator code was refused twice — stopped, so the account is not locked");
          let c = totp(key!);
          // The same code twice is refused: wait for the next one.
          if (c === lastCode) { await page.waitForTimeout(30_500 - (Date.now() % 30_000)); c = totp(key!); }
          lastCode = c;
          await code.fill(c);
          await code.press("Enter");
        } else if (pass) {
          if (++tries.password > 1) throw new Error("the password was asked for again — it was refused, so this stopped rather than risk locking the account");
          if (name && !(await name.inputValue().catch(() => ""))) await name.fill(user);
          await pass.fill(password);
          await pass.press("Enter");
        } else if (name) {
          if (++tries.user > 2) throw new Error("the sign-in asked for the username again — it was not accepted");
          await name.fill(user);
          await name.press("Enter");
        }
        await page.waitForEvent("framenavigated", { timeout: 15_000 }).catch(() => {});
      }
      throw new Error("the sign-in took more than ten screens — stopped");
    },
  };
}

const scrub = (s: string, secrets: Set<string>) => {
  let out = s.split("\n")[0].slice(0, 400);
  for (const v of secrets) if (v.length >= 3) out = out.split(v).join("•••");
  return out;
};

// ---------- the run ----------

export async function runJourney(o: {
  root: string; name: string; file: string; out: string;
  ui?: string | false; scheduled?: boolean; headed?: boolean;
  log?: (l: string) => void;
}): Promise<RunRecord> {
  const log = o.log ?? (() => {});
  const mod = (await import(pathToFileURL(o.file).href)) as JourneyModule;
  if (typeof mod.default !== "function") throw new Error(`${path.relative(o.root, o.file)} has no default export — it should be \`export default async function (page, w, kit) { … }\``);
  const viewport = mod.viewport && mod.viewport.width > 0 && mod.viewport.height > 0 ? { width: Math.round(mod.viewport.width), height: Math.round(mod.viewport.height) } : DESKTOP;
  const phone = viewport.width <= 480;
  const title = String(mod.title ?? o.name).trim() || o.name;

  const browser = await launchChromium({ headless: !o.headed });
  const secrets = new Set<string>();
  let rec: RunRecord;
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    const watch = await startWatch(page, { title, ui: o.ui, out: o.out });
    const t = tracked(watch, page);
    const startedAt = new Date().toISOString();
    let error: string | null = null;
    try {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the journey took longer than ${JOURNEY_TIMEOUT_MS / 60_000} minutes`)), JOURNEY_TIMEOUT_MS); });
      try { await Promise.race([mod.default(page, t.w, makeKit(page, t.w, phone, secrets)), late]); } finally { clearTimeout(timer); }
      if (t.open()) await t.w.result(true, "");
    } catch (e) {
      error = scrub((e as Error)?.message ?? String(e), secrets);
      try {
        if (!t.open()) await t.w.step("The journey stopped", "It runs to its end");
        await t.w.result(false, error);
      } catch { /* the page may be gone */ }
    }
    const { dir } = await watch.end();
    const session = path.basename(dir);
    const after = readSnapshots(dir);
    const baseline = readBaseline(o.root, o.name);
    const bdir = baselineDir(o.root, o.name);
    const changes = baseline ? compareSnapshots(baseline.steps, after, (s, side) => loadPicture(side === "before" ? bdir : dir, s)) : [];
    const status = verdict({ error, steps: after, changes });
    rec = { journey: o.name, title, at: startedAt, session, dir, status, scheduled: !!o.scheduled, error, steps: after.length, changes };
    // The first run that passes is the normal until a person says otherwise.
    if (!baseline && status === "unchanged") { const b = acceptRun(o.root, o.name, dir, session); rec.firstRun = true; rec.acceptedAt = b.acceptedAt; }
    writeRun(o.root, rec);
    if (o.scheduled) {
      const gone = pruneQuietRuns(o.root, o.name, session);
      if (gone.length) log(`  tidied ${gone.length} older unchanged night${gone.length === 1 ? "" : "s"}`);
    }
    await context.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  return rec;
}
