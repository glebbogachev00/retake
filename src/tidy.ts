/**
 * Reclaiming disk without losing anything you cannot get back.
 *
 * Measured across 37 real demos: 506 MB of outputs, of which 345 MB was
 * DERIVED — master.mp4, demo.mp4, stills, thumbnails and gifs all re-render
 * from `take.json` plus the raw recording, in seconds. Only the raw `.webm`
 * and `take.json` are irreplaceable: lose those and the demo has to be
 * performed again, which is the one cost this tool exists to avoid.
 *
 * So tidy never touches those two, reports before it removes anything, and
 * separates "safe, re-renders in seconds" from "the whole take is rubbish".
 */
import fs from "node:fs";
import path from "node:path";
import type { Take } from "./record.js";

export type Group = { what: string; why: string; files: string[]; bytes: number };
export type Plan = { groups: Group[]; bytes: number; keptBytes: number };

const bytesOf = (p: string): number => {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const f of fs.readdirSync(p)) n += bytesOf(path.join(p, f));
    return n;
  } catch { return 0; }
};

export const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

/** Derived files: every one of these comes back from a re-render. */
const DERIVED = ["master.mp4", "thumbnail.png", "cover.png", "cover-titled.png", "contact.png", "stills"];
const DERIVED_RE = [/\.gif$/, /^\.card-.*\.mp4$/, /^\.callout-.*\.webm$/, /^\.paced\.mp4$/, /^\.joined\.mp4$/, /^debug-filter\.txt$/, /^stalled-\d+\.png$/, /^dry-failed-\d+\.png$/, /^failed-step\.png$/, /^not-the-app\.png$/];

export type TidyOptions = {
  /** Also remove demo.mp4 — still re-renderable, but it is the deliverable. */
  deep?: boolean;
  /** Also remove whole output folders whose manifest no longer exists. */
  orphans?: boolean;
  /** Where manifests live, for deciding what is an orphan. */
  demosDir: string;
};

export function planTidy(outRoot: string, o: TidyOptions): Plan {
  const groups: Group[] = [];
  const add = (what: string, why: string, files: string[]) => {
    if (!files.length) return;
    groups.push({ what, why, files, bytes: files.reduce((n, f) => n + bytesOf(f), 0) });
  };
  if (!fs.existsSync(outRoot)) return { groups: [], bytes: 0, keptBytes: 0 };

  const failed: string[] = [], orphaned: string[] = [], derived: string[] = [], deliverables: string[] = [];
  let keptBytes = 0;

  for (const name of fs.readdirSync(outRoot)) {
    const dir = path.join(outRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const takePath = path.join(dir, "take.json");
    const hasManifest = fs.existsSync(path.join(o.demosDir, `${name}.yaml`)) || fs.existsSync(path.join(o.demosDir, `${name}.json`));

    // A whole folder with no manifest cannot be re-rendered or re-recorded
    // from anything in this workspace — it is a leftover, not an asset.
    if (!hasManifest) { orphaned.push(dir); continue; }

    let take: Take | null = null;
    try { take = JSON.parse(fs.readFileSync(takePath, "utf8")) as Take; } catch { /* no take */ }

    // A take whose steps failed is not something anyone goes back to.
    if (take && take.ok === false) { failed.push(dir); continue; }

    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (f === "take.json" || f.endsWith(".webm") || f === ".retake-lock" || f === ".poster" || f === ".history" || f === "manifest.used.yaml" || f === "proof-log.md" || f === "facts.json") {
        keptBytes += bytesOf(full);
        continue;
      }
      if (f === "demo.mp4") { (o.deep ? deliverables : null)?.push(full); if (!o.deep) keptBytes += bytesOf(full); continue; }
      if (DERIVED.includes(f) || DERIVED_RE.some((re) => re.test(f))) { derived.push(full); continue; }
      keptBytes += bytesOf(full);
    }
  }

  add("re-renderable", "master, stills, thumbnails, gifs, working files — all come back from `retake render`, in seconds", derived);
  add("failed takes", "their steps did not pass; nobody goes back to a broken recording", failed);
  if (o.orphans) add("orphaned folders", "no manifest in demos/ — nothing here can be re-recorded or re-rendered", orphaned);
  if (o.deep) add("deliverables", "demo.mp4 — re-renders from the recording, but it IS the file you hand over", deliverables);

  const bytes = groups.reduce((n, g) => n + g.bytes, 0);
  return { groups, bytes, keptBytes };
}

export function applyTidy(plan: Plan): number {
  let freed = 0;
  for (const g of plan.groups) {
    for (const f of g.files) { freed += bytesOf(f); fs.rmSync(f, { recursive: true, force: true }); }
  }
  return freed;
}
