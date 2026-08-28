/**
 * How much should anybody trust what `sweep` says?
 *
 * Every other check in Retake is tested: the seam, the guard, the parity, the
 * refusals. The one thing nothing measures is whether the model-based checks
 * are RIGHT — and that is the part the product is now sold on. Today `sweep`
 * found three real bugs, produced at least one clear false positive, and
 * missed a genuine overlap three passes running. Three anecdotes are not a
 * number.
 *
 * Retake can measure this with what it already has. `evaluate` injects
 * anything into the page before the camera rolls, so a defect can be seeded
 * deterministically: one variant of a working demo per known fault, recorded
 * for real, plus a clean control. Then:
 *
 *   recall          how many seeded defects were found
 *   false positives what was reported on the control, where nothing is wrong
 *   stability       whether the same frame gives the same answer twice
 *
 * WHERE THIS WORKS, AND WHERE IT DOES NOT.
 *
 * On a page that is served and then left alone — a document, a landing page,
 * Retake's own guide — injection is reliable and the numbers mean something:
 * eight of eight seeded faults found, nothing reported on the control.
 *
 * On a live single-page app it is not. Against Capture, seeds provably present
 * in the DOM after hydration were provably absent from every recorded frame,
 * four different ways of injecting them, for reasons not isolated. A harness
 * built on injection therefore measures the injection as much as the check,
 * and a low recall on such an app is not evidence about the check at all.
 *
 * So: use this to calibrate against static pages, and take the control result
 * — findings where nothing is wrong — from anywhere, because that half needs
 * no injection and is the half that matters most for trust. To calibrate a
 * real app, label real recordings and have a person adjudicate them. That is
 * slower, and it is the only thing that answers the question honestly.
 *
 * Two honest limits, stated rather than buried. The person writing the seeds
 * is not blind to the checklist, so recall here is an upper bound — a defect
 * nobody thought to seed is still not measured. And CSS-injected faults are
 * cleaner than the ones real apps produce; a laboratory number, not a field
 * one. Both are worth having, neither is the whole answer.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { createHash } from "node:crypto";
import type { Manifest } from "../manifest.js";

/** One seeded fault: what it does to the page, and what should catch it. */
export type Defect = {
  name: string;
  /** The sweep checklist item that ought to find this. */
  expect: string;
  /** What a person would see, so a report can be read without the CSS. */
  looks: string;
  /** Injected before the first scene. */
  css: string;
  /** For faults CSS cannot make plainly enough. Runs in the page, once. */
  js?: string;
  /**
   * Run in the page after the seed, and must return true.
   *
   * Comparing a variant's frames to the control's cannot tell whether a seed
   * landed on an app whose content changes between runs — Capture's board has
   * timestamps and counts, so every variant differed from the control whether
   * or not anything was injected, and eight seeds "landed" when at least one
   * plainly had not. A seed that proves itself in the page needs no
   * comparison and works on any app.
   */
  proof: string;
};

/**
 * Deliberately mechanical. Every one of these is visible to a person in one
 * glance, which is the bar: if a human cannot see it in the frame, a miss is
 * not evidence of anything.
 *
 * And every one targets ORDINARY TEXT — p, li, headings — rather than a
 * specific element. Three seeds failed here before that rule existed: they
 * changed parts of the page the demo's frames never showed, so the run
 * reported a miss when nothing had been asked of the check. A calibration
 * harness that can silently measure nothing is worse than none, because its
 * number looks the same either way.
 */
export const DEFECTS: Defect[] = [
  {
    name: "clipped-text",
    proof: "[...document.querySelectorAll('p,li,h1,h2,h3')].some(e => e.scrollHeight > e.clientHeight + 4)",
    expect: "CLIPPED",
    looks: "headings cut off mid-letter by a box too short for them",
    css: "h1,h2,h3,li,p{max-height:14px!important;overflow:hidden!important;display:block!important}",
  },
  {
    name: "overlapping-text",
    proof: "[...document.querySelectorAll('p,li')].some(e => parseFloat(getComputedStyle(e).marginBottom) < -10)",
    expect: "OVERLAP",
    looks: "paragraphs sitting on top of each other",
    css: "p,li{margin-bottom:-26px!important;position:relative!important;z-index:2!important}",
  },
  {
    name: "unreadable-contrast",
    proof: "getComputedStyle(document.body).color.replace(/\\\\s/g,'') === 'rgb(233,235,228)'",
    expect: "CONTRAST",
    looks: "body text almost the same colour as the page behind it",
    css: "body,p,li,span{color:#e9ebe4!important}",
  },
  {
    name: "runs-off-the-edge",
    proof: 'document.documentElement.scrollWidth > document.documentElement.clientWidth + 40',
    expect: "CUT OFF",
    looks: "content pushed off the right-hand side of the frame",
    css: "main,body>*{margin-left:62%!important;white-space:nowrap!important}",
  },
  {
    name: "doubled-heading",
    proof: "!!document.querySelector('[data-retake-dup]')",
    expect: "DOUBLED",
    looks: "every heading rendered twice, one under the other",
    // The first version targeted h2 and used attr(data-x), which is empty —
    // so nothing appeared and the run looked like a MISS. A seed that fails
    // silently is indistinguishable from a check that failed, which is why
    // `landed` below exists.
    // Twice wrong before this: CSS pseudo-content on headings, which produced
    // nothing the first time and nothing IN FRAME the second. A seed that is
    // not plainly visible in the frames being judged measures nothing, and the
    // temptation to keep tuning it until the number improves is exactly how a
    // calibration harness starts lying. So it clones the real node instead.
    css: "",
    js: "for (const h of [...document.querySelectorAll('h1,h2,h3,p,li')]) { if (h.textContent && h.textContent.trim().length > 8) { const c = h.cloneNode(true); c.setAttribute('data-retake-dup',''); h.after(c); } }",
  },
  {
    name: "stuck-spinner",
    proof: "!!document.getElementById('retake-seed-spinner')",
    expect: "UNFINISHED",
    looks: "a loading spinner sitting on the page that never resolves",
    css: "",
    js: "const d=document.createElement('div');d.id='retake-seed-spinner';d.textContent='Loading…';d.style.cssText='position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#fff;border:1px solid #ccc;border-radius:999px;padding:6px 16px;font:14px sans-serif;z-index:2147483647';document.body.appendChild(d);",
  },
  {
    name: "broken-image",
    proof: "!!document.getElementById('retake-seed-img')",
    expect: "BROKEN MEDIA",
    looks: "an image that failed to load, showing its alt text instead",
    css: "",
    js: "const i=document.createElement('img');i.id='retake-seed-img';i.src='/definitely-not-here-'+'x'.repeat(4)+'.png';i.alt='product photograph';i.style.cssText='position:fixed;top:90px;left:24px;width:150px;height:100px;border:1px solid #ccc;background:#fff;z-index:2147483647';document.body.appendChild(i);",
  },
  {
    name: "debug-badge",
    proof: "!!document.getElementById('retake-seed-badge')",
    expect: "NOT FOR THE CAMERA",
    looks: "a development badge left in the corner of the screen",
    css: "",
    js: "const b=document.createElement('div');b.id='retake-seed-badge';b.textContent='DEV BUILD · staging';b.style.cssText='position:fixed;bottom:12px;left:12px;background:#111;color:#0f0;font:12px monospace;padding:5px 10px;border-radius:5px;z-index:2147483647';document.body.appendChild(b);",
  },
];

export type Variant = { name: string; defect: Defect | null; file: string; manifest: Manifest };

/** Where calibration writes. Never near a real take. */
export const lab = (outRoot: string, demo: string) => path.join(outRoot, ".calibrate", demo);

/**
 * A control and one variant per defect, as ordinary manifests.
 *
 * The control matters more than any single variant: without a run where
 * nothing is wrong, a low false-positive rate cannot be claimed at all.
 */
export function planCalibration(m: Manifest, outRoot: string, opts: { only?: string[] } = {}): { root: string; variants: Variant[] } {
  const root = lab(outRoot, m.name);
  fs.mkdirSync(root, { recursive: true });
  const want = opts.only?.length ? DEFECTS.filter((d) => opts.only!.includes(d.name)) : DEFECTS;
  const variants: Variant[] = [];

  const write = (name: string, defect: Defect | null): Variant => {
    const clone = JSON.parse(JSON.stringify(m)) as Manifest;
    clone.name = `${m.name}-${name}`.slice(0, 60);
    if (defect) {
      // Before anything is recorded, so every frame carries the fault.
      clone.setup = [
        ...(clone.setup ?? []),
        // A stylesheet in <head> survives re-render; the elements below may not.
        ...(defect.css ? [{ action: "evaluate", script: `{const s=document.createElement('style');s.id='retake-seed-css';s.textContent=${JSON.stringify(defect.css)};document.head.appendChild(s);setInterval(()=>{if(!document.getElementById('retake-seed-css'))document.head.appendChild(s);},250);}` }] : []),
        // Re-applied on a timer, because a React app hydrates and re-renders
        // after the seed runs and takes anything appended to the body with it.
        // Capture did exactly that: the element passed its own proof at seed
        // time and was gone from every recorded frame, which looked identical
        // to the check missing it.
        ...(defect.js ? [{ action: "evaluate", script: `{ const seed = () => { try { ${defect.js} } catch {} }; seed(); setInterval(() => { if (!(${defect.proof})) seed(); }, 250); }` }] : []),
        // The seed proves itself, in the page, before anything is recorded.
        // A seed that did not render must fail the take rather than produce
        // frames that look exactly like a check missing something.
        { action: "wait", ms: 1200 },
        // Checked after the app has had time to hydrate and re-render, not at
        // the instant of injection — that was the difference between a seed
        // that exists and a seed that is in the picture.
        { action: "evaluate", script: `{ if (!(${defect.proof})) throw new Error("the ${defect.name} seed did not take on this app"); }` },
        { action: "wait", ms: 300 },
      ] as Manifest["setup"];
    }
    const file = path.join(root, `${name}.yaml`);
    fs.writeFileSync(file, [
      defect ? `# ${defect.name} — ${defect.looks}.` : "# control — nothing is wrong with this one.",
      `# Generated by \`retake calibrate ${m.name}\`. Recording it seeds the fault for real.`,
      "",
      YAML.stringify(clone),
    ].join("\n"));
    return { name, defect, file, manifest: clone };
  };

  variants.push(write("control", null));
  for (const d of want) variants.push(write(d.name, d));
  return { root, variants };
}

/**
 * Did the seed actually take?
 *
 * A variant whose frames are byte-identical to the control's is a variant
 * where nothing was injected — the CSS missed, the selector was wrong, the
 * page changed. Counting that as a MISS blames the check for the harness's
 * mistake, and it happened on the very first run: a doubled-heading seed that
 * targeted the wrong element reported 7 of 8 when the honest answer was 7 of
 * 7 and one seed that never landed.
 */
/**
 * @deprecated Seeds prove themselves in the page now — see `Defect.proof`.
 *
 * Kept only as a record of why: this compares a variant's frames to the
 * control's, which cannot work on an app whose content changes between runs.
 * Capture's board carries timestamps and counts, so every variant differed
 * from its control whether or not anything had been injected, and this
 * reported eight seeds as landed when at least one plainly had not.
 */
export function landed(controlDir: string, variantDir: string): boolean {
  // NOTE what this does and does not prove: that the frames differ from the
  // control's, so SOMETHING was injected. It cannot prove the fault is
  // plainly visible in them. A seed that changes the page off-screen passes
  // here and still measures nothing — which happened, twice, before the
  // doubled-heading seed was rewritten to clone a real node.
  const shots = (d: string) => {
    try {
      return fs.readdirSync(path.join(d, "stills")).sort()
        .map((f) => createHash("sha1").update(fs.readFileSync(path.join(d, "stills", f))).digest("hex"));
    } catch { return []; }
  };
  const a = shots(controlDir), b = shots(variantDir);
  if (!a.length || !b.length) return true;   // cannot tell; do not accuse the harness
  return a.join() !== b.join();
}

export type Result = {
  variant: string;
  defect: Defect | null;
  /** Kinds sweep reported, across every frame. */
  kinds: string[];
  found: boolean;
  /** False when the injection produced no visible change at all. */
  seeded: boolean;
  /** Findings that are not the seeded fault. On the control, all of them are
      false positives; on a variant they may be a real second effect of the
      injection, so they are counted separately and never silently. */
  other: number;
  error?: string;
};

/** Recall, false positives, and the sentence that says what they mean. */
export function report(rs: Result[]): string[] {
  const all = rs.filter((r) => r.defect);
  const seeded = all.filter((r) => r.seeded);
  const unseeded = all.filter((r) => !r.seeded);
  const control = rs.find((r) => !r.defect);
  const found = seeded.filter((r) => r.found).length;
  const out: string[] = [];

  out.push("");
  out.push(`RECALL   ${found} of ${seeded.length} defects that actually appeared were found`);
  for (const r of seeded) {
    out.push(`  ${r.found ? "✓" : "✗"} ${r.variant.padEnd(20)} wanted ${String(r.defect!.expect).padEnd(19)} got ${r.kinds.join(", ") || (r.error ? `— ${r.error}` : "nothing")}`);
  }
  if (unseeded.length) {
    out.push("");
    out.push(`NOT MEASURED   ${unseeded.length} seed(s) produced no visible change, so nothing was asked of the check:`);
    for (const r of unseeded) out.push(`  — ${r.variant.padEnd(20)} the injection did not land. Fix the seed, not the checklist.`);
  }
  out.push("");
  if (control) {
    out.push(control.kinds.length
      ? `FALSE POSITIVES   ${control.kinds.length} finding(s) on the control, where nothing is wrong: ${control.kinds.join(", ")}`
      : "FALSE POSITIVES   none on the control");
  } else {
    out.push("FALSE POSITIVES   not measured — no control was run, so no rate can be claimed");
  }
  const noise = seeded.reduce((n, r) => n + r.other, 0);
  if (noise) out.push(`                  and ${noise} extra finding(s) across the variants, beyond the fault seeded in each`);
  out.push("");
  out.push("What this is and is not: the seeds were written by someone who has read the checklist, so recall here is an upper bound — a fault nobody thought to seed is still unmeasured. Injected faults are also cleaner than the ones real apps produce. Treat it as a floor for trust, not a score.");
  return out;
}
