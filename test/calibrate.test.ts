/**
 * The harness that measures the checks.
 *
 * Every test here comes from a real finding, and they are all the same
 * finding: a calibration run that measures nothing must never read like one
 * that measured something. Recorded against an app that was not running, it
 * printed "FALSE POSITIVES none on the control" and exited 0. A seed whose
 * proof could never be true was counted as one of eight for two releases. A
 * `--only` typo produced a clean report about no defects at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { DEFECTS, planCalibration, report, uncovered, usable, type Result } from "../src/ext/calibrate.js";
import { LOOK_FOR } from "../src/ext/sweep.js";
import type { Manifest } from "../src/manifest.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cal-"));
const demo = { name: "d", url: "http://localhost:1", steps: [{ action: "scene", label: "a" }] } as unknown as Manifest;
const ok = { ok: true, timeline: [{}] };

/** A run with frames on disk, as record + render would leave it. */
function shot(dir: string) {
  fs.mkdirSync(path.join(dir, "stills"), { recursive: true });
  fs.writeFileSync(path.join(dir, "stills", "01-a-end.png"), "x");
  return dir;
}

test("a recording that did not happen cannot measure anything", () => {
  const d = shot(tmp());
  assert.equal(usable(d, null).ok, false);
  assert.equal(usable(d, { ok: true, timeline: [] }).ok, false);
  assert.equal(usable(d, { ok: false, timeline: [{}] }).ok, false);
  assert.equal(usable(tmp(), ok).ok, false, "no frames is not a measurement");
  assert.equal(usable(d, ok).ok, true);
});

test("an unusable control refuses to claim a false-positive rate", () => {
  // This is the whole bug. The control came back empty because nothing had
  // happened in it, and empty read as clean.
  const rs: Result[] = [
    { variant: "control", defect: null, kinds: [], found: false, seeded: false, why: "the run did not finish cleanly", other: 0 },
    { variant: "clipped-text", defect: DEFECTS[0], kinds: [], found: false, seeded: false, why: "the run did not finish cleanly", other: 0 },
  ];
  const out = report(rs).join("\n");
  assert.doesNotMatch(out, /none on the control/);
  assert.match(out, /FALSE POSITIVES {3}NOT MEASURED/);
  assert.match(out, /neither can the recall above/);
});

test("a good control still reports its rate", () => {
  const out = report([{ variant: "control", defect: null, kinds: [], found: false, seeded: true, other: 0 }]).join("\n");
  assert.match(out, /FALSE POSITIVES {3}none on the control/);
});

test("stability is measured or said to be unmeasured — never promised", () => {
  const one: Result[] = [{ variant: "control", defect: null, kinds: [], found: false, seeded: true, other: 0 }];
  assert.match(report(one, null).join("\n"), /STABILITY {3}not measured this run/);
  assert.match(report(one, { first: ["OVERLAP"], again: ["OVERLAP"] }).join("\n"), /same answer twice/);
  const drift = report(one, { first: ["OVERLAP"], again: [] }).join("\n");
  assert.match(drift, /DIFFERENT answers/);
  assert.match(drift, /one opinion, not a reading/);
});

test("the checklist items nothing seeds are named, not left to arithmetic", () => {
  const gaps = uncovered();
  assert.ok(gaps.length > 0, "eight seeds, ten items");
  assert.ok(gaps.every((g) => LOOK_FOR.some((l) => l.startsWith(g))));
  assert.match(report([]).join("\n"), new RegExp(gaps[0]));
});

test("a defect name that does not exist is an error, not an empty run", () => {
  assert.throws(() => planCalibration(demo, tmp(), { only: ["clipped-text", "typo"] }), /no such defect: typo/);
});

test("every seeded variant proves itself at the END of the run too", () => {
  // The setup proof says the seed was there before the camera rolled. A
  // single-page app can drop it halfway through, and every frame after that
  // asks the check to find something that is not there.
  const { variants } = planCalibration(demo, tmp());
  for (const v of variants.filter((x) => x.defect)) {
    const last = v.manifest.steps[v.manifest.steps.length - 1] as { action: string; script?: string };
    assert.equal(last.action, "evaluate", `${v.name} does not re-prove its seed`);
    assert.match(last.script!, /was gone by the end of the run/);
  }
  const control = variants.find((v) => !v.defect)!;
  assert.equal((control.manifest.steps.at(-1) as { action: string }).action, "scene", "the control is seeded with nothing");
});

test("every seed's proof is true in a real browser once its seed has run", async (t) => {
  // The contrast seed's proof built a regex for a literal backslash, so it
  // could never be true — and calibration reported that seed as "did not
  // land" on every app it was ever run against, for two releases. Nothing
  // caught it because nothing ever executed a proof outside a recording.
  const browser = await chromium.launch().catch(() => null);
  if (!browser) return t.skip("no browser");
  const page = await browser.newPage();
  // Ordinary prose at an ordinary width. Deliberately long: `runs-off-the-edge`
  // pushes the content sideways, and on a page whose text is short enough to
  // still fit afterwards that seed correctly reports it did not land.
  await page.setContent(`<!doctype html><html><body style="margin:0;font:16px system-ui">
    <h1>A heading long enough that pushing it sideways runs it off the edge</h1>
    <p>A paragraph of ordinary text, long enough to be worth looking at and long enough that it cannot quietly fit inside a frame it has been shoved most of the way across.</p>
    <ul><li>An item in a list, with enough words in it to have some width</li><li>Another item in that same list, similarly unhurried</li></ul>
  </body></html>`);
  try {
    for (const d of DEFECTS) {
      await page.evaluate(([css, js]) => {
        document.querySelectorAll("#retake-seed-css,[data-retake-dup],#retake-seed-spinner,#retake-seed-img,#retake-seed-badge").forEach((n) => n.remove());
        document.documentElement.removeAttribute("style");
        if (css) { const s = document.createElement("style"); s.id = "retake-seed-css"; s.textContent = css; document.head.appendChild(s); }
        if (js) (0, eval)(js);
      }, [d.css, d.js ?? ""]);
      const held = await page.evaluate((p) => { try { return !!eval(p); } catch (e) { return `threw: ${(e as Error).message}`; } }, d.proof);
      assert.equal(held, true, `the ${d.name} seed did not prove itself: ${held}`);
    }
  } finally { await browser.close(); }
});
