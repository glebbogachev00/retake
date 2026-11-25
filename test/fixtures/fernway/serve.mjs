// Fernway: a made-up project tool, small enough to read in one go, for
// trying Watch's journeys against. A sign-in, three pages behind it, a public
// pricing page, two forms that change data, and a build that can be
// "deployed" again: its script and style files are named after a hash, and
// every page carries per-request noise (a nonce, a CSRF token, a timestamped
// URL) that must never look like a new version.
//
//   import { startFernway } from "./test/fixtures/fernway/serve.mjs";
//   const app = await startFernway({ port: 4561 });   // app.url
//   app.deploy({ label: "Create project" });          // a new build, one label changed
//   node test/fixtures/fernway/serve.mjs 4561         // or from a terminal
//
// The test account: ada@fernway.test / correct-horse.
import http from "node:http";
import crypto from "node:crypto";

export const ACCOUNT = { user: "ada@fernway.test", password: "correct-horse" };

export async function startFernway(o = {}) {
  const state = {
    build: o.build ?? "B7f3a9Lk",
    hashed: o.hashed ?? true,
    newProject: "New project",
    plan: "Team",
    projects: ["Website refresh", "Spring launch"],
    team: ["Ada Lovelace", "Grace Hopper"],
    sessions: new Set(),
  };
  const asset = (ext) => (state.hashed ? `/assets/app-${state.build}.${ext}` : `/assets/app.${ext}`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const signedIn = (req) => { const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie ?? ""); return !!m && state.sessions.has(m[1]); };

  const page = (req, title, body) => {
    const nonce = crypto.randomBytes(8).toString("hex");
    const inside = signedIn(req);
    const nav = inside
      ? `<a href="/projects">Projects</a><a href="/team">Team</a><a href="/pricing">Pricing</a><a href="/logout">Sign out</a>`
      : `<a href="/pricing">Pricing</a><a href="/login">Sign in</a>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Fernway</title>
<meta name="csrf-token" content="${crypto.randomBytes(12).toString("hex")}">
<link rel="stylesheet" href="${asset("css")}">
<link rel="stylesheet" href="/assets/fonts.css?t=${Date.now()}">
<script nonce="${nonce}">window.__rendered = ${Date.now()};</script>
<script type="module" src="${asset("js")}"></script>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1b1b19;background:#fafaf7}header{display:flex;gap:20px;align-items:center;padding:16px 28px;background:#efefe9}header b{margin-right:auto}header a{color:#1b1b19}main{max-width:760px;margin:0 auto;padding:28px}form{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}input{font:inherit;padding:8px 10px}button{font:inherit;padding:8px 14px}li{padding:4px 0}</style>
</head><body><header><b>Fernway</b><nav>${nav}</nav></header><main>${body}</main></body></html>`;
  };

  const send = (res, code, html, headers = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(html); };
  const readForm = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(new URLSearchParams(b))); });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p.startsWith("/assets/")) {
      res.writeHead(200, { "content-type": p.endsWith(".css") ? "text/css" : "text/javascript" });
      return res.end(p.endsWith(".css") ? "/* fernway */" : "// fernway");
    }
    if (p === "/") return send(res, 200, page(req, "Home", `<h1>Projects for small teams</h1><p>Fernway keeps a small team's projects in one place.</p>`));
    if (p === "/pricing") return send(res, 200, page(req, "Pricing", `<h1>Pricing</h1><ul><li>Solo — free</li><li>${esc(state.plan)} — $12 a seat</li></ul>`));
    if (p === "/login" && req.method === "GET") return send(res, 200, page(req, "Sign in", `<h1>Sign in</h1><form method="post" action="/login"><input type="email" name="email" placeholder="Email" required><input type="password" name="password" placeholder="Password" required><button type="submit">Sign in</button></form>`));
    if (p === "/login" && req.method === "POST") {
      const f = await readForm(req);
      if (f.get("email") !== ACCOUNT.user || f.get("password") !== ACCOUNT.password) return send(res, 401, page(req, "Sign in", `<h1>Sign in</h1><p>That did not match.</p><form method="post" action="/login"><input type="email" name="email" placeholder="Email"><input type="password" name="password" placeholder="Password"><button type="submit">Sign in</button></form>`));
      const sid = crypto.randomBytes(8).toString("hex");
      state.sessions.add(sid);
      res.writeHead(303, { location: "/projects", "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
      return res.end();
    }
    if (p === "/logout") { res.writeHead(303, { location: "/", "set-cookie": "sid=; Path=/; Max-Age=0" }); return res.end(); }
    if (!signedIn(req)) { res.writeHead(303, { location: "/login" }); return res.end(); }
    if (p === "/projects" && req.method === "POST") { const f = await readForm(req); const n = (f.get("name") ?? "").trim(); if (n) state.projects.push(n); res.writeHead(303, { location: "/projects" }); return res.end(); }
    if (p === "/projects") return send(res, 200, page(req, "Projects", `<h1>Projects</h1><ul>${state.projects.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><form method="post" action="/projects"><input name="name" placeholder="Project name" aria-label="Project name" required><button type="submit">${esc(state.newProject)}</button></form>`));
    if (p === "/team" && req.method === "POST") { const f = await readForm(req); const e = (f.get("email") ?? "").trim(); if (e) state.team.push(e); res.writeHead(303, { location: "/team" }); return res.end(); }
    if (p === "/team") return send(res, 200, page(req, "Team", `<h1>Team</h1><ul>${state.team.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><form method="post" action="/team"><input type="email" name="email" placeholder="Their email" aria-label="Their email" required><button type="submit">Invite teammate</button></form>`));
    send(res, 404, page(req, "Not found", `<h1>Not found</h1>`));
  });
  await new Promise((ok) => server.listen(o.port ?? 0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state,
    /** A new build: new file names, and optionally one label changed. */
    deploy(c = {}) {
      state.build = crypto.randomBytes(4).toString("hex") + "Z" + Date.now().toString(36).slice(-3);
      if (c.label) state.newProject = c.label;
      if (c.plan) state.plan = c.plan;
    },
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await startFernway({ port: Number(process.argv[2] ?? 4561) });
  process.stdout.write(`Fernway at ${app.url} — test account ${ACCOUNT.user} / ${ACCOUNT.password}\n`);
  // A deploy from a terminal: `kill -USR2 <pid>` changes the build and the button's label.
  process.on("SIGUSR2", () => { app.deploy({ label: app.state.newProject === "New project" ? "Create project" : "New project" }); process.stdout.write(`deployed ${app.state.build}\n`); });
}
