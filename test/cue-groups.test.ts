/** Captions follow the voice, sentence by sentence; each paragraph owns the
    spoken cues its words account for, so a caption never shows a line from
    the next paragraph early. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cueGroups } from "../src/voice.js";

test("each paragraph gets exactly its own spoken sentences", () => {
  const paragraphs = ["This is Reactor Zero. It starts with a story.", "Then a guide."];
  const cues = [
    { start: 0, end: 1.4, text: "This is Reactor Zero." },
    { start: 1.5, end: 3.0, text: "It starts with a story." },
    { start: 3.6, end: 4.5, text: "Then a guide." },
  ];
  const g = cueGroups(paragraphs, cues);
  assert.deepEqual(g.map((x) => x.map((c) => c.text)), [["This is Reactor Zero.", "It starts with a story."], ["Then a guide."]]);
});
