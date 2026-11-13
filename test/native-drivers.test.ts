/** App demos, sprint 2: Retake's hands (a cua-driver session), its camera
    (the window recorder) and the doctor's checklist. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CuaError, CuaSession } from "../src/drivers/cua.js";
import { describeNative, nativeDoctor, type Probes } from "../src/drivers/native-doctor.js";

test("a session calls tools and turns a refusal into the driver's own words", async () => {
  const s = await CuaSession.open(process.execPath, [path.resolve("test/fixtures/fake-cua-driver.mjs")]);
  try {
    const w = await s.call<{ windows: { window_id: number }[] }>("list_windows");
    assert.equal(w.windows[0].window_id, 7078);
    assert.deepEqual(await s.call("type_text", { pid: 4242, element_token: "s1:1", text: "hi" }), { effect: "confirmed" });
    await assert.rejects(() => s.call("type_text", { pid: 4242, text: "hi" }), (e: Error) => e instanceof CuaError && /^type_text: Background input refused/.test(e.message) && !/type_text: type_text/.test(e.message));
  } finally { await s.close(); }
});

const ready: Probes = {
  platform: "darwin",
  macos: () => "26.5.1",
  cuaBin: () => "/fake/cua-driver",
  cua: (_b, a) => {
    const k = a.join(" ");
    if (k === "--version") return { status: 0, out: "cua-driver 0.28.2" };
    if (k === "status") return { status: 0, out: "Cua Driver daemon is running" };
    if (k.startsWith("permissions")) return { status: 0, out: JSON.stringify({ accessibility: true, screen_recording: true }) };
    if (k.startsWith("telemetry")) return { status: 0, out: JSON.stringify({ enabled: false }) };
    return { status: 1, out: "" };
  },
  capture: () => ({ built: true, screenRecording: true, macos: "26.5.1" }),
};
const fixes = (p: Probes) => nativeDoctor(p).lines.filter((l) => l.ok === false).map((l) => l.fix ?? l.text);

test("ready means every item is ok", () => {
  const r = nativeDoctor(ready);
  assert.equal(r.ready, true);
  assert.equal(r.lines.length, 6);
  assert.match(describeNative(r).join("\n"), /^Mac apps — ready/);
});

test("each missing piece names the one thing that fixes it", () => {
  assert.deepEqual(fixes({ ...ready, cuaBin: () => null }), [`/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`]);
  assert.deepEqual(fixes({ ...ready, cua: (b, a) => a[0] === "status" ? { status: 1, out: "Cua Driver daemon is not running" } : ready.cua(b, a) }), ["open -n -g -a CuaDriver --args serve"]);
  assert.deepEqual(fixes({ ...ready, cua: (b, a) => a[0] === "permissions" ? { status: 0, out: JSON.stringify({ accessibility: true, screen_recording: false }) } : ready.cua(b, a) }), ["cua-driver permissions grant"]);
  assert.deepEqual(fixes({ ...ready, cua: (b, a) => a[0] === "telemetry" ? { status: 0, out: JSON.stringify({ enabled: true }) } : ready.cua(b, a) }), ["cua-driver telemetry disable"]);
  assert.match(fixes({ ...ready, capture: () => ({ built: false }) })[0], /^retake build-native/);
  assert.match(fixes({ ...ready, capture: () => ({ built: true, screenRecording: false }) })[0], /Screen & System Audio Recording/);
  assert.match(fixes({ ...ready, macos: () => "14.6" })[0], /Software Update/);
  const other = nativeDoctor({ ...ready, cua: (b, a) => a[0] === "--version" ? { status: 0, out: "cua-driver 0.49.1" } : ready.cua(b, a) });
  assert.equal(other.ready, true, "another version is a warning, not a failure");
  assert.match(other.lines[1].text, /tested with 0\.28\.2/);
  assert.equal(nativeDoctor({ ...ready, platform: "linux" }).ready, false);
});

test("the native code is reached only by dynamic import", () => {
  const offenders: string[] = [];
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []);
  for (const f of walk("src")) {
    if (f.includes(`${path.sep}drivers${path.sep}`)) continue;
    for (const m of fs.readFileSync(f, "utf8").matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]*drivers\/[^"]*)"/gm)) offenders.push(`${f} → ${m[1]}`);
  }
  assert.deepEqual(offenders, [], "a static import makes the web recorder depend on the Mac one");
});

// A real window, recorded behind whatever is on screen. Off by default: it
// opens TextEdit on the machine running the tests.
const smoke = process.env.RETAKE_NATIVE_SMOKE === "1" && nativeDoctor().ready;
test("a real TextEdit window is recorded alone, at Retina size, while it is typed into", { skip: smoke ? false : "set RETAKE_NATIVE_SMOKE=1 on a Mac where `retake doctor --native` is ready" }, async () => {
  const { recordWindow } = await import("../src/drivers/capture.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-smoke-"));
  const doc = path.join(dir, "retake-smoke.txt");
  fs.writeFileSync(doc, "");
  const s = await CuaSession.open();
  try {
    await s.call("launch_app", { bundle_id: "com.apple.TextEdit", urls: [doc] });
    let w: { pid: number; window_id: number } | undefined;
    for (let i = 0; i < 40 && !w; i++) { w = (await s.call<{ windows: { title: string; pid: number; window_id: number }[] }>("list_windows")).windows.find((x) => x.title === "retake-smoke.txt"); if (!w) await new Promise((r) => setTimeout(r, 250)); }
    assert.ok(w, "TextEdit opened the document");
    for (let i = 0; ; i++) { try { await s.call("set_window_frame", { pid: w.pid, window_id: w.window_id, x: 120, y: 120, width: 960, height: 540 }); break; } catch (e) { if (i > 20) throw e; await new Promise((r) => setTimeout(r, 250)); } }
    const rec = recordWindow(w.window_id, path.join(dir, "take.mp4"));
    const start = await rec.started;
    assert.deepEqual([start.width, start.height, start.scale], [1920, 1080, 2]);
    const st = await s.call<{ elements: { role: string; element_token: string }[] }>("get_window_state", { pid: w.pid, window_id: w.window_id });
    const area = st.elements.find((e) => /TextArea/.test(e.role));
    assert.ok(area, "the text area is in the accessibility tree");
    await s.call("type_text", { pid: w.pid, window_id: w.window_id, element_token: area.element_token, text: "Recorded by Retake." });
    await new Promise((r) => setTimeout(r, 1500));
    const file = await rec.stop();
    const probe = spawnSync(execFileSync(process.execPath, ["-e", "process.stdout.write(require('ffmpeg-static'))"], { encoding: "utf8" }), ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
    assert.match(probe, /1920x1080/);
  } finally {
    await s.close();
    spawnSync("osascript", ["-e", 'tell application "TextEdit" to close (every document whose name is "retake-smoke.txt") saving no']);
  }
});
