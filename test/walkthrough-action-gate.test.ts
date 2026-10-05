import { test } from "node:test";
import assert from "node:assert/strict";
import { Manifest } from "../src/manifest.js";

const voiceover = { voice: "en-US-AvaMultilingualNeural", fragments: true, approved: true };

function base(steps: unknown[], interactionStyle?: "walkthrough" | "presentation") {
  return {
    name: "action-proof",
    title: "Action proof",
    url: "https://example.com",
    mode: "launch",
    voiceover,
    ...(interactionStyle ? { interactionStyle } : {}),
    steps,
  };
}

test("narrated walkthrough rejects static and hover-only instructional beats", () => {
  const parsed = Manifest.safeParse(base([
    { action: "scene", label: "intro", caption: "Откройте экран.", pauseAfter: 3000 },
    { action: "hover", at: "#panel" },
    { action: "scene", label: "panel", caption: "Выберите вкладку.", pauseAfter: 7000 },
  ]));

  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.message, /visible state-changing action/i);
});

test("narrated walkthrough accepts one visible action for every instructional beat", () => {
  const parsed = Manifest.safeParse(base([
    { action: "scene", label: "intro", caption: "Перед вами экран.", pauseAfter: 3000 },
    { action: "click", at: "#market" },
    { action: "scene", label: "market", caption: "Откройте рынок.", pauseAfter: 3500 },
    { action: "click", at: "#orders" },
    { action: "scene", label: "orders", caption: "Перейдите к ордерам.", pauseAfter: 3500 },
  ]));

  assert.equal(parsed.success, true);
});

test("a static narrated presentation must opt out explicitly", () => {
  const parsed = Manifest.safeParse(base([
    { action: "scene", label: "title", caption: "Короткое объявление.", pauseAfter: 5000 },
    { action: "hover", at: "#logo" },
    { action: "scene", label: "close", caption: "Финальный кадр.", pauseAfter: 5000 },
  ], "presentation"));

  assert.equal(parsed.success, true);
});

test("walkthrough opening orientation is short instead of a seven-second static scene", () => {
  const parsed = Manifest.safeParse(base([
    { action: "scene", label: "intro", caption: "Перед вами экран.", pauseAfter: 7000 },
    { action: "click", at: "#next" },
    { action: "scene", label: "next", caption: "Откройте следующий раздел." },
  ]));

  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.message, /opening orientation.*4000ms/i);
});
