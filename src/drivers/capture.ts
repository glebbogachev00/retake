/** Retake's camera in a Mac app: the capture helper (native/capture), which
    records one window and nothing else, at the display's backing scale, even
    when other windows cover it. cua-driver's own video records the whole
    display at 1×, which puts whatever is on top into the take. */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const helperPath = () => process.env.RETAKE_CAPTURE ?? path.join(PKG_ROOT, "native", "bin", "retake-capture");

export type CaptureCheck = { built: boolean; screenRecording?: boolean; macos?: string; error?: string };

export function checkCapture(): CaptureCheck {
  const bin = helperPath();
  if (!fs.existsSync(bin)) return { built: false };
  const r = spawnSync(bin, ["check"], { encoding: "utf8", timeout: 10_000 });
  try { return { built: true, ...(JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as object) }; }
  catch { return { built: true, error: (r.stderr || r.stdout || "no answer").trim().slice(0, 200) }; }
}

export type Recording = {
  /** Resolves with the epoch ms of the first frame written: the take's t=0. */
  started: Promise<{ at: number; width: number; height: number; scale: number }>;
  /** Stops and finalises the file. */
  stop(): Promise<string>;
};

export function recordWindow(windowId: number, out: string, fps = 30): Recording {
  const child = spawn(helperPath(), ["record", String(windowId), out, String(fps)], { stdio: ["pipe", "pipe", "pipe"] });
  const events: Record<string, unknown>[] = [];
  const waiters: ((e: Record<string, unknown>) => void)[] = [];
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const e = JSON.parse(line) as Record<string, unknown>; events.push(e); waiters.splice(0).forEach((w) => w(e)); } catch { /* not ours */ }
    }
  });
  const exited = new Promise<number | null>((r) => child.on("exit", r));
  const next = (kind: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const look = () => {
      const e = events.find((x) => x.event === kind || x.event === "error");
      if (e) return e.event === "error" ? reject(new Error(String(e.error))) : resolve(e);
      waiters.push(look);
    };
    look();
    exited.then(() => { const e = events.find((x) => x.event === kind); if (!e) reject(new Error(`the capture helper stopped before "${kind}"${events.length ? `: ${JSON.stringify(events.at(-1))}` : ""}`)); });
  });
  return {
    started: next("started") as Promise<{ at: number; width: number; height: number; scale: number }>,
    async stop() { child.stdin.end(); const e = await next("stopped"); return String(e.file); },
  };
}
