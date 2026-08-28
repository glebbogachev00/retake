/** The boundary around the local window, tested over real HTTP.
    `retake ui` had no authentication of any kind and one route handed a
    caller-supplied string to `/bin/sh -lc`. Loopback is not a boundary: a
    text/plain POST is not preflighted, so any page in any tab could have run
    anything on the machine. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MAX_BODY, checkRequest, newToken, readBodyLimited } from "../src/ui/guard.js";

const TOKEN = newToken();
const PORT = 4399;

/** A tiny server with the same guard, so these are HTTP facts and not
    assertions about source text. */
const server = http.createServer(async (req, res) => {
  const no = checkRequest(req, { token: TOKEN, port: PORT, write: req.method !== "GET", maxBody: 1024 });
  if (no) { res.writeHead(no.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: no.error })); }
  try { await readBodyLimited(req, 1024); } catch { res.writeHead(413); return res.end("{}"); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
});

test.before(() => new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok)));
test.after(() => new Promise<void>((ok) => { server.close(() => ok()); }));

const call = (o: { method?: string; headers?: Record<string, string>; body?: string; path?: string }) =>
  new Promise<number>((ok) => {
    // agent:false — otherwise keep-alive sockets from earlier probes queue
    // these behind each other and a refusal looks like a hang.
    const req = http.request({ host: "127.0.0.1", port: PORT, path: o.path ?? "/api/start", method: o.method ?? "POST", headers: { connection: "close", ...o.headers }, agent: false }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
    req.on("error", () => ok(0));
    req.end(o.body);
  });

const json = { "content-type": "application/json" };
const good = { ...json, "x-retake-token": TOKEN };

test("a request with the token is allowed", async () => {
  assert.equal(await call({ headers: good, body: "{}" }), 200);
});

test("no token is refused", async () => {
  assert.equal(await call({ headers: json, body: "{}" }), 401);
});

test("a wrong token is refused, whatever its length", async () => {
  assert.equal(await call({ headers: { ...json, "x-retake-token": "nope" }, body: "{}" }), 401);
  assert.equal(await call({ headers: { ...json, "x-retake-token": TOKEN + "x" }, body: "{}" }), 401);
});

test("a cross-site origin is refused even holding the token", async () => {
  // The case that matters: a page that somehow learned the token still must
  // not be able to drive this from another site.
  assert.equal(await call({ headers: { ...good, origin: "https://evil.example" }, body: "{}" }), 403);
});

test("our own origin is fine", async () => {
  assert.equal(await call({ headers: { ...good, origin: `http://localhost:${PORT}` }, body: "{}" }), 200);
});

test("a non-loopback Host is refused", async () => {
  assert.equal(await call({ headers: { ...good, host: "retake.example.com" }, body: "{}" }), 403);
});

test("text/plain is refused — that is the type that dodges a preflight", async () => {
  assert.equal(await call({ headers: { "content-type": "text/plain", "x-retake-token": TOKEN }, body: "{}" }), 415);
});

test("an oversized body is refused before it is read", async () => {
  assert.equal(await call({ headers: { ...good, "content-length": String(9_000_000) }, body: "{}" }), 413);
});

test("GET is guarded too — reading the workspace is not public either", async () => {
  assert.equal(await call({ method: "GET", path: "/api/demos" }), 401);
  assert.equal(await call({ method: "GET", path: "/api/demos", headers: { "x-retake-token": TOKEN } }), 200);
});

test("EventSource can pass the token in the query, since it cannot set headers", async () => {
  assert.equal(await call({ method: "GET", path: `/api/activity/stream?t=${TOKEN}` }), 200);
  assert.equal(await call({ method: "GET", path: "/api/activity/stream?t=nope" }), 401);
});

test("the body reader stops at its ceiling rather than growing", async () => {
  const req = { headers: {}, on(ev: string, fn: (c?: unknown) => void) { if (ev === "data") fn(Buffer.alloc(2048)); return this; }, destroy() {} } as unknown as http.IncomingMessage;
  await assert.rejects(() => readBodyLimited(req, 1024));
});

test("the default ceiling is big enough for a poster and small enough to matter", () => {
  assert.ok(MAX_BODY >= 4 * 1024 * 1024 && MAX_BODY <= 32 * 1024 * 1024);
});
