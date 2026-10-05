import { test } from "node:test";
import assert from "node:assert/strict";
import { Manifest } from "../src/manifest.js";
import { assessActionProof, type ActionProofSnapshot } from "../src/action-proof.js";
import { runStep } from "../src/record.js";

function snap(overrides: Partial<ActionProofSnapshot> = {}): ActionProofSnapshot {
  return {
    found: true,
    visible: true,
    classTokens: [],
    attributes: {},
    text: "",
    checked: false,
    ...overrides,
  };
}

test("click proof is schema-valid and defaults to requiring a changed state", () => {
  const manifest = Manifest.parse({
    name: "proof",
    url: "https://example.com",
    steps: [{
      action: "click",
      selector: "#tab",
      proof: { selector: "#tab", state: "active" },
    }],
  });
  const click = manifest.steps[0];
  assert.equal(click.action, "click");
  if (click.action === "click") assert.equal(click.proof?.change, true);
});

test("cursor click emphasis is schema-valid", () => {
  const manifest = Manifest.parse({
    name: "cursor-emphasis",
    url: "https://example.com",
    cursor: { size: 36, rippleColor: "#2B77FF", rippleSize: 90 },
    steps: [{ action: "click", selector: "#target" }],
  });
  assert.deepEqual(manifest.cursor, {
    size: 36,
    rippleColor: "#2B77FF",
    rippleSize: 90,
  });
});

test("proof rejects a click whose target is already in the requested state", () => {
  const result = assessActionProof(
    { selector: "#hour", state: "active", change: true, timeout: 1500 },
    snap({ classTokens: ["interval", "active"] }),
    snap({ classTokens: ["interval", "active"] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /already satisfied before the action/i);
});

test("proof rejects a click that does not produce the requested state", () => {
  const result = assessActionProof(
    { selector: "#buy-only", state: "active", change: true, timeout: 1500 },
    snap({ classTokens: ["button"] }),
    snap({ classTokens: ["button"] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /not satisfied after the action/i);
});

test("proof accepts a visible active-state transition", () => {
  const result = assessActionProof(
    { selector: "#buy-only", state: "active", change: true, timeout: 1500 },
    snap({ classTokens: ["button"] }),
    snap({ classTokens: ["button", "active"] }),
  );
  assert.deepEqual(result, { ok: true, reason: "" });

  const appSpecific = assessActionProof(
    { selector: "#market", state: "active", change: true, timeout: 1500 },
    snap({ classTokens: ["mtb-base-p-item"] }),
    snap({ classTokens: ["mtb-base-p-item", "mtb-item-active"] }),
  );
  assert.deepEqual(appSpecific, { ok: true, reason: "" });
});

test("text and attribute proofs are explicit rather than inferred from live page noise", () => {
  const text = assessActionProof(
    { selector: "#status", state: "text", value: "Готово", change: true, timeout: 1500 },
    snap({ text: "Ожидание" }),
    snap({ text: "Готово" }),
  );
  assert.equal(text.ok, true);

  const attribute = assessActionProof(
    { selector: "#panel", state: "attribute", attribute: "data-state", value: "open", change: true, timeout: 1500 },
    snap({ attributes: { "data-state": "closed" } }),
    snap({ attributes: { "data-state": "open" } }),
  );
  assert.equal(attribute.ok, true);
});

test("selector-valued at clicks use the recorder cursor tracker", async () => {
  const calls: Array<[string, unknown]> = [];
  const rec = {
    hover: async (selector: string) => { calls.push(["hover", selector]); },
    click: async (selector: string) => { calls.push(["click", selector]); },
  };
  const page = {
    waitForTimeout: async () => {},
    mouse: {
      click: async () => { calls.push(["raw-page-click", null]); },
    },
  };
  const manifest = Manifest.parse({
    name: "cursor-proof",
    url: "https://example.com",
    steps: [{
      action: "click",
      at: "#target",
      via: ["#waypoint"],
    }],
  });

  await runStep(
    rec as never,
    page as never,
    manifest.steps[0],
    manifest,
    { outDir: "/tmp", manifestDir: "/tmp", downloads: [], stub: async () => {} },
  );

  assert.deepEqual(calls, [
    ["hover", "#waypoint"],
    ["click", "#target"],
  ]);
});
