/** Signing in by hand: a real browser window, the person signs in — codes,
    SSO, captcha, anything — and Retake keeps the session it ends with.

    For the sites a saved login cannot do. The session is kept per site in
    the workspace (`.auth/<site>.json`, readable by this user only), so every
    demo of that site starts signed in from it. Nothing is recorded. */
import fs from "node:fs";
import path from "node:path";
import { launchChromium } from "./browser-home.js";
import { siteOf, siteSlug } from "./logins.js";

/** Where a site's hand-made session lives in a workspace. */
export const sessionPathFor = (root: string, url: string) => path.join(root, ".auth", `${siteSlug(siteOf(url))}.json`);

/** How old a saved session is, in hours — null when there is none. */
export function sessionAgeHours(file: string): number | null {
  try { return (Date.now() - fs.statSync(file).mtimeMs) / 3.6e6; } catch { return null; }
}

export interface HandSignIn {
  /** Keep the session the window is in now, and close it. */
  keep(): Promise<string>;
  close(): Promise<void>;
}

export async function openHandSignIn(url: string, statePath: string, viewport = { width: 1280, height: 800 }): Promise<HandSignIn> {
  const browser = await launchChromium({ headless: false });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  return {
    async keep() {
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        await context.storageState({ path: statePath });
        fs.chmodSync(statePath, 0o600);
        return statePath;
      } catch (e) {
        // Closing the window instead of pressing Done is the usual way here.
        const why = page.isClosed() ? "the browser window was closed before the session could be kept" : String((e as Error).message ?? e);
        throw new Error(`Could not keep the session — ${why}. Sign in again, and leave the window open until you press Done.`);
      } finally {
        await browser.close().catch(() => {});
      }
    },
    close: () => browser.close().catch(() => {}),
  };
}
