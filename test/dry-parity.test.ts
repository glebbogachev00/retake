/**
 * `dry` exists to make a take unnecessary. It only does that if it prepares
 * the page exactly the way the recorder does — every knob only one of them
 * applied was a way for dry to prove a different app than run would film, and
 * three lost takes in the field report were exactly that.
 *
 * So page preparation lives in ONE place (applyPageSetup / authState /
 * gateOnApp) and these guard the rule at the source level: a knob added to the
 * recorder inline, instead of to the shared function, fails here rather than
 * six weeks later in someone's 16-minute take.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", f), "utf8");
/** Strip the shared helpers themselves, leaving the code meant to delegate to
    them — otherwise the definitions count as their own violations. */
const withoutShared = (s: string) => {
  for (const name of ["applyPageSetup", "gateOnApp", "authState"]) {
    const at = s.search(new RegExp(`export (async )?function ${name}\\b`));
    if (at < 0) continue;
    const end = s.indexOf("\nexport ", s.indexOf("{", at));
    s = s.slice(0, at) + s.slice(end < 0 ? s.length : end);
  }
  return s;
};

test("init scripts are injected only through applyPageSetup", () => {
  for (const f of ["record.ts", "dryrun.ts"]) {
    const stray = withoutShared(src(f)).match(/addInitScript\(/g) ?? [];
    assert.equal(stray.length, 0, `${f} injects an init script of its own — put it in applyPageSetup so \`dry\` gets it too`);
  }
});

test("both the recorder and dry call the shared page setup", () => {
  for (const f of ["record.ts", "dryrun.ts"]) {
    assert.match(src(f), /applyPageSetup\(context, m, q\)/, `${f} does not call applyPageSetup`);
  }
});

test("both start from the same saved session", () => {
  for (const f of ["record.ts", "dryrun.ts"]) {
    assert.match(src(f), /authState\(m, [\w.]+\)/, `${f} decides auth freshness on its own instead of via authState`);
    assert.match(src(f), /storageState:/, `${f} never loads the saved session`);
  }
});

test("both wait on the manifest's readiness gate", () => {
  for (const f of ["record.ts", "dryrun.ts"]) {
    assert.match(src(f), /gateOnApp\(page, m,/, `${f} does not use the shared wrong-app gate`);
  }
  // And neither re-implements it.
  const stray = withoutShared(src("record.ts")).match(/waitForSelector\(m\.waitForSelector/g) ?? [];
  assert.equal(stray.length, 0, "the readiness gate is duplicated outside gateOnApp");
});

test("dry runs evaluate seeds, which it used to skip entirely", () => {
  const s = src("dryrun.ts");
  assert.match(s, /runEvaluateSeed\(/, "dry skips `evaluate` seeds — it will check a different app state than run");
  assert.doesNotMatch(s, /filter\(\(s\) => s\.kind !== "evaluate"\)[\s\S]{0,80}for \(const s of \w+\) await runEvaluateSeed/, "evaluate seeds must not be filtered out before being run");
});
