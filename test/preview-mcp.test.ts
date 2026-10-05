import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { entry } from "../src/paths.js";
import { Manifest } from "../src/manifest.js";
import { captureHash, type Take } from "../src/record.js";
import { notePreviewCapture, notePreviewRender } from "../src/preview.js";
import { ffmpegBin } from "../src/render.js";

async function workspace(withDraft = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-mcp-"));
  const demos = path.join(root, "demos");
  const outDir = path.join(root, "outputs", "x");
  fs.mkdirSync(demos, { recursive: true });
  const manifest = Manifest.parse({
    name: "x",
    url: "http://127.0.0.1:9",
    preset: "post-landscape",
    captions: false,
    steps: [
      { action: "scene", label: "start" },
      { action: "scene", label: "result" },
    ],
  });
  fs.writeFileSync(path.join(demos, "x.yaml"), JSON.stringify(manifest));

  if (withDraft) {
    fs.mkdirSync(outDir, { recursive: true });
    const video = path.join(outDir, "raw.mp4");
    execFileSync(ffmpegBin(), ["-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=1920x1080:r=24:d=6", "-pix_fmt", "yuv420p", video]);
    fs.copyFileSync(video, path.join(outDir, "demo.mp4"));
    const previewManifest = Manifest.parse({ ...manifest, preset: "preview-fast" });
    const take: Take = {
      captureHash: captureHash(previewManifest, demos),
      video,
      timeline: [
        { index: 1, action: "scene", label: "start", summary: "scene start", ok: true, start: 0, end: 3 },
        { index: 2, action: "scene", label: "result", summary: "scene result", ok: true, start: 3, end: 6 },
      ],
      duration: 6,
      trimBefore: 0,
      ok: true,
      screenshots: [],
      startedAt: "2026-09-18T08:00:00Z",
      finishedAt: "2026-09-18T08:00:01Z",
      captureSec: 1,
      quality: { preset: "preview-fast", width: 1920, height: 1080, scale: 2, fps: 24 },
    };
    fs.writeFileSync(path.join(outDir, "take.json"), JSON.stringify(take));
    notePreviewCapture(outDir, take, 1, "preview-fast");
    notePreviewRender(outDir, take, { preset: "preview-fast", seconds: 1, kind: "initial" });
  }

  const client = new Client({ name: "preview-test", version: "1.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const transport = new StdioClientTransport({
    ...entry("operator/tools"),
    cwd: root,
    env: { ...env, RETAKE_ROOT: root, RETAKE_OUT: path.join(root, "outputs"), RETAKE_UI: "", RETAKE_SESSION: "", RETAKE_PROJECT: "" },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { root, outDir, client, close: async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const resultText = (result: unknown) => JSON.stringify(result);

test("MCP run preview=false refuses before opening a browser", async () => {
  const w = await workspace(false);
  try {
    const result = await w.client.callTool({ name: "run", arguments: { name: "x", preview: false } });
    assert.match(resultText(result), /preview=false is disabled/i);
    assert.equal(fs.existsSync(path.join(w.outDir, "take.json")), false);
  } finally {
    await w.close();
  }
});

test("MCP receipts exposes the one-capture state and done refuses a draft", async () => {
  const w = await workspace(true);
  try {
    const receipts = await w.client.callTool({ name: "receipts", arguments: { name: "x" } });
    assert.match(resultText(receipts), /fast path: 1 capture.*1 renders.*not finalized/i);

    const done = await w.client.callTool({ name: "done", arguments: { summary: "draft", demo: "x" } });
    assert.match(resultText(done), /workflow has not been finalized/i);

    const implicitDone = await w.client.callTool({ name: "done", arguments: { summary: "draft" } });
    assert.match(resultText(implicitDone), /workflow has not been finalized/i);
  } finally {
    await w.close();
  }
});

test("MCP final render reuses the same raw take and closes the receipt", async () => {
  const w = await workspace(true);
  try {
    const takeBefore = JSON.parse(fs.readFileSync(path.join(w.outDir, "take.json"), "utf8")) as Take;
    assert.ok(takeBefore.video);
    const rawVideo = takeBefore.video;
    const rawBefore = fs.readFileSync(rawVideo);
    const result = await w.client.callTool({ name: "render", arguments: { name: "x", preset: "post-landscape", no_master: true } });
    assert.doesNotMatch(resultText(result), /failed|requires a current preview/i);
    assert.match(resultText(result), /final post-landscape/i);

    const takeAfter = JSON.parse(fs.readFileSync(path.join(w.outDir, "take.json"), "utf8")) as Take;
    assert.equal(takeAfter.finishedAt, takeBefore.finishedAt);
    assert.equal(takeAfter.video, rawVideo);
    assert.deepEqual(fs.readFileSync(rawVideo), rawBefore);
    const receipt = JSON.parse(fs.readFileSync(path.join(w.outDir, "preview.json"), "utf8")) as { captureCount: number; finalPreset?: string };
    assert.equal(receipt.captureCount, 1);
    assert.equal(receipt.finalPreset, "post-landscape");
  } finally {
    await w.close();
  }
});
