/* ─── a routine that runs itself ─────────────────────────────────────────────
   A routine with a plan and a north star needs nobody at the keyboard: the
   environment starts itself, every cut is judged, only a match is delivered.
   What was missing was the morning — someone still had to type
   `retake routine run`. A schedule is that one line, said once.

   One video per run by default: a schedule exists to keep a cadence (a post a
   day), not to empty the plan in one night, and one result is one thing to
   look at. The machine's own scheduler does the waking — launchd on a Mac,
   cron elsewhere — so nothing of Retake's has to stay running. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

export type Every = "daily" | "weekdays";
export type ScheduleSpec = { every: Every; at: string; count: number };
export type Installed = ScheduleSpec & { label: string; root: string; installedAt: string; mechanism: "launchd" | "cron" };

export function parseAt(at: string): { hour: number; minute: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at.trim());
  if (!m) throw new Error(`"${at}" is not a time — 24-hour HH:MM, e.g. 09:00`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** One schedule per workspace, named after it, so two workspaces never
    overwrite each other's. */
export function labelFor(root: string): string {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  const hash = crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 8);
  return `app.retake.routine.${slug}.${hash}`;
}

export function describeSchedule(s: ScheduleSpec): string {
  return `${s.every === "daily" ? "every day" : "every weekday"} at ${s.at}, ${s.count === 1 ? "one video" : `up to ${s.count} videos`}`;
}

const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plistXml(o: { label: string; program: string[]; root: string; spec: ScheduleSpec; log: string; env: Record<string, string> }): string {
  const { hour, minute } = parseAt(o.spec.at);
  const when = (weekday?: number) =>
    `<dict>${weekday !== undefined ? `<key>Weekday</key><integer>${weekday}</integer>` : ""}<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
  const interval = o.spec.every === "daily" ? when() : `<array>${[1, 2, 3, 4, 5].map((d) => when(d)).join("")}</array>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>${o.program.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(o.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(o.env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>StartCalendarInterval</key>
  ${interval}
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export function cronLine(o: { label: string; program: string[]; root: string; spec: ScheduleSpec; log: string; env: Record<string, string> }): string {
  const { hour, minute } = parseAt(o.spec.at);
  const days = o.spec.every === "daily" ? "*" : "1-5";
  const env = Object.entries(o.env).map(([k, v]) => `${k}=${shq(v)}`).join(" ");
  return `${minute} ${hour} * * ${days} cd ${shq(o.root)} && ${env} ${o.program.map(shq).join(" ")} >> ${shq(o.log)} 2>&1 # ${o.label}`;
}

function stateFile(root: string): string {
  return path.join(root, ".retake", "schedule.json");
}

export function readSchedule(root: string): Installed | null {
  try { return JSON.parse(fs.readFileSync(stateFile(root), "utf8")) as Installed; } catch { return null; }
}

const plistPath = (label: string) => path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);

export function installSchedule(root: string, spec: ScheduleSpec, program: string[]): Installed {
  parseAt(spec.at);
  if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 20) throw new Error("-n is how many videos per run, 1 to 20");
  const label = labelFor(root);
  const log = path.join(root, ".retake", "schedule.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // What the shell had when the schedule was made: the scheduler's own PATH
  // finds neither node nor ffmpeg.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir() };
  const o = { label, program, root, spec, log, env };
  let mechanism: Installed["mechanism"];
  if (process.platform === "darwin") {
    removeSchedule(root);
    const file = plistPath(label);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plistXml(o));
    const uid = String(process.getuid?.() ?? "");
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, file], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`launchctl would not load the schedule: ${(r.stderr || r.stdout).trim()}`);
    mechanism = "launchd";
  } else if (process.platform === "linux") {
    removeSchedule(root);
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    const lines = (current.status === 0 ? current.stdout : "").split("\n").filter((l) => l.trim());
    lines.push(cronLine(o));
    const w = spawnSync("crontab", ["-"], { input: lines.join("\n") + "\n", encoding: "utf8" });
    if (w.status !== 0) throw new Error(`crontab would not take the schedule: ${(w.stderr || "").trim()}`);
    mechanism = "cron";
  } else {
    throw new Error("scheduling uses launchd (macOS) or cron (Linux) — on this system, run `retake routine run` from the system's own task scheduler");
  }
  const installed: Installed = { ...spec, label, root, installedAt: new Date().toISOString(), mechanism };
  fs.writeFileSync(stateFile(root), JSON.stringify(installed, null, 2));
  return installed;
}

export function removeSchedule(root: string): boolean {
  const label = labelFor(root);
  let removed = false;
  if (process.platform === "darwin") {
    const uid = String(process.getuid?.() ?? "");
    const r = spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
    if (r.status === 0) removed = true;
    const file = plistPath(label);
    if (fs.existsSync(file)) { fs.rmSync(file); removed = true; }
  } else if (process.platform === "linux") {
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    if (current.status === 0 && current.stdout.includes(`# ${label}`)) {
      const kept = current.stdout.split("\n").filter((l) => l.trim() && !l.endsWith(`# ${label}`));
      spawnSync("crontab", ["-"], { input: kept.join("\n") + (kept.length ? "\n" : ""), encoding: "utf8" });
      removed = true;
    }
  }
  if (fs.existsSync(stateFile(root))) { fs.rmSync(stateFile(root)); removed = true; }
  return removed;
}

/** Is the machine's scheduler actually holding it? The state file is what we
    wrote; this is what is true. */
export function scheduleLoaded(label: string): boolean {
  try {
    if (process.platform === "darwin") {
      execFileSync("launchctl", ["print", `gui/${process.getuid?.()}/${label}`], { stdio: "ignore" });
      return true;
    }
    if (process.platform === "linux") return execFileSync("crontab", ["-l"], { encoding: "utf8" }).includes(`# ${label}`);
  } catch { /* not loaded */ }
  return false;
}

/** Tell the person how the run went, where they will see it. Best effort: a
    notification that cannot be shown is not a failed run. */
export function notify(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      spawnSync("osascript", ["-e", `display notification ${q(body)} with title ${q(title)}`], { stdio: "ignore", timeout: 5000 });
    } else if (process.platform === "linux") {
      spawnSync("notify-send", [title, body], { stdio: "ignore", timeout: 5000 });
    }
  } catch { /* best effort */ }
}
