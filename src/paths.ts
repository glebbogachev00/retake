/**
 * Where things are. Two roots, kept apart on purpose:
 *
 *   PKG_ROOT      the installed Retake package — its skill, landing page,
 *                 assets, example manifest, and the code itself
 *   PROJECT_ROOT  the workspace Retake works in — demos/, outputs/, .env,
 *                 .auth/, the UI's drafts and trash
 *
 * From a clone the two are the same folder. From `npm install -g retake-demos`
 * they never are, and every path that used to hang off process.cwd() has to
 * pick a side.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // src/ (tsx) or dist/ (built)

/** True when running the TypeScript source through tsx rather than dist/. */
export const FROM_SOURCE = /\.ts$/.test(fileURLToPath(import.meta.url));

export const PKG_ROOT = path.resolve(HERE, "..");

export const PROJECT_ROOT = path.resolve((process.env.RETAKE_ROOT || process.cwd()).replace(/^~/, os.homedir()));

export const VERSION: string = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "dev"; } catch { return "dev"; }
})();

/** How to spawn one of Retake's own entry points as a child process — the
    same way whether we are the source tree or the built package. */
export function entry(name: "cli" | "operator/tools"): { command: string; args: string[] } {
  const file = path.join(HERE, `${name}.${FROM_SOURCE ? "ts" : "js"}`);
  if (!FROM_SOURCE) return { command: process.execPath, args: [file] };
  const require = createRequire(import.meta.url);
  return { command: process.execPath, args: [require.resolve("tsx/cli"), file] };
}
