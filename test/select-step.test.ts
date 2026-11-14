/** A `select` step names an option the way the person reads it — its label —
    or by its value, and must take either straight away. The recorder asked for
    the value first and fell back to the label only after the whole step timeout,
    so every label froze the take for ~8s on camera and failed its idle check.
    The fix lived in a second `case "select"` of the same switch, which JS never
    reaches — so duplicate cases are guarded too. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { Manifest } from "../src/manifest.js";
import { runStep } from "../src/record.js";

const FORM = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "form.html"), "utf8");
const ctx = { outDir: "/tmp", manifestDir: "/tmp", downloads: [], stub: async () => {} };
const rec = { hover: async () => {} };

test("a select step takes an option by label or by value without waiting out the timeout", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const m = Manifest.parse({
      name: "select-step",
      url: "https://example.com",
      steps: [
        { action: "select", selector: "#plan", value: "Pro" },   // the label; its value is "pro"
        { action: "select", selector: "#plan", value: "team" },  // the value; its label is "Team"
      ],
    });
    for (const [step, want] of [[m.steps[0], "pro"], [m.steps[1], "team"]] as const) {
      const started = Date.now();
      await runStep(rec as never, page, step, m, ctx);
      const took = Date.now() - started;
      assert.equal(await page.locator("#plan").inputValue(), want);
      assert.ok(took < 2000, `chose "${want}" in ${took}ms — the step must not wait out its 8s timeout`);
    }
  } finally {
    await browser.close();
  }
});

test("an option that does not exist still fails the step", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const m = Manifest.parse({
      name: "select-missing",
      url: "https://example.com",
      steps: [{ action: "select", selector: "#plan", value: "Enterprise", timeout: 800 }],
    });
    await assert.rejects(runStep(rec as never, page, m.steps[0], m, ctx));
  } finally {
    await browser.close();
  }
});

test("runStep's switch has no case written twice — the second one never runs", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "record.ts"), "utf8");
  const at = src.indexOf("export async function runStep");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  const cases = [...body.matchAll(/^    case "([^"]+)":/gm)].map((c) => c[1]);
  const twice = cases.filter((c, i) => cases.indexOf(c) !== i);
  assert.deepEqual(twice, [], `runStep handles ${twice.join(", ")} twice; only the first is reachable`);
});
