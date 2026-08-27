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
  /** A `--from` / `--until` take: a piece of another demo, made while
      iterating. Never restored as a demo of its own — doing that put two
      red-dot rows in the library that were not demos at all. */
  fragment: string | null;
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
      let finishedAt = "", seconds: number | null = null, fragment: string | null = null;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8")) as { finishedAt?: string; duration?: number; trimBefore?: number; partial?: string };
        finishedAt = t.finishedAt ?? "";
        if (typeof t.duration === "number") seconds = Math.round(t.duration - (t.trimBefore ?? 0));
        if (t.partial && /\((?:from|until)\)/.test(t.partial)) fragment = t.partial;
      } catch { /* the take is unreadable; the recording is still real */ }
      out.push({ name, dir, used, title, url, finishedAt, seconds, fragment, rendered: fs.existsSync(path.join(dir, "demo.mp4")) });
    } catch { /* mid-write, or not ours */ }
  }
  return out.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

/**
 * Write the demo files back.
 *
 * The `name:` inside a restored manifest is rewritten to match the folder it
 * came from, and this is not cosmetic. A take recorded with `--from` or
 * `--until` keeps the PARENT demo's name in its used manifest, so restoring
 * two fragments of one demo produced three files all declaring
 * `name: avex-full-flow` — and the window, which keys on that name, showed the
 * same demo three times. It looked broken because it was.
 */
export function healOrphans(orphans: Orphan[], demosDir: string): string[] {
  const written: string[] = [];
  fs.mkdirSync(demosDir, { recursive: true });
  for (const o of orphans) {
    if (o.fragment) continue;          // a piece of another demo, not a demo
    const to = path.join(demosDir, `${o.name}.yaml`);
    if (fs.existsSync(to)) continue;   // never overwrite a file a person wrote
    const src = fs.readFileSync(o.used, "utf8");
    fs.writeFileSync(to, renameTo(src, o.name));
    written.push(to);
  }
  return written;
}

/** Set the manifest's own `name:` to `want`, touching nothing else. */
export function renameTo(yaml: string, want: string): string {
  const line = /^name:\s*(.+?)\s*$/m.exec(yaml);
  if (!line) return `name: ${want}\n${yaml}`;
  if (line[1].replace(/^["']|["']$/g, "") === want) return yaml;
  return yaml.replace(/^name:\s*.+$/m, `name: ${want}`);
}

/** The report, in the words a person would use. */
export function describeOrphans(orphans: Orphan[], applied: string[] | null): string[] {
  if (!orphans.length) return ["every recording has its demo file. Nothing hidden."];
  const restorable = orphans.filter((o) => !o.fragment);
  if (!restorable.length) {
    // Saying "run --apply" when --apply would do nothing is how a tool teaches
    // people not to believe it.
    const out = [`${orphans.length} recording${orphans.length === 1 ? " is" : "s are"} not in the window, and ${orphans.length === 1 ? "it is" : "they are"} not meant to be:`];
    for (const o of orphans) out.push(`  ${o.name.padEnd(24)} ${o.fragment}`);
    out.push("");
    out.push("These are pieces of other demos, recorded while iterating. Delete the folders if you want the space; nothing needs restoring.");
    return out;
  }
  const when = (o: Orphan) => (o.finishedAt ? o.finishedAt.slice(0, 16).replace("T", " ") : "unknown");
  const out = [`${restorable.length} recording${restorable.length === 1 ? "" : "s"} the window cannot show, because the demo file is gone:`];
  for (const o of orphans) out.push(`  ${o.name.padEnd(24)} recorded ${when(o)}${o.seconds !== null ? ` · ${o.seconds}s` : ""}${o.rendered ? "" : " · never rendered"}${o.fragment ? " · a fragment of another demo, left as it is" : ""}`);
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
