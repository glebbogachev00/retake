/** Retake's hands in a Mac app: one persistent session with cua-driver.

    One session per take, never a `cua-driver call` per action: the driver
    keeps per-session state (the agent cursor, element tokens from the last
    snapshot), and a fresh process per action is seconds slower. The driver's
    permissions stay with its own app (com.trycua.driver); Retake never asks
    macOS for Accessibility itself.

    Loaded only by dynamic import (see test/ext-boundary.test.ts): deleting
    src/drivers/ leaves the web recorder intact. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The cua-driver release Retake was tested with. It ships several times a
    day, all pre-release, so a different one is said out loud, not assumed. */
export const CUA_TESTED = "0.28.2";

/** Where cua-driver is, or null. Its installer puts it in ~/.local/bin,
    which is not always on PATH for a process an agent starts. */
export function findCuaDriver(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.RETAKE_CUA_DRIVER) return fs.existsSync(env.RETAKE_CUA_DRIVER) ? env.RETAKE_CUA_DRIVER : null;
  for (const dir of [...(env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!dir) continue;
    const f = path.join(dir, "cua-driver");
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

export class CuaError extends Error {
  constructor(public tool: string, message: string) { super(`${tool}: ${message}`); }
}

export class CuaSession {
  private constructor(private client: Client) {}

  static async open(bin = findCuaDriver(), args: string[] = ["mcp"]): Promise<CuaSession> {
    if (!bin) throw new Error("cua-driver is not installed — `retake doctor` says how to set up Mac app recording");
    const client = new Client({ name: "retake", version: "1" });
    // Its update notice goes to stderr on every start; it is not ours to show.
    await client.connect(new StdioClientTransport({ command: bin, args, stderr: "ignore" }));
    return new CuaSession(client);
  }

  /** One tool call. Returns the structured result; a refusal becomes a
      CuaError carrying the driver's own words, which say what to do. */
  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.client.callTool({ name: tool, arguments: args });
    const text = ((r.content ?? []) as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new CuaError(tool, text.replace(new RegExp(`^${tool}: `), "").trim() || "failed");
    if (r.structuredContent) return r.structuredContent as T;
    try { return JSON.parse(text) as T; } catch { return { text } as T; }
  }

  async close(): Promise<void> { await this.client.close().catch(() => {}); }
}

/** A one-shot CLI call to cua-driver, for the doctor: no session needed. */
export function cuaCli(bin: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 15_000 });
  return { status: r.status, out: `${r.stdout ?? ""}` };
}
