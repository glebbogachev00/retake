import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { entry } from "../src/paths.js";
import { ffmpegBin, probe } from "../src/render.js";

// Real stdio MCP, real ffmpeg; all footage is synthetic test-only media.
async function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-mcp-"));
  const root = path.join(dir, "workspace");
  fs.mkdirSync(path.join(root, "outputs", "first"), { recursive: true });
  const files = ["outputs/first/demo.mp4", "outputs/second.mp4"];
  for (const [i, file] of files.entries()) {
    execFileSync(ffmpegBin(), ["-v", "error", "-f", "lavfi", "-i", `color=c=${i ? "blue" : "red"}:s=160x90:r=20:d=1`,
      "-c:v", "libx264", path.join(root, file)]);
  }
  const client = new Client({ name: "stitch-test", version: "1.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const transport = new StdioClientTransport({ ...entry("operator/tools"), cwd: root, env: {
    ...env, RETAKE_ROOT: root, RETAKE_OUT: path.join(root, "outputs"), RETAKE_UI: "", RETAKE_SESSION: "", RETAKE_PROJECT: "",
  }, stderr: "pipe" });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  return { root, dir, files, client, close: async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("stitch MCP rejects escapes, symlink escapes, invalid joins and overwrites without side effects", async () => {
  const w = await workspace();
  try {
    const outside = path.join(w.dir, "workspace-sibling"); fs.mkdirSync(outside);
    const external = path.join(outside, "demo.mp4");
    fs.copyFileSync(path.join(w.root, w.files[0]), external);
    fs.symlinkSync(outside, path.join(w.root, "linked"), "dir");
    fs.mkdirSync(path.join(w.root, "indirect"));
    fs.symlinkSync(external, path.join(w.root, "indirect", "demo.mp4"));
    fs.symlinkSync(path.join(outside, "not-yet.mp4"), path.join(w.root, "dangling.mp4"));
    const before = fs.readFileSync(external);
    const cases = [
      { inputs: [external, w.files[1]] },
      { inputs: ["../workspace-sibling/demo.mp4", w.files[1]] },
      { out: path.join(outside, "escaped.mp4") },
      { out: "../workspace-sibling/escaped.mp4" },
      { inputs: ["linked/demo.mp4", w.files[1]] },
      { inputs: ["indirect", w.files[1]] },
      { out: "linked/new/nested.mp4" },
      { out: "dangling.mp4" },
      { out: w.files[0] },
      { inputs: [w.files[0]] },
      { transition: "not-a-transition" },
      { transition_ms: -1 },
      { out: "outputs/invalid.webm" },
    ];
    for (const changes of cases) {
      const args = { inputs: w.files, out: "outputs/should-not-exist.mp4", ...changes };
      const result = await w.client.callTool({ name: "stitch", arguments: args });
      assert.equal(result.isError, true, `must refuse ${JSON.stringify(changes)}: ${JSON.stringify(result)}`);
      assert.equal(fs.existsSync(path.join(w.root, "outputs/should-not-exist.mp4")), false);
    }
    assert.deepEqual(fs.readdirSync(outside), ["demo.mp4"], "nothing escaped into sibling workspace");
    assert.deepEqual(fs.readFileSync(external), before);
    assert.deepEqual(fs.readFileSync(path.join(w.root, w.files[0])), before, "existing input not overwritten");
    assert.equal(fs.readdirSync(path.join(w.root, "outputs")).some((f) => f.startsWith(".retake-stitch-")), false);
  } finally { await w.close(); }
});

test("stitch MCP advertises its contract and renders an ordered new MP4", async () => {
  const w = await workspace();
  try {
    const tool = (await w.client.listTools()).tools.find((tool) => tool.name === "stitch");
    assert.ok(tool, "stitch is available over real MCP tools/list");
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.readOnlyHint, false);
    const before = w.files.map((file) => fs.readFileSync(path.join(w.root, file)));
    const result = await w.client.callTool({ name: "stitch", arguments: {
      inputs: ["outputs/first", "outputs/second.mp4"], out: "outputs/joined/demo.mp4", transition: "fade", transition_ms: 200, audio: false,
    } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const output = path.join(w.root, "outputs/joined/demo.mp4");
    assert.match(JSON.stringify(result), /joined\/demo\.mp4/);
    assert.ok(fs.existsSync(output), "tool created the promised artifact");
    const p = probe(output);
    assert.deepEqual([p.width, p.height, p.fps], [160, 90, 20]);
    assert.ok(Math.abs(p.duration - 1.8) < 0.1, JSON.stringify(p));
    for (const [at, channel] of [[0.2, 0], [1.5, 2]]) {
      const bytes = execFileSync(ffmpegBin(), ["-v", "error", "-ss", String(at), "-i", output, "-vf", "scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
      assert.ok(bytes[channel] > 220, `source order at ${at}`);
    }
    execFileSync(ffmpegBin(), ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
    w.files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(w.root, file)), before[i]));
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ["demo.mp4"], "no library entry, manifest, or recording invented");
  } finally { await w.close(); }
});
