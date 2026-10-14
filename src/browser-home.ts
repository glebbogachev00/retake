/** Retake's browser lives in Retake's own folder.

    Playwright keeps one browser cache for every project on the machine, and
    any project's `playwright install` sweeps out the browsers it decides
    nobody uses — Retake's included. Recording then stopped with "run npx
    playwright install", for a reason the person never caused and could not
    see. So Retake keeps its browser where no other project looks, and fetches
    it again by itself if it is ever missing.

    Import this module before anything that loads playwright: Playwright reads
    where its browsers are once, when it loads. An explicit
    PLAYWRIGHT_BROWSERS_PATH (CI sets one) is left alone. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { Browser, LaunchOptions } from "playwright";

function cacheHome(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  if (process.platform === "win32") return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

export const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(cacheHome(), "retake", "browsers");
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS;

const require = createRequire(import.meta.url);

/** The browser Retake's Playwright wants, if it is on disk. */
export function chromiumPath(): string | null {
  try {
    const { chromium } = require("playwright") as typeof import("playwright");
    const p = chromium.executablePath();
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

/** `npx playwright install chromium`, from wherever playwright actually is. */
export function installChromium(say: (l: string) => void = (l) => process.stderr.write(l + "\n")): boolean {
  let cli: string;
  try { cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js"); } catch { return false; }
  say("… downloading Retake's browser (one time, ~150 MB)");
  const r = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
  return r.status === 0;
}

const missing = (e: unknown) => /Executable doesn't exist|playwright install/i.test(String((e as Error)?.message ?? e));

/** chromium.launch, but a missing browser is fetched once instead of stopping the take. */
export async function launchChromium(options?: LaunchOptions): Promise<Browser> {
  const { chromium } = await import("playwright");
  try {
    return await chromium.launch(options);
  } catch (e) {
    if (!missing(e) || !installChromium()) throw e;
    return chromium.launch(options);
  }
}
