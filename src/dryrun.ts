/**
 * Dry run — execute a manifest with no camera, and report what would break.
 *
 * Recording is the slow part of a take (a demo has to be performed in real
 * time). Checking that every selector resolves and every wait resolves does
 * not: it runs as fast as the app responds. So the cheap thing should happen
 * first, and the camera should only roll on a manifest that already works.
 */
import fs from "node:fs";
import path from "node:path";
import { applyPageSetup, authState, dragPoints, gateOnApp, resolvePoint, runEvaluateSeed, runFileOrCommandSeed } from "./record.js";
import { chromium, type Page, type BrowserContext } from "playwright";
import { waitForStep } from "./waiting.js";
import { expandEnv, resolve, type Manifest, type Step, type Stub } from "./manifest.js";

/** The longest a dry run will wait for anything. Long enough for a real app
    to answer, short enough that checking a demo stays a seconds-long job. */
const DRY_WAIT_CAP = 15_000;

export type DryResult = { ok: boolean; lines: string[]; failures: number };

/** What the element actually is, as the page sees it. */
type ElInfo = { tag: string; type: string; disabled: boolean; readOnly: boolean; editable: boolean };

async function elInfo(page: Page, selector: string, timeout: number): Promise<ElInfo | null> {
  try {
    const h = await page.locator(selector).first().elementHandle({ timeout });
    if (!h) return null;
    const info = await h.evaluate((el) => {
      const e = el as HTMLElement & { type?: string; disabled?: boolean; readOnly?: boolean };
      return {
        tag: e.tagName.toLowerCase(),
        type: (e.type ?? "").toLowerCase(),
        disabled: !!e.disabled || e.getAttribute("aria-disabled") === "true",
        readOnly: !!e.readOnly,
        editable: e.isContentEditable,
      };
    });
    await h.dispose();
    return info;
  } catch { return null; }
}

/** Does this action make sense on this element? Returns the complaint, or null.
 *
 * This is the check that pays for itself: an action that cannot work on the
 * element it names is knowable before a single frame is recorded, and finding
 * it out during a take costs the whole take. So the message names the fix, not
 * just the symptom — a report that says "use `action: select`" ends the
 * problem, one that says "element is not an <input>" starts an investigation. */
export function actionFits(action: string, el: ElInfo): string | null {
  const NOT_TEXT = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color"]);
  const is = (t: string) => el.tag === t;
  if (action === "type" || action === "fill") {
    if (is("select")) return `\`${action}\` cannot be used on a <select> — use \`action: select\` with \`value: "<the option>"\``;
    if (is("input") && el.type === "file") return `\`${action}\` cannot be used on a file input — use \`action: upload\` with \`file:\``;
    if (is("input") && NOT_TEXT.has(el.type)) return `\`${action}\` cannot be used on <input type="${el.type}"> — it holds no text; \`action: click\` is probably what you mean`;
    if (!is("input") && !is("textarea") && !el.editable) return `\`${action}\` needs a text field, but this is a <${el.tag}> that is not editable — if it is a custom editor, target the inner element that accepts typing`;
    if (el.disabled) return `\`${action}\` cannot type into a disabled <${el.tag}> — something earlier has to enable it first`;
    if (el.readOnly) return `\`${action}\` cannot type into a read-only <${el.tag}>`;
  }
  if (action === "select" && !is("select")) {
    return `\`select\` only works on a real <select>, and this is a <${el.tag}> — for a custom dropdown, \`click\` it and then \`click\` the option`;
  }
  if (action === "upload" && !(is("input") && el.type === "file")) {
    return `\`upload\` needs <input type="file">, and this is a <${el.tag}>${el.type && el.type !== el.tag ? ` type="${el.type}"` : ""}`;
  }
  if (action === "click" && el.disabled) {
    return `this <${el.tag}> is disabled right now — the click would do nothing; wait for whatever enables it (\`action: waitFor\`) before clicking`;
  }
  return null;
}

export async function dryRun(m: Manifest, manifestDir: string, log: (l: string) => void, opts: { seed?: boolean; outRoot?: string } = {}): Promise<DryResult> {
  const q = resolve(m);
  const lines: string[] = [];
  let failures = 0;
  /** What the page actually laid out at — the width its breakpoints saw. */
  let layoutWidth: number | null = null;
  // Failure pictures land beside the demo's other output, not in the cwd.
  const shotDir = path.join(opts.outRoot ?? "outputs", m.name);
  // Seeds run here too (file and command kinds — the cheap, out-of-page
  // ones). Without them dry checks a different app state than run will,
  // and a selector failure that is really a state difference looks like a
  // selector failure. --no-seed opts out.
  const fileSeeds = m.seed.filter((s) => s.kind !== "evaluate");
  if (opts.seed !== false && fileSeeds.length) {
    for (const s of fileSeeds) await runFileOrCommandSeed(s, manifestDir, log);
  } else if (fileSeeds.length) {
    log("dry: seeds skipped (--no-seed) — app state may not match what run will see");
  }
  const browser = await chromium.launch({ headless: true });
  // Start from the same session run would. Without this, a demo behind a
  // login was dry-run logged OUT — every selector "missing", or worse, a
  // green dry against a marketing page and a failed take against the app.
  const auth = authState(m, manifestDir);
  if (auth.path) log(auth.fresh ? `dry: reusing session ${path.relative(process.cwd(), auth.path)}` : `dry: no fresh session — auth.setup will have to sign in`);
  const context = await browser.newContext({
    viewport: q.viewport,
    colorScheme: m.colorScheme,
    ...(m.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
    ...(auth.fresh && auth.path ? { storageState: auth.path } : {}),
  });

  // Whatever the recorder injects, dry injects — one function, so the two
  // cannot drift apart again. (Measured, for the record: `html{zoom}` does
  // NOT move an app's media queries, which is why the layout width reported
  // below is asked of the page rather than computed as width÷scale.)
  await applyPageSetup(context, m, q);

  const stubs = new Map<string, Stub>();
  const arm = async (d: Stub) => {
    const key = `${d.method ?? "ANY"} ${d.url}`;
    const fresh = !stubs.has(key);
    stubs.set(key, d);
    if (!fresh) return;
    await context.route(d.url, async (route, request) => {
      const cur = stubs.get(key)!;
      if (cur.method && request.method().toUpperCase() !== cur.method.toUpperCase()) return route.fallback();
      const body = cur.json !== undefined ? JSON.stringify(cur.json) : cur.from ? fs.readFileSync(path.resolve(manifestDir, expandEnv(cur.from)), "utf8") : "{}";
      await route.fulfill({ status: cur.status ?? 200, contentType: cur.contentType, body });
    });
  };

  const page = await context.newPage();
  try {
    for (const d of m.stub) await arm(d);
    // Document first; idle only if it comes quickly. Busy public sites never
    // go network-idle, and the manifest's waitForSelector is the real gate.
    await page.goto(expandEnv(m.url), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => { /* see above */ });
    // `evaluate` seeds write into the page itself — the panel that only
    // exists once some state is seeded. Dry skipped them, so dry and run were
    // literally looking at different apps; that was one of three lost takes
    // in the field report.
    if (opts.seed !== false) {
      for (const sd of m.seed) if (sd.kind === "evaluate") await runEvaluateSeed(page, sd, manifestDir, log);
    }
    // The manifest's own readiness gate, with run's wrong-app diagnosis. A dry
    // run that starts stepping before the app has booted reports selector
    // failures that are really a race.
    await gateOnApp(page, m, shotDir);
    layoutWidth = await page.evaluate(() => document.documentElement.clientWidth).catch(() => null);
    // Exactly what the recorder does: sign-in steps run only when there is no
    // fresh session to reuse. Running them unconditionally made `dry` sign in
    // again every time — slower than it needed to be, and a different sequence
    // from the one it is supposed to be predicting.
    for (const s of [...(auth.fresh ? [] : (m.auth?.setup ?? [])), ...m.setup]) await run(s, true);
    for (const [i, s] of m.steps.entries()) await run(s, false, i);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  async function run(step: Step, isSetup: boolean, index = -1) {
    const tag = isSetup ? "setup" : String(index).padStart(3, "0");
    const short = 8000; // long enough for a click that navigates, short enough to stay fast
    try {
      // Before doing anything: does this action fit the element it names? A
      // mismatch is the expensive kind of failure — the selector resolves, dry
      // passes, and the take dies on it minutes into a recording.
      const sel = (step as { selector?: string }).selector;
      if (sel && ["type", "fill", "select", "upload", "click"].includes(step.action)) {
        const el = await elInfo(page, sel, short);
        const complaint = el && actionFits(step.action, el);
        if (complaint) throw new Error(complaint);
      }
      // A point step (click/hover `at`, or a drag) is verified by resolving
      // its target's rect in the page — the same way the recorder will.
      const point = async (t: unknown): Promise<{ x: number; y: number }> => {
        if (t && typeof t === "object" && "x" in (t as Record<string, unknown>)) return t as { x: number; y: number };
        const sel = typeof t === "string" ? t : (t as { selector: string }).selector;
        const until = Date.now() + short;
        let box: { w: number; h: number } | null = null;
        while (Date.now() < until) {
          const handle = await page.locator(sel).first().elementHandle({ timeout: Math.max(400, until - Date.now()) });
          if (handle) { box = await handle.evaluate((el) => { const r = (el as Element).getBoundingClientRect(); return { w: r.width, h: r.height }; }); await handle.dispose(); if (box && (box.w || box.h)) break; }
          await page.waitForTimeout(250);
        }
        if (!box) throw new Error(`no element for point target "${sel}"`);
        if (!box.w && !box.h) throw new Error(`point target "${sel}" never got a size (still hidden or collapsed?)`);
        return resolvePoint(page, t as never, short);
      };
      // Point steps are PERFORMED here, not just resolved: a dry run that skips
      // the click that opens a panel then reports every later step in that
      // panel as broken. Drags run compressed — the gesture, not the pacing.
      if (step.action === "drag") {
        const f = await point(step.from), t = await point(step.to);
        await dragPoints(page, f, t, { steps: 6, holdMs: 60, durationMs: 240 });
        await page.waitForTimeout(400);
      } else if ((step.action === "click" || step.action === "hover") && step.at) {
        const pt = await point(step.at);
        if (step.action === "click") { await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(400); }
        else await page.mouse.move(pt.x, pt.y);
      }
      else switch (step.action) {
        case "navigate": await page.goto(expandEnv(step.url), { waitUntil: "domcontentloaded", timeout: 60000 }); await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); break;
        // The same wait the recorder performs, capped so a dry run stays
        // cheap. It used to check only that the selector appeared, ignoring
        // `minChars` and `stableMs` entirely — so a manifest waiting for a
        // streamed result passed here and timed out on camera.
        case "waitFor": await waitForStep(page, step, { cap: DRY_WAIT_CAP }); break;
        // noWaitAfter: a click that submits a form starts a navigation, and
        // waiting for the element to settle afterwards reports a false failure
        // for a click that actually worked.
        case "click":
          await page.locator(step.selector!).waitFor({ timeout: short }); // strict, like the recorder
          await page.locator(step.selector!).first().click({ timeout: short, noWaitAfter: true });
          await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
          break;
        case "type": await page.locator(step.selector).waitFor({ timeout: short }); await page.locator(step.selector).fill(expandEnv(step.text), { timeout: short }); break;
        case "fill": await page.locator(step.selector).waitFor({ timeout: short }); await page.locator(step.selector).fill(expandEnv(step.text), { timeout: short }); break;
        case "hover": await page.locator(step.selector!).first().hover({ timeout: short }); break;
        case "select": {
          // Resolving is not enough: an option that does not exist is the
          // whole failure mode, so dry proves the value is selectable.
          const sel = page.locator(step.selector).first();
          await sel.waitFor({ timeout: short });
          try { await sel.selectOption(step.value, { timeout: short }); }
          catch { await sel.selectOption({ label: step.value }, { timeout: short }); }
          break;
        }
        case "scroll": if (step.to) await page.locator(step.to).first().boundingBox({ timeout: short }); break;
        case "upload": await page.locator(step.selector).first().waitFor({ timeout: short }); break;
        case "evaluate": await page.evaluate(step.script); break;
        case "stub": await arm({ url: step.url, method: step.method, status: step.status ?? 200, json: step.json, from: step.from, contentType: "application/json; charset=utf-8" }); break;
        case "keyboard": await page.keyboard.press(step.key); break;
        // Pacing does not matter in a dry run, so step waits are compressed.
        // Setup waits are not: they are usually giving a navigation or a login
        // time to finish, and cutting them changes the outcome.
        case "wait": await page.waitForTimeout(isSetup ? step.ms : Math.min(step.ms, 400)); break;
        case "callout": await point(step.selector ?? step.at!); break;
        default: break; // scene, screenshot, zoom, download: nothing to verify
      }
      if (step.pauseAfter) await page.waitForTimeout(120);
    } catch (e) {
      failures++;
      const why = (e as Error).message.split("\n")[0];
      // What was actually on screen matters more than the timeout message:
      // most "selector not found" is really "you are on a different page".
      let where = "";
      try {
        const text = (await page.innerText("body")).replace(/\s+/g, " ").trim().slice(0, 110);
        where = `\n        on ${page.url()} — “${text}”`;
      } catch { /* page may be gone */ }
      // Text alone cannot say "another element is covering the button" or
      // "the layout is not what you think". A picture can, and dry is the
      // cheap pass — it should hand over more than run's does, not less.
      try {
        const shot = path.join(shotDir, `dry-failed-${String(failures).padStart(2, "0")}.png`);
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: shot, fullPage: true });
        where += `\n        picture: ${path.relative(process.cwd(), shot)}`;
      } catch { /* not fatal */ }
      const line = `✗ [${tag}] ${describe(step)} — ${why}${where}`;
      lines.push(line);
      log(line);
    }
  }

  const ok = failures === 0;
  log(ok ? `dry run: all ${m.steps.length} steps resolved` : `dry run: ${failures} step(s) would fail`);
  // A preset's width is VIDEO pixels: at scale 2 a 1920 preset lays the page
  // out at 960 CSS px, under most desktop breakpoints, so a responsive app
  // quietly serves its MOBILE layout and the steps are looking for fields that
  // are not there. It reads as a pile of broken selectors, and costs a whole
  // take to work out. Only asked when something actually failed, and only
  // reported when the wider page proves it.
  if (!ok) {
    // Measured, not computed: `zoom` does not move an app's media queries, so
    // width÷scale is not the number the page's breakpoints saw. Ask the page.
    const cssWidth = layoutWidth ?? q.viewport.width;
    if (cssWidth < 1100) {
      const missing = lines.map((l) => /✗ \[[^\]]+\] \w+ (.+?) —/.exec(l)?.[1]).filter((x): x is string => !!x);
      const found = await resolvesWiderThan(m, missing, cssWidth, manifestDir);
      if (found.length) {
        const note = `⚠ ${found.length} of these selector(s) DO exist when the page is 1280 CSS px wide, but not at ${cssWidth}px.\n` +
          `   This take lays the page out at ${cssWidth} CSS px, which is below this app's desktop breakpoint — you are filming its mobile layout.\n` +
          `   Fix: give the manifest a wider \`viewport\`, or write the steps against the layout you are actually filming.\n` +
          `   Resolved wider: ${found.slice(0, 4).join(", ")}${found.length > 4 ? ` … +${found.length - 4}` : ""}`;
        lines.push(note);
        log(note);
      }
    }
  }
  return { ok, lines, failures };
}

/** Load the same page at a desktop width and report which of these selectors
    resolve there. Proof, not a guess: it is only worth telling someone their
    preset is filming the mobile layout if the wider page really does have the
    thing they were looking for. */
async function resolvesWiderThan(m: Manifest, selectors: string[], narrowPx: number, manifestDir: string): Promise<string[]> {
  const unique = [...new Set(selectors)].filter((s) => s && !s.startsWith("http"));
  if (!unique.length || narrowPx >= 1280) return [];
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: m.colorScheme });
    const page = await ctx.newPage();
    for (const d of m.stub) {
      await ctx.route(d.url, async (route) => {
        const body = d.json !== undefined ? JSON.stringify(d.json) : d.from ? fs.readFileSync(path.resolve(manifestDir, expandEnv(d.from)), "utf8") : "{}";
        await route.fulfill({ status: d.status ?? 200, contentType: d.contentType, body });
      });
    }
    await page.goto(expandEnv(m.url), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    const found: string[] = [];
    for (const sel of unique) {
      try { if (await page.locator(sel).first().isVisible({ timeout: 1500 })) found.push(sel); } catch { /* still missing */ }
    }
    return found;
  } catch { return []; } finally { await browser.close().catch(() => {}); }
}

function describe(s: Step): string {
  if ("selector" in s && s.selector) return `${s.action} ${s.selector}`;
  if (s.action === "navigate") return `navigate ${s.url}`;
  if (s.action === "scroll" && s.to) return `scroll to ${s.to}`;
  return s.action;
}
