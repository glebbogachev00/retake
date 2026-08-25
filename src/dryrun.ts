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
import { runFileOrCommandSeed, resolvePoint, dragPoints } from "./record.js";
import { chromium, type Page, type BrowserContext } from "playwright";
import { expandEnv, resolve, type Manifest, type Step, type Stub } from "./manifest.js";

export type DryResult = { ok: boolean; lines: string[]; failures: number };

export async function dryRun(m: Manifest, manifestDir: string, log: (l: string) => void, opts: { seed?: boolean; outRoot?: string } = {}): Promise<DryResult> {
  const q = resolve(m);
  const lines: string[] = [];
  let failures = 0;
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
  const context = await browser.newContext({
    viewport: q.viewport,
    colorScheme: m.colorScheme,
    ...(m.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
  });

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
    for (const s of [...(m.auth?.setup ?? []), ...m.setup]) await run(s, true);
    for (const [i, s] of m.steps.entries()) await run(s, false, i);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  async function run(step: Step, isSetup: boolean, index = -1) {
    const tag = isSetup ? "setup" : String(index).padStart(3, "0");
    const short = 8000; // long enough for a click that navigates, short enough to stay fast
    try {
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
        case "waitFor": await page.waitForSelector(step.selector, { state: step.gone ? "hidden" : "visible", timeout: Math.min(step.timeout ?? 15000, 15000) }); break;
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
  return { ok, lines, failures };
}

function describe(s: Step): string {
  if ("selector" in s && s.selector) return `${s.action} ${s.selector}`;
  if (s.action === "navigate") return `navigate ${s.url}`;
  if (s.action === "scroll" && s.to) return `scroll to ${s.to}`;
  return s.action;
}
