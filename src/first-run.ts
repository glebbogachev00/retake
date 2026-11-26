/**
 * The first run: `npx retake-demos https://your.app`, or `retake <address>`.
 *
 * Nothing to set up first. When this folder is not a Retake workspace, one is
 * made quietly at ~/Retake (the same place every time, so the second run finds
 * the first). The window opens at Watch's "Add an app" with the address filled
 * in, and the suggestion flow takes it from there: look around the app,
 * propose journeys, run the picked ones once. No YAML, no login to Retake.
 *
 * With no address (`npx retake-demos` alone) the window opens at "Add an app",
 * asking for one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

/** Where a workspace is made when the person is not standing in one. */
export const HOME_WORKSPACE = path.join(os.homedir(), "Retake");
export const WINDOW_PORT = 4310;

const FILE_LIKE = /\.(ya?ml|json|m?js|ts|md|mp4|mov|webm|png|jpe?g|gif|txt)$/i;

/** The address in what someone typed, or null when it is not one: a full URL,
    localhost with a port, or a bare domain (app.example.com/path). A command
    name, a flag or a file is never an address. */
export function asAddress(s: string | undefined): string | null {
  if (!s || s.startsWith("-") || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) { try { return new URL(s).toString(); } catch { return null; } }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/\S*)?$/i.test(s)) return new URL("http://" + s).toString();
  if (FILE_LIKE.test(s) || fs.existsSync(s)) return null;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s)) { try { return new URL("https://" + s).toString(); } catch { return null; } }
  return null;
}

/** A folder already holding Retake work: demos to record or journeys to watch. */
export const isWorkspace = (dir: string) => ["demos", "watch"].some((d) => fs.existsSync(path.join(dir, d)));

/** This folder when it is a workspace; otherwise ~/Retake. */
export const workspaceFor = (cwd: string, home = HOME_WORKSPACE) => (isWorkspace(cwd) ? cwd : home);

/** Started as `npx retake-demos`: npm says so. (`retake` alone prints the help.) */
export const viaNpx = (env: NodeJS.ProcessEnv = process.env) => env.npm_command === "exec";

/** Where the window opens. */
export const addAppPath = (address: string | null) => "/watch/add" + (address ? "?url=" + encodeURIComponent(address) : "");

/** Is a Retake window answering on this port? (It sends its version on /demos.) */
async function retakeWindowAt(port: number): Promise<"retake" | "other" | "free"> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/demos`, { method: "GET", signal: AbortSignal.timeout(1500) });
    return r.headers.get("x-retake-version") ? "retake" : "other";
  } catch {
    // Nothing answered over HTTP; something may still hold the port.
    return await new Promise((done) => {
      const s = net.createServer().once("error", () => done("other")).once("listening", () => s.close(() => done("free")));
      s.listen(port, "127.0.0.1");
    });
  }
}

function openBrowser(url: string): void {
  if (process.env.RETAKE_NO_OPEN === "1") return;
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref(); } catch { /* the address is printed anyway */ }
}

export type FirstRunDeps = {
  /** Makes a folder a workspace (demos/, outputs/, .env, .gitignore). Quiet. */
  init: (root: string) => void;
  /** How to start one of Retake's own commands as a child. */
  cli: { command: string; args: string[] };
  /** Chromium, downloaded once if it is not there. */
  browser: { present: () => boolean; install: (say: (l: string) => void) => boolean };
  say: (l: string) => void;
  /** The first port to try (4310 unless a test says otherwise). */
  port?: number;
};

/** Make (or find) the workspace, open the window at "Add an app", and keep it open. */
export async function firstRun(address: string | null, deps: FirstRunDeps, cwd = process.cwd(), home = HOME_WORKSPACE): Promise<void> {
  const root = workspaceFor(cwd, home);
  if (!isWorkspace(root)) {
    fs.mkdirSync(path.join(root, "watch"), { recursive: true });
    deps.init(root);
  }
  // Looking around an app needs a browser; better now, once, than as a silent
  // minute inside the window's first wait.
  if (!deps.browser.present()) {
    deps.say("Getting a browser ready. This happens once.");
    if (!deps.browser.install(() => {})) throw new Error("could not download Chromium — run `npx playwright install chromium`, then try again");
  }

  const first = deps.port ?? WINDOW_PORT;
  let port = first;
  for (; port < first + 10; port++) {
    const at = await retakeWindowAt(port);
    if (at === "retake") {   // a window is already open: use it
      const url = `http://localhost:${port}${addAppPath(address)}`;
      deps.say(`Retake is open at ${url}`);
      openBrowser(url);
      return;
    }
    if (at === "free") break;
  }

  const child = spawn(deps.cli.command, [...deps.cli.args, "ui", "--port", String(port)], {
    cwd: root, env: { ...process.env, RETAKE_ROOT: root }, stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 150 && (await retakeWindowAt(port)) !== "retake"; i++) {
    if (child.exitCode !== null) throw new Error("the window did not start");
    await new Promise((ok) => setTimeout(ok, 200));
  }
  const url = `http://localhost:${port}${addAppPath(address)}`;
  const shown = root.startsWith(os.homedir()) ? "~" + root.slice(os.homedir().length) : root;
  deps.say(`Retake is open at ${url}`);
  deps.say(`Your workspace is ${shown}. Ctrl-C closes the window.`);
  openBrowser(url);
  await new Promise<void>((done) => child.once("exit", () => done()));
}
