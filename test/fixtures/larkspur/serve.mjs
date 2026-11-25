/**
 * Larkspur, a made-up room-booking app, served for Watch mode's examples
 * (scripts/watch-docs-shots.mjs). Every route is the same page; app.js draws
 * it from the address. No requests leave the machine.
 *
 *   node test/fixtures/larkspur/serve.mjs [port]     → http://larkspur.localhost:<port>
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8" };

export function serveLarkspur(port = 0) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = p === "/app.css" || p === "/app.js" ? p.slice(1) : "index.html";
    res.writeHead(200, { "content-type": TYPES[path.extname(file)], "cache-control": "no-store" });
    res.end(fs.readFileSync(path.join(HERE, file)));
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, url: `http://larkspur.localhost:${server.address().port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serveLarkspur(Number(process.argv[2] || 4471));
  process.stdout.write(`Larkspur → ${url}\n`);
}
