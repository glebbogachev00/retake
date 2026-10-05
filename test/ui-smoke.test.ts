/**
 * The window, actually loaded, actually clicked.
 *
 * `chat.html` is one long script block. In a single day it broke four separate
 * ways and every one reached a running window:
 *
 *   · `const st` redeclared in the same scope — a syntax error, blank page
 *   · `RUNNING` declared inside a block the library code could not see
 *   · `liveFromDisk` in a different scope from the ticker that reads it
 *   · `display = ''` to show an element the stylesheet sets to `display:none`
 *
 * Every one was found by a person opening the page and looking. None would
 * have been caught by a unit test, and all four would have been caught by
 * this: boot the real server, load the real page, click the things a person
 * clicks, and fail on any console error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";

const PORT = 4403;
let ui: ChildProcess, browser: Browser, token = "", OUT = "", ROOT = "";

/**
 * A finished recording, planted.
 *
 * This ran against whatever happened to be in the developer's own `outputs/`,
 * so on a machine with real takes it exercised the whole panel and on a fresh
 * checkout it clicked a demo that had never been recorded and asserted against
 * an empty string. It passed here and failed the first time CI could run it.
 */
function plant(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-root-"));
  const out = path.join(root, "outputs");
  const demos = path.join(root, "demos");
  const dir = path.join(out, "example");
  fs.mkdirSync(demos, { recursive: true });
  fs.mkdirSync(path.join(dir, "stills"), { recursive: true });
  fs.writeFileSync(path.join(demos, "example.yaml"), [
    "name: example",
    "title: Planted demo",
    "url: https://example.com",
    "steps:",
    "  - action: scene",
    "    label: a",
    "",
  ].join("\n"));
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=#edefe8:s=320x180:d=1", "-pix_fmt", "yuv420p", path.join(dir, "demo.mp4")], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=#edefe8:s=320x180:d=1", "-frames:v", "1", path.join(dir, "stills", "01-a-end.png")], { stdio: "ignore" });
  const video = path.join(dir, "demo.mp4");
  const finishedAt = new Date(1000).toISOString();
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({
    timeline: [{ index: 1, action: "scene", label: "a", summary: "scene a", ok: true, start: 0, end: 1 }],
    duration: 1, trimBefore: 0, startedAt: new Date(0).toISOString(), finishedAt,
    ok: true, video, captureHash: "planted", screenshots: ["stills/01-a-end.png"],
    quality: { preset: "post-landscape", width: 1920, height: 1080, scale: 2, fps: 30 },
  }));
  fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify({
    version: 2, takeFinishedAt: finishedAt, captureHash: "planted", rawVideo: video,
    previewPreset: "preview-fast", captureCount: 1, renderCount: 1, correctionsUsed: 0,
    renders: [{ kind: "initial", preset: "preview-fast", seconds: 1, finishedAt }],
    captureSec: 1, renderSec: 1, totalSec: 2, targetSec: 180, withinTarget: true,
    overTargetSec: 0, updatedAt: finishedAt,
  }));
  // So the review area has something to say. Its labels are the ones the
  // contrast test measures.
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify({
    verify: { at: new Date(2000).toISOString(), takeFinishedAt: new Date(1000).toISOString(), ok: true, count: 1, summary: "1 answered yes" },
    sweep: { at: new Date(2000).toISOString(), takeFinishedAt: new Date(1000).toISOString(), ok: null, count: 0, summary: "nothing on 1 frame" },
  }));
  return root;
}

test.before(async () => {
  ROOT = plant();
  OUT = path.join(ROOT, "outputs");
  ui = spawn(process.execPath, [path.resolve("dist/cli.js"), "ui", "--port", String(PORT)], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RETAKE_OPEN: "0", RETAKE_ROOT: ROOT, RETAKE_OUT: OUT },
  });
  // Wait for it to answer rather than sleeping a guessed number of seconds.
  const until = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error("the window never came up");
    await new Promise((r) => setTimeout(r, 300));
  }
  const { readFileSync } = await import("node:fs");
  token = readFileSync(path.join(ROOT, ".drafts", "ui-token"), "utf8").trim();
  browser = await chromium.launch();
});

test.after(async () => { await browser?.close(); ui?.kill(); if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true }); });

test("init leaves a new workspace empty so onboarding can start", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retake-init-"));
  try {
    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "init"], { cwd: root, stdio: "pipe" });
    assert.ok(fs.existsSync(path.join(root, "demos")));
    assert.deepEqual(fs.readdirSync(path.join(root, "demos")), [], "a starter demo would hide first-run onboarding");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the create flow uses the receipt-producing preview command", () => {
  const source = fs.readFileSync(path.resolve("src/ui/server.ts"), "utf8");
  assert.match(source, /"run", file, "--preview", "--out", outRoot\(\)/);
  assert.doesNotMatch(source, /"run", file, "--preset", "preview-fast"/);
});

/** Load the page and hand back everything the browser complained about. */
async function visit(width: number, run: (p: import("playwright").Page) => Promise<void>) {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + String(e)));
  p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  const failed: string[] = [];
  p.on("response", (r) => { if (r.url().includes(`:${PORT}/`) && r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await p.locator("#demos").waitFor({ state: "visible" });
  await p.waitForTimeout(1500);
  await run(p);
  await p.close();
  return { errs, failed };
}

test("the window loads and opens a demo without a single console error", async () => {
  const { errs, failed } = await visit(1440, async (p) => {
    for (const d of await p.locator("#demos details").all()) await d.evaluate((e) => ((e as HTMLDetailsElement).open = true));
    await p.waitForTimeout(400);
    const rows = p.locator("#demos .nm");
    assert.ok(await rows.count(), "the planted recording must be listed");
    {
      await rows.first().click({ force: true });
      await p.waitForTimeout(2000);
      // The parts most often broken by a scope mistake.
      assert.ok(await p.locator("#vidState").innerText(), "a take must state its own condition");
      assert.ok(await p.locator("#review").isVisible(), "the optional review area must render");
    }
  });
  assert.deepEqual(errs, []);
  assert.deepEqual(failed, []);
});

test("take API exposes fast-path state and render-only artifacts advance its stamp", async () => {
  const headers = { "x-retake-token": token };
  const before = await fetch(`http://127.0.0.1:${PORT}/api/take/example`, { headers }).then((r) => r.json()) as { preview: { captureCount: number; renderCount: number }; stamp: number };
  assert.equal(before.preview.captureCount, 1);
  assert.equal(before.preview.renderCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(OUT, "example", "facts.json"), JSON.stringify({ timings: { render: 1 } }));
  const after = await fetch(`http://127.0.0.1:${PORT}/api/take/example`, { headers }).then((r) => r.json()) as { stamp: number };
  assert.ok(after.stamp > before.stamp, "a render-only artifact must wake UI polling without touching take.json");
});

test("the guide is available in the window and copies a complete agent prompt", async () => {
  const { errs } = await visit(1440, async (p) => {
    await p.locator("#guideBtn").click();
    const guide = p.locator("[data-retake-guide]");
    await guide.waitFor({ state: "visible" });
    const text = await guide.innerText();
    assert.match(text, /Choose a recording type/i);
    assert.match(text, /Voice and pace/i);
    assert.match(text, /Music/i);
    assert.match(text, /Format/i);
    assert.match(text, /Audience and depth/i);
    assert.match(text, /assume no prior knowledge/i);
    assert.match(text, /split dense topics into short parts/i);
    assert.match(text, /Privacy and safety/i);
    assert.match(text, /One browser capture/i);
    assert.match(text, /Complete copy-paste template/i);
    const fullPrompt = await p.locator("#guideFullPrompt").innerText();
    assert.match(fullPrompt, /Safety stops:/i);
    assert.match(fullPrompt, /one viewer problem to solve/i);
    assert.match(fullPrompt, /Knowledge level:/i);
    assert.match(fullPrompt, /define each control or term when it first appears/i);
    assert.match(fullPrompt, /cursor moves toward its control/i);
    assert.match(fullPrompt, /show the result before the line ends/i);
    assert.match(fullPrompt, /Review the exact final MP4/i);
    await p.locator("#guideCopy").click();
    assert.match(await p.locator("#guideCopy").innerText(), /Copied/i);
    await p.keyboard.press("Escape");
    assert.equal(await p.locator("[data-retake-guide]").count(), 0, "Escape must close the guide");
  });
  assert.deepEqual(errs, []);
});

test("what's new opens, expands, and closes", async () => {
  const { errs } = await visit(1440, async (p) => {
    await p.locator("#newsBtn").click();
    await p.waitForTimeout(500);
    assert.equal(await p.locator(".rel").count(), 1, "it opens on the newest release only");
    const all = p.locator("#newsAll");
    if (await all.count()) { await all.click(); await p.waitForTimeout(300); assert.ok((await p.locator(".rel").count()) > 1); }
    await p.locator("#newsClose").click();
    await p.waitForTimeout(200);
    assert.equal(await p.locator(".veil").count(), 0, "closing must remove it");
    // And with the key. The Escape handler called a `shut()` that does not
    // exist in that scope — copied from a dialog that had one — so the key
    // threw and left the modal sitting there. The button was tested; the key
    // was not.
    await p.locator("#newsBtn").click();
    await p.waitForTimeout(400);
    assert.equal(await p.locator(".veil").count(), 1);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    assert.equal(await p.locator(".veil").count(), 0, "Escape must close it too");
  });
  assert.deepEqual(errs, []);
});

test("the small print in the review area is readable", async () => {
  // Every label here is 11.5-12.5px, which WCAG calls normal text and wants at
  // 4.5:1. They sat between 3.62 and 4.19 — the part of the window that says
  // what has and has not been checked was the hardest part of it to read.
  const { errs } = await visit(1440, async (p) => {
    // Passed as source, not a function: tsx compiles named inner functions
    // with a `__name` helper that does not exist inside the page, so an
    // ordinary arrow const here throws a ReferenceError in the browser.
    const worst = (await p.evaluate(`(() => {
      const lum = (c) => { const ch = (c.match(/\\d+/g) || []).slice(0,3).map((n) => { const x = Number(n)/255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); }); return 0.2126*ch[0] + 0.7152*ch[1] + 0.0722*ch[2]; };
      const bg = (el) => { let n = el; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(b)) return b; n = n.parentElement; } return 'rgb(255,255,255)'; };
      let low = 99;
      for (const sel of ['.rhead', '.rhint', '.checked', '.checked .why', '.checked .c']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const a = lum(getComputedStyle(el).color), b = lum(bg(el));
        low = Math.min(low, (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05));
      }
      return low;
    })()`)) as number;
    assert.ok(worst < 99, "the review area was not on screen, so nothing was measured");
    assert.ok(worst >= 4.5, `the quietest label measures ${worst.toFixed(2)}:1, under AA`);
  });
  assert.deepEqual(errs, []);
});

test("nothing scrolls sideways on a phone, and the pills keep their shape", async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  // A pill that wraps inside its own border is taller than one line of it.
  const h = await p.locator(".chip").first().evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(h <= 40, `a header pill wrapped inside itself (${Math.round(h)}px tall)`);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(errs, []);
  await p.close();
});

test("a first-time user can describe one demo and make an honest narration choice", async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs: string[] = [];
  const requested: string[] = [];
  const sent: { body: Record<string, unknown> | null; answer: Record<string, unknown> | null } = { body: null, answer: null };
  let answered = false;
  let demoExists = false;
  p.on("pageerror", (e) => errs.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  p.on("request", (r) => requested.push(r.url()));
  await p.route("**/api/demos", async (r) => r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(demoExists ? [{ name: "first-project", title: "First project", file: "demos/first-project.yaml" }] : []),
  }));
  await p.route("**/api/operator", async (r) => {
    sent.body = r.request().postDataJSON();
    demoExists = true;
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "onboarding-test", provider: "codex" }) });
  });
  await p.route("**/api/operator/onboarding-test/answer", async (r) => {
    sent.answer = r.request().postDataJSON();
    answered = true;
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await p.route("**/api/operator/onboarding-test/stream*", async (r) => {
    const event = answered
      ? `event: done\ndata: ${JSON.stringify({ code: 0, summary: "The first draft is ready.", demo: "first-project" })}\n\n`
      : `retry: 50\nevent: pending\ndata: ${JSON.stringify({ id: "q-login", kind: "question", text: "Which demo account should Retake use?", detail: "Sign in before recording." })}\n\n`;
    await r.fulfill({ status: 200, contentType: "text/event-stream", body: event });
  });
  await p.route("**/api/take/first-project", async (r) => r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ files: [] }),
  }));
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  assert.ok(await p.locator("#onboarding").isVisible(), "an empty library should open the first-run flow");
  assert.equal(await p.locator("[data-voice]").count(), 4, "silent, Edge, Aiden, and Kokoro should be visible choices");
  assert.match(await p.locator("[data-voice=aiden]").innerText(), /about 2 GB/i);
  assert.match(await p.locator("[data-voice=kokoro]").innerText(), /first Kokoro test/i);
  assert.match(await p.locator("[data-voice=edge]").innerText(), /online/i);
  assert.match(await p.locator("[data-voice=silent]").innerText(), /No voiceover/i);

  await p.locator("#onboard-url").fill("https://example.com");
  await p.locator("#onboard-next").click();
  await p.locator("#onboard-describe").fill("Show how a visitor creates their first project");
  await p.locator("#onboard-next").click();
  await p.locator("[data-voice=aiden]").click();
  assert.ok(await p.locator("#voice-demo").isVisible(), "the chosen voice should play on the Capture example before commitment");
  assert.match(await p.locator("#voice-demo-video").getAttribute("src") || "", /^\/voice-samples\/aiden\.mp4$/);
  assert.ok(await p.locator("#voice-consent").isVisible(), "a local model must explain its download before continuing");
  assert.equal(await p.locator("#onboard-next").isDisabled(), true, "Aiden cannot continue without explicit download consent");
  await p.locator("#voice-consent input").check();
  await p.locator("#onboard-next").click();
  assert.ok(await p.locator("#onboard-review").isVisible());
  assert.match(await p.locator("#onboard-review").innerText(), /first draft stays silent/i);

  await p.locator("#onboard-back").click();
  assert.ok(await p.locator("[data-voice=aiden]").evaluate((e) => e.classList.contains("selected")), "Back should preserve the choice");
  await p.locator("#onboard-next").click();
  await p.locator("#onboard-submit").click();
  assert.equal(sent.body?.url, "https://example.com");
  assert.equal(sent.body?.describe, "Show how a visitor creates their first project");
  assert.equal(sent.body?.narration, "aiden");
  assert.equal(requested.some((u) => /huggingface|model|download/i.test(u)), false, "selecting Aiden must not download anything");
  await p.locator(".ob-success").waitFor();
  assert.match(await p.locator("#onboarding").innerText(), /making the first draft/i);
  await p.locator("[data-operator-answer]").waitFor();
  assert.match(await p.locator("#onboarding").innerText(), /Which demo account/i, "a blocking operator question must be visible");
  await p.evaluate(() => (window as typeof window & { drawDemos: () => Promise<void> }).drawDemos());
  assert.ok(await p.locator("#onboarding").isVisible(), "creating the manifest must not hide an active onboarding session");
  assert.match(await p.locator("#onboarding").innerText(), /Which demo account/i, "a library refresh must preserve the active operator question");
  await p.locator("[data-operator-input]").fill("Use the public demo account");
  const answerResponse = p.waitForResponse((r) => r.url().includes("/api/operator/onboarding-test/answer"));
  await p.locator("[data-operator-answer]").click();
  await answerResponse;
  assert.equal(sent.answer?.id, "q-login");
  assert.equal(sent.answer?.answer, "Use the public demo account");
  await p.locator("[data-operator-done]").waitFor({ timeout: 5_000 });
  assert.match(await p.locator("#onboarding").innerText(), /first draft is ready/i, "operator completion must return to onboarding");
  await p.evaluate(() => (window as typeof window & { drawDemos: () => Promise<void> }).drawDemos());
  assert.match(await p.locator("#onboarding").innerText(), /first draft is ready/i, "a library refresh must preserve the operator result");
  await p.locator("[data-open-first]").click();
  await p.locator("#lib").waitFor({ state: "visible" });
  assert.ok(await p.locator("#lib").isVisible(), "the completion action should hand the user into the library");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(errs, []);
  await p.close();
});

test("a failed first draft retries without asking for the request again", async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.route("**/api/demos", async (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await p.route("**/api/operator", async (r) => r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "retry-test", provider: "codex" }),
  }));
  await p.route("**/api/operator/retry-test/stream*", async (r) => r.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: done\ndata: ${JSON.stringify({ code: 1, summary: "The app did not start." })}\n\n`,
  }));
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await p.locator("#onboard-url").fill("https://example.com");
  await p.locator("#onboard-next").click();
  await p.locator("#onboard-describe").fill("Show a visitor creating the first project");
  await p.locator("#onboard-next").click();
  await p.locator("#onboard-next").click();
  await p.locator("#onboard-submit").click();
  await p.locator("[data-operator-retry]").waitFor();
  await Promise.all([
    p.waitForNavigation({ waitUntil: "networkidle" }),
    p.locator("[data-operator-retry]").click(),
  ]);
  assert.ok(await p.locator("#onboard-review").isVisible(), "retry should return to the completed review, not step one");
  assert.match(await p.locator("#onboard-review").innerText(), /https:\/\/example\.com/);
  assert.match(await p.locator("#onboard-review").innerText(), /creating the first project/i);
  assert.deepEqual(errs, []);
  await p.close();
});

test("one bad video seek does not take the window down", async () => {
  // The crash that read as "Retake keeps disconnecting": a player asking for
  // bytes past the end of a video — a seek in a demo just re-recorded shorter
  // — made createReadStream throw AFTER the 206 head was sent. The catch-all
  // then tried to answer 500 on top of it, and that second writeHead was the
  // uncaught throw that killed the whole process. Twice in one evening.
  const bad = await fetch(`http://127.0.0.1:${PORT}/out/example/demo.mp4`, { headers: { range: "bytes=99999999-" } });
  assert.equal(bad.status, 416, "an unsatisfiable range is refused, not served");
  // The window must still be alive — this is the assertion that matters.
  const alive = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(alive.status, 200, "the server died answering a bad range");
  // And an ordinary seek still works.
  const good = await fetch(`http://127.0.0.1:${PORT}/out/example/demo.mp4`, { headers: { range: "bytes=0-99" } });
  assert.equal(good.status, 206);
  assert.equal((await good.arrayBuffer()).byteLength, 100);
});

test("the API still refuses what it should, on the real routes", async () => {
  const call = (h: Record<string, string>, body = "{}") =>
    fetch(`http://127.0.0.1:${PORT}/api/start`, { method: "POST", headers: h, body }).then((r) => r.status);
  assert.equal(await call({ "content-type": "application/json" }), 401, "no token");
  assert.equal(await call({ "content-type": "application/json", "x-retake-token": token, origin: "https://evil.example" }), 403, "hostile origin");
  assert.equal(await call({ "content-type": "text/plain", "x-retake-token": token }), 415, "unpreflighted type");
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/demos`)).status, 401, "guarded GET");
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/demos`, { headers: { "x-retake-token": token } })).status, 200);
});
