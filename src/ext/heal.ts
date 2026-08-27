/**
 * Recordings the window cannot show.
 *
 * The window lists demos and shows each demo's take — so a finished recording
 * whose manifest went missing appears nowhere at all. Eight were sitting on
 * one machine, including a five-minute, seventeen-scene one that had been
 * rendered and then simply vanished from view.
 *
 * Retake already writes `manifest.used.yaml` into every output folder, which
 * is the exact manifest that run used. Nothing was reading it. This does.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type Orphan = {
  name: string;
  dir: string;
  /** The copy of the manifest the run itself used. */
  used: string;
  title: string;
  url: string;
  finishedAt: string;
  /** Seconds of finished video, or null when the take could not be read. */
  seconds: number | null;
  /** Whether there is something to watch. A probe run that was never rendered
      is scratch, and filling the library with scratch is its own way of
      hiding things. */
  rendered: boolean;
};

/** Recordings in `outRoot` with no matching manifest in `demosDir`. */
export function findOrphans(outRoot: string, demosDir: string): Orphan[] {
  const out: Orphan[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(outRoot); } catch { return out; }
  for (const name of dirs) {
    if (name.startsWith(".")) continue;
    const dir = path.join(outRoot, name);
    const used = path.join(dir, "manifest.used.yaml");
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      if (!fs.existsSync(used) || !fs.existsSync(path.join(dir, "take.json"))) continue;
      if (fs.existsSync(path.join(demosDir, `${name}.yaml`)) || fs.existsSync(path.join(demosDir, `${name}.yml`))) continue;
      let title = "", url = "";
      try { const m = YAML.parse(fs.readFileSync(used, "utf8")) as { title?: string; url?: string }; title = m.title ?? ""; url = m.url ?? ""; } catch { /* keep the blanks */ }
      let finishedAt = "", seconds: number | null = null;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8")) as { finishedAt?: string; duration?: number; trimBefore?: number };
        finishedAt = t.finishedAt ?? "";
        if (typeof t.duration === "number") seconds = Math.round(t.duration - (t.trimBefore ?? 0));
      } catch { /* the take is unreadable; the recording is still real */ }
      out.push({ name, dir, used, title, url, finishedAt, seconds, rendered: fs.existsSync(path.join(dir, "demo.mp4")) });
    } catch { /* mid-write, or not ours */ }
  }
  return out.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

/** Write the demo files back. Returns what it wrote. */
export function healOrphans(orphans: Orphan[], demosDir: string): string[] {
  const written: string[] = [];
  fs.mkdirSync(demosDir, { recursive: true });
  for (const o of orphans) {
    const to = path.join(demosDir, `${o.name}.yaml`);
    if (fs.existsSync(to)) continue;   // never overwrite a file a person wrote
    fs.copyFileSync(o.used, to);
    written.push(to);
  }
  return written;
}

/** The report, in the words a person would use. */
export function describeOrphans(orphans: Orphan[], applied: string[] | null): string[] {
  if (!orphans.length) return ["every recording has its demo file. Nothing hidden."];
  const when = (o: Orphan) => (o.finishedAt ? o.finishedAt.slice(0, 16).replace("T", " ") : "unknown");
  const out = [`${orphans.length} recording${orphans.length === 1 ? "" : "s"} the window cannot show, because the demo file is gone:`];
  for (const o of orphans) out.push(`  ${o.name.padEnd(24)} recorded ${when(o)}${o.seconds !== null ? ` · ${o.seconds}s` : ""}${o.rendered ? "" : " · never rendered"}`);
  if (applied === null) {
    out.push("");
    out.push("`retake heal --apply` writes each one back from the copy Retake kept inside its own folder.");
    return out;
  }
  out.push("");
  for (const f of applied) out.push(`  → ${path.relative(process.cwd(), f)}`);
  out.push("");
  out.push("Written from `manifest.used.yaml` — the exact manifest each run used, so they re-run as they were recorded.");
  return out;
}
