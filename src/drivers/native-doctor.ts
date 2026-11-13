/** What recording a Mac app needs, item by item: each line is ok, or says the
    one thing that fixes it. The same list drives `retake doctor`, the
    window's setup card and the agent's question, so all three say the same.
    Retake never runs an installer or grants a permission itself: it says
    exactly what to run or where to click, and checks again. */
import os from "node:os";
import { spawnSync } from "node:child_process";
import { CUA_TESTED, cuaCli, findCuaDriver } from "./cua.js";
import { checkCapture, type CaptureCheck } from "./capture.js";

export type NativeLine = { ok: boolean | "warn"; text: string; fix?: string };
export type Probes = {
  platform: NodeJS.Platform;
  macos: () => string | null;
  cuaBin: () => string | null;
  cua: (bin: string, args: string[]) => { status: number | null; out: string };
  capture: () => CaptureCheck;
};

export const CUA_INSTALL = `/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`;

export const realProbes = (): Probes => ({
  platform: process.platform,
  macos: () => spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout?.trim() || null,
  cuaBin: () => findCuaDriver(),
  cua: cuaCli,
  capture: checkCapture,
});

const json = (s: string): Record<string, unknown> | null => { try { return JSON.parse(s.slice(s.indexOf("{"))) as Record<string, unknown>; } catch { return null; } };

export function nativeDoctor(p: Probes = realProbes()): { ready: boolean; lines: NativeLine[] } {
  const lines: NativeLine[] = [];
  const done = () => ({ ready: lines.every((l) => l.ok !== false), lines });
  if (p.platform !== "darwin") {
    lines.push({ ok: false, text: `recording Mac apps needs a Mac (this is ${os.type()})` });
    return done();
  }
  const ver = p.macos();
  const major = Number(ver?.split(".")[0] ?? 0);
  lines.push(major >= 15 ? { ok: true, text: `macOS ${ver}` } : { ok: false, text: `macOS ${ver ?? "unknown"} — recording one app window needs macOS 15 or newer`, fix: "update macOS in System Settings → General → Software Update" });

  const bin = p.cuaBin();
  if (!bin) {
    lines.push({ ok: false, text: "cua-driver isn't installed (it is how Retake clicks and types in an app)", fix: CUA_INSTALL });
  } else {
    const v = /(\d+\.\d+\.\d+)/.exec(p.cua(bin, ["--version"]).out)?.[1] ?? "unknown";
    lines.push(v === CUA_TESTED ? { ok: true, text: `cua-driver ${v}` } : { ok: "warn", text: `cua-driver ${v} — Retake was tested with ${CUA_TESTED}; if something misbehaves, that is the first thing to suspect` });
    const running = p.cua(bin, ["status"]);
    if (running.status !== 0 || !/is running/i.test(running.out)) {
      lines.push({ ok: false, text: "cua-driver's background service isn't running", fix: "open -n -g -a CuaDriver --args serve" });
    } else {
      lines.push({ ok: true, text: "cua-driver's background service is running" });
      const perm = json(p.cua(bin, ["permissions", "status", "--json"]).out);
      const missing = [perm?.accessibility === true ? null : "Accessibility", perm?.screen_recording === true ? null : "Screen Recording"].filter(Boolean);
      lines.push(missing.length ? { ok: false, text: `cua-driver needs ${missing.join(" and ")} (macOS will ask you to approve)`, fix: "cua-driver permissions grant" } : { ok: true, text: "cua-driver has Accessibility and Screen Recording" });
    }
    const tel = json(p.cua(bin, ["telemetry", "status", "--json"]).out);
    lines.push(tel?.enabled === false
      ? { ok: true, text: "cua-driver telemetry is off" }
      : { ok: false, text: "cua-driver telemetry is on — Retake will not record an app while it is, so nothing about your screens leaves this Mac", fix: "cua-driver telemetry disable" });
  }

  const cap = p.capture();
  if (!cap.built) lines.push({ ok: false, text: "Retake's window recorder isn't built yet", fix: "retake build-native   (needs Xcode's command-line tools: xcode-select --install)" });
  else if (cap.error) lines.push({ ok: false, text: `Retake's window recorder doesn't start: ${cap.error}` });
  else if (!cap.screenRecording) lines.push({ ok: false, text: "Retake's window recorder needs Screen Recording", fix: "System Settings → Privacy & Security → Screen & System Audio Recording → turn on the app that runs Retake, then restart it" });
  else lines.push({ ok: true, text: "Retake's window recorder can record a window" });
  return done();
}

export function describeNative(r: { ready: boolean; lines: NativeLine[] }): string[] {
  return [
    `Mac apps — ${r.ready ? "ready" : "not ready yet"}`,
    ...r.lines.map((l) => `  ${l.ok === true ? "✓" : l.ok === "warn" ? "·" : "✗"} ${l.text}${l.fix ? `\n      fix: ${l.fix}` : ""}`),
  ];
}

/** Refuse to start until every setup item is in place, and say which are not. */
export function requireReady(): void {
  const r = nativeDoctor();
  if (!r.ready) throw new Error(["Recording Mac apps is not set up on this Mac yet:", ...describeNative(r).slice(1)].join("\n"));
}
