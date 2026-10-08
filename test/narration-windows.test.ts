/** A paragraph of aligned narration runs to the next NARRATED scene. A scene
    with no caption is wordless and belongs to the paragraph before it; ending
    the paragraph there froze a 2-second home page for 5 seconds while a
    History scene, which needed no words of its own, waited. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionWindows, narrationWindows } from "../src/render.js";
import type { Take } from "../src/record.js";

const take = {
  trimBefore: 1,
  duration: 41,
  timeline: [
    { index: 0, action: "scene", label: "home", caption: "Reactor Zero.", start: 1, end: 1, ok: true, summary: "" },
    { index: 1, action: "scene", label: "history", start: 3, end: 3, ok: true, summary: "" },
    { index: 2, action: "scene", label: "guide", caption: "A guide.", start: 13, end: 13, ok: true, summary: "" },
    { index: 3, action: "scene", label: "rods", start: 25, end: 25, ok: true, summary: "" },
  ],
} as unknown as Take;

test("narration runs across wordless scenes to the next narrated one", () => {
  assert.deepEqual(narrationWindows(take).map((w) => [w.from, w.to]), [[0, 12], [12, 40]]);
});

test("a burned caption still ends with its own scene", () => {
  assert.deepEqual(captionWindows(take).map((w) => [w.from, w.to]), [[0, 2], [12, 24]]);
});
