/**
 * The boundary around the local window.
 *
 * `retake ui` is an HTTP server on loopback with no authentication of any
 * kind, and one of its routes hands a string to `/bin/sh -lc`. Loopback is
 * not a boundary: any page in any tab can POST to localhost. A simple request
 * with `content-type: text/plain` is not preflighted, so the browser will send
 * it and the same-origin policy only hides the *response* — the command has
 * already run by then. That is remote code execution on the machine, reachable
 * from any website the person happens to be reading.
 *
 * So: a random token per process, a `Host` that must be our own loopback
 * address and port, an `Origin` that must be us when it is sent at all, a
 * content type we chose, and a body small enough that nobody can push the
 * process over on memory.
 *
 * The token is written to a file only local processes can read. That is what
 * lets the MCP servers — separate processes, spawned by other agents, posting
 * progress into the window — keep working, while a page on the open web, which
 * can make requests but cannot read files, cannot.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Big enough that guessing is not a strategy. */
export const newToken = () => randomBytes(24).toString("base64url");

/** Where a local process can find the running window's token. */
export const tokenFile = (root: string) => path.join(root, ".drafts", "ui-token");

export function writeToken(root: string, token: string): void {
  const f = tokenFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, token, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* best effort on odd filesystems */ }
}

export function readToken(root: string): string | null {
  try { return fs.readFileSync(tokenFile(root), "utf8").trim() || null; } catch { return null; }
}

export function clearToken(root: string): void {
  try { fs.rmSync(tokenFile(root), { force: true }); } catch { /* going away anyway */ }
}

/** Constant-time, and never throws on a length mismatch. */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
const hostOnly = (h: string) => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]);

export type Refusal = { status: number; error: string };

/**
 * What a request has to satisfy before any route sees it.
 *
 * `write` is for anything that changes state or runs something — those also
 * need a matching content type, because the types a form can send without a
 * preflight are exactly the ones an attacking page would use.
 */
export function checkRequest(
  req: http.IncomingMessage,
  opts: { token: string; port: number; write: boolean; maxBody?: number },
): Refusal | null {
  const host = req.headers.host ?? "";
  const h = hostOnly(host);
  const port = host.includes(":") && !host.endsWith("]") ? host.slice(host.lastIndexOf(":") + 1) : "";
  if (!LOOPBACK.has(h)) return { status: 403, error: "this window only answers on loopback" };
  if (port && Number(port) !== opts.port) return { status: 403, error: "wrong port" };

  // Sent by browsers on any cross-site request. Absent for a local process
  // (an MCP server posting progress), which is why the token exists too.
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { const u = new URL(origin); ok = LOOPBACK.has(hostOnly(u.host)) && Number(u.port || 80) === opts.port; } catch { ok = false; }
    if (!ok) return { status: 403, error: "cross-site request refused" };
  }

  if (opts.write) {
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    // Empty is allowed: several routes take no body at all.
    if (type && type !== "application/json") return { status: 415, error: "send application/json" };
    const len = Number(req.headers["content-length"] ?? 0);
    if (len && len > (opts.maxBody ?? 0)) return { status: 413, error: "body too large" };
  }

  const sent = (req.headers["x-retake-token"] as string | undefined)
    ?? new URL(req.url ?? "/", "http://x").searchParams.get("t")   // EventSource cannot set headers
    ?? "";
  if (!sent || !sameToken(sent, opts.token)) return { status: 401, error: "this window needs its token — reload the page" };

  return null;
}

/** Read a body with a hard ceiling, so a request cannot exhaust memory. */
export function readBodyLimited(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((ok, no) => {
    let b = "", n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) { no(new Error("body too large")); req.destroy(); return; }
      b += c;
    });
    req.on("end", () => ok(b));
    req.on("error", no);
  });
}

/** The default ceiling. Poster uploads are the biggest real body. */
export const MAX_BODY = 12 * 1024 * 1024;

/** Only used to make the token file path predictable in tests. */
export const homeRoot = () => os.homedir();
