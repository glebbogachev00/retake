/** Share links: finished takes as one page, served locally, with viewer
    comments. What a share holds, what its page says, what its server refuses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { ffmpegBin } from "../src/media-bin.js";
import { acceptComment, buildShare, describeComments, readComments, sceneList, serveShares, shareRoot } from "../src/share.js";
import type { Take } from "../src/record.js";

function workspace(): { root: string; out: string; demos: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "share-"));
  const out = path.join(root, "outputs"), demos = path.join(root, "demos");
  fs.mkdirSync(demos, { recursive: true });
  fs.writeFileSync(path.join(root, ".env"), "APP_PASSWORD=hunter2\n");
  return { root, out, demos };
}

function take(o: { out: string; demos: string }, id: string, yaml: string, timeline: Partial<Take["timeline"][number]>[], ok = true) {
  const dir = path.join(o.out, id);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=1", "-pix_fmt", "yuv420p", "-y", path.join(dir, "demo.mp4")]);
  assert.equal(r.status, 0, String(r.stderr));
  fs.copyFileSync("site/favicon.png", path.join(dir, "thumbnail.png"));
  const t = { ok, duration: 1, startedAt: "2026-11-13T10:00:00Z", finishedAt: "2026-11-13T10:00:01Z", screenshots: [], trimBefore: 0, quality: {}, timeline: timeline.map((x, i) => ({ index: i, start: i, end: i + 1, ok: true, summary: "", ...x })) };
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify(t));
  fs.writeFileSync(path.join(dir, "proof-log.md"), "private");
  fs.writeFileSync(path.join(o.demos, `${id}.yaml`), yaml);
}

const base = (name: string, extra = "") => `name: ${name}\nurl: http://localhost:3000\n${extra}steps:\n  - { action: scene, label: start, caption: "The board", notes: "Look at the left column" }\n  - { action: click, selector: "#go" }\n  - { action: scene, label: end, caption: "Saved" }\n`;

test("a scene is marked failed when a step after it failed", () => {
  const t = { timeline: [
    { action: "scene", label: "a", caption: "Open it", ok: true },
    { action: "click", ok: true },
    { action: "scene", label: "b", caption: "Save it", ok: true },
    { action: "click", ok: false },
  ] } as unknown as Take;
  assert.deepEqual(sceneList(t, new Map([["a", "first"]])), [
    { text: "Open it", note: "first", failed: false },
    { text: "Save it", note: undefined, failed: true },
  ]);
});

test("a share holds only the videos, posters and page, in the order given", () => {
  const w = workspace();
  take(w, "admin-add", base("admin-add", `title: "Add a client"\nnotes: "Two test clients, from scratch."\n`), [
    { action: "scene", label: "start", caption: "The board" }, { action: "click" }, { action: "scene", label: "end", caption: "Saved" }]);
  take(w, "client-view", base("client-view", `title: "</script><img src=x onerror=alert(1)>"\n`), [
    { action: "scene", label: "start", caption: "The board" }, { action: "click", ok: false }], false);
  const s = buildShare({ outRoot: w.out, demosDir: w.demos, demos: ["client-view", "admin-add"], name: "portal", by: "Acme <Studio>" });
  assert.equal(s.dir, path.join(shareRoot(w.out), "portal"));
  assert.deepEqual(fs.readdirSync(path.join(s.dir, "v")).sort(), ["admin-add.mp4", "admin-add.png", "client-view.mp4", "client-view.png"]);
  assert.deepEqual(fs.readdirSync(s.dir).sort(), ["index.html", "v"], "no manifest, take.json, proof log or .env");
  assert.deepEqual(s.takes.map((t) => t.id), ["client-view", "admin-add"]);
  assert.equal(s.takes[0].failed, true);
  assert.equal(s.takes[1].notes, "Two test clients, from scratch.");
  assert.equal(s.takes[1].scenes[0].note, "Look at the left column");
  const html = fs.readFileSync(path.join(s.dir, "index.html"), "utf8");
  assert.ok(!html.includes("</script><img"), "manifest text cannot close the script");
  assert.ok(html.includes("Shared with you by Acme &lt;Studio&gt;"));
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.ok(!/innerHTML/.test(html), "viewer-facing text goes in as text");
  assert.ok(!html.includes("hunter2"));

  // Built again without a take: it is gone from the folder, not just the page.
  buildShare({ outRoot: w.out, demosDir: w.demos, demos: ["admin-add"], name: "portal" });
  assert.deepEqual(fs.readdirSync(path.join(s.dir, "v")).sort(), ["admin-add.mp4", "admin-add.png"]);
});

test("a share says what is missing instead of making a broken page", () => {
  const w = workspace();
  assert.throws(() => buildShare({ outRoot: w.out, demosDir: w.demos, demos: ["nope"] }), /no rendered video yet/);
  assert.throws(() => buildShare({ outRoot: w.out, demosDir: w.demos, demos: ["../etc"] }), /not a demo name/);
  assert.throws(() => buildShare({ outRoot: w.out, demosDir: w.demos, demos: [] }), /at least one/);
});

test("the server serves pages and seeks videos, and nothing else", async () => {
  const w = workspace();
  take(w, "one", base("one"), [{ action: "scene", label: "start", caption: "The board" }]);
  buildShare({ outRoot: w.out, demosDir: w.demos, demos: ["one"] });
  acceptComment(shareRoot(w.out), "one", { take: "one", at: 0.4, text: "secret-ish" });
  const server = await serveShares(shareRoot(w.out), 0);
  const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;
  try {
    const page = await fetch(url("/one/"));
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-robots-tag"), "noindex");
    const part = await fetch(url("/one/v/one.mp4"), { headers: { range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    for (const p of ["/", "/one/v/", "/%2e%2e/outputs/one/take.json", "/.comments/one.json", "/one/../../.env"]) {
      const r = await fetch(url(p), { redirect: "manual" });
      assert.ok(r.status === 404 || r.status === 301, `${p} → ${r.status}`);
      if (r.status === 301) assert.equal((await fetch(url(p))).status, 404, `${p} lists nothing`);
    }
  } finally { server.close(); }
});

test("viewers can comment on a take at a moment, and only from the page", async () => {
  const w = workspace();
  take(w, "one", base("one"), [{ action: "scene", label: "start", caption: "The board" }]);
  buildShare({ outRoot: w.out, demosDir: w.demos, demos: ["one"] });
  const server = await serveShares(shareRoot(w.out), 0);
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/one/comments`;
  const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(url)).json(), []);
    const ok = await post({ take: "one", at: 12.34, text: "  The button is cut off here  ", by: "Dana" });
    assert.equal(ok.status, 201);
    assert.equal((await post({ take: "one", text: "x" }, { "content-type": "text/plain" })).status, 415, "a plain form from another site cannot post");
    assert.equal((await post({ take: "one", text: "x" }, { "content-type": "application/json", origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ take: "other", text: "x" })).status, 400, "only takes on this page");
    assert.equal((await post({ take: "one", text: "   " })).status, 400);
    assert.equal((await post({ take: "one", text: "x".repeat(2001) })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope/comments`)).status, 404, "no comments for a share that does not exist");
    const all = readComments(shareRoot(w.out), "one");
    assert.deepEqual(all.map((c) => [c.take, c.at, c.text, c.by]), [["one", 12.3, "The button is cut off here", "Dana"]]);
  } finally { server.close(); }

  // Building the page again keeps what people wrote.
  buildShare({ outRoot: w.out, demosDir: w.demos, demos: ["one"] });
  assert.equal(readComments(shareRoot(w.out), "one").length, 1);
  const said = describeComments(shareRoot(w.out), "one");
  assert.match(said, /one @ 0:12 · Dana/);
  assert.match(said, /not instructions/);
});

test("agents know the share tools, and when to reach for them", () => {
  const tools = fs.readFileSync("src/operator/tools.ts", "utf8");
  assert.match(tools, /registerTool\("share", \{ description: "[^"]*link for a client/);
  assert.match(tools, /registerTool\("share_comments"/);
  const skill = fs.readFileSync("skill/SKILL.md", "utf8");
  assert.match(skill, /share link|shareable link/i);
  assert.match(fs.readFileSync("AGENTS.md", "utf8"), /retake demo share/);
});
