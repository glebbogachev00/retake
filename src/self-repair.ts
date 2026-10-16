/** What npm was supposed to do at install, done at start if it did not.

    Two of Retake's parts arrive by install script: the patch that lets the
    recorder draw the cursor right (scripts/patch-testreel.mjs, Retake's own
    postinstall) and ffmpeg itself (ffmpeg-static downloads its binary at
    install). npm has begun asking before it runs install scripts for global
    packages, so a person can end up with neither — and a recorder that drops
    the cursor, or a render that cannot start, for a reason they never saw.

    Import this before anything that loads testreel: the patch has to be on
    disk before the recorder is read. Both repairs are idempotent and cheap
    when nothing is missing (a file read, a stat). */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const say = (l: string) => process.stderr.write(l + "\n");

/** The marks the patch leaves. All present → patched. */
const MARKS = ["/*retake:flat-cursor-v2*/", "/*retake:coordinate-scale*/"];

export function recorderPatched(): boolean | null {
  try {
    const src = fs.readFileSync(path.join(path.dirname(require.resolve("testreel")), "index.js"), "utf8");
    return MARKS.every((m) => src.includes(m));
  } catch { return null; }
}

function patchRecorder(): void {
  if (recorderPatched() !== false) return;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "patch-testreel.mjs");
  if (!fs.existsSync(script)) return;
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  if (recorderPatched()) say("✓ applied Retake's recorder patch (npm skipped it at install)");
  else say(`· could not apply Retake's recorder patch — long demos may lose the cursor. ${r.stdout?.trim().split("\n").pop() ?? ""}`);
}

/** ffmpeg-static's binary, fetched now if its install script never ran.
    Returns its path, or null when there is no bundled copy to be had. */
export function bundledFfmpeg(): string | null {
  let bin: string | null = null;
  try { bin = require("ffmpeg-static") as string; } catch { return null; }
  if (!bin) return null;
  if (fs.existsSync(bin)) return bin;
  const installer = path.join(path.dirname(require.resolve("ffmpeg-static/package.json")), "install.js");
  if (!fs.existsSync(installer)) return null;
  say("… downloading ffmpeg (one time, ~45 MB — npm skipped it at install)");
  spawnSync(process.execPath, [installer], { cwd: path.dirname(installer), stdio: ["ignore", "ignore", "inherit"] });
  return fs.existsSync(bin) ? bin : null;
}

patchRecorder();
