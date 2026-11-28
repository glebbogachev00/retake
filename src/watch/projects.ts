/** Projects: the journeys of one product, looked at one at a time.

    A project is a folder under watch/: watch/capture/*.mjs is "Capture"
    (title-cased from the folder) unless watch/capture/project.json says
    otherwise, e.g. { "name": "Capture app" }. Journeys kept directly in watch/, as every
    workspace did before folders, fall into a project by the site they are
    about: one per registrable domain (login., portal. and www.example.com
    are one), one per host for a local address. Nothing has to move for a
    workspace to keep working. */
import fs from "node:fs";
import path from "node:path";
import { hostOf, journeyOrigin } from "./deploys.js";
import { journeysDir, listJourneys } from "./journey-store.js";
import { hostName } from "./names.js";

export type Project = { id: string; name: string; journeys: string[] };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "other";
const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());

/** example.com for login.example.com; the host itself for a local address. */
export function siteKey(host: string): string {
  const bare = host.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(bare) || bare === "localhost" || bare.endsWith(".localhost") || !bare.includes(".")) return host;
  const parts = bare.split(".");
  // example.co.uk: a two-letter country under a short second level keeps three labels.
  const n = parts.length >= 3 && parts.at(-1)!.length === 2 && parts.at(-2)!.length <= 3 ? 3 : 2;
  return parts.slice(-n).join(".");
}

function folderName(root: string, folder: string): string {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(journeysDir(root), folder, "project.json"), "utf8")) as { name?: unknown };
    if (typeof p.name === "string" && p.name.trim()) return p.name.trim().slice(0, 60);
  } catch { /* no project.json: the folder's name */ }
  return titleCase(folder);
}

/** Every project in the workspace, each with its journeys, in name order. */
export function listProjects(root: string): Project[] {
  const by = new Map<string, Project>();
  for (const j of listJourneys(root)) {
    let id: string, name: string;
    if (j.folder) { id = j.folder; name = folderName(root, j.folder); }
    else {
      const origin = journeyOrigin(root, j);
      const host = origin ? hostOf(origin) : null;
      const site = host ? siteKey(host) : null;
      id = site ? slug(site.replace(/:\d+$/, "").replace(/\.[a-z]{2,}$/i, "") || site) : "other";
      name = site ? (hostName(site) ?? site) : "Other journeys";
    }
    if (!by.has(id)) by.set(id, { id, name, journeys: [] });
    by.get(id)!.journeys.push(j.name);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The project a journey is in. */
export const projectOfJourney = (projects: Project[], name: string) => projects.find((p) => p.journeys.includes(name)) ?? null;

/** The project a new app belongs in. An address on a site a project already
    watches goes there, without asking. Otherwise a new project named after
    the site is the default, and the person may pick an existing one. */
export function projectForSite(root: string, origin: string): { existing: Project | null; fresh: { id: string; name: string } } {
  let host = origin;
  try { host = new URL(origin).host; } catch { /* already a host */ }
  const key = siteKey(host);
  const projects = listProjects(root);
  const all = listJourneys(root);
  const existing = projects.find((p) => p.journeys.some((n) => {
    const j = all.find((x) => x.name === n);
    const o = j ? journeyOrigin(root, j) : null;
    return !!o && siteKey(hostOf(o)) === key;
  })) ?? null;
  const name = hostName(key) ?? key;
  let id = slug(name);
  while (projects.some((p) => p.id === id)) id = `${id}-2`;
  return { existing, fresh: { id, name } };
}

/** Where a project's new journeys are written: its folder, made (with its
    name in project.json) when it is new. Null for a project of journeys
    kept directly in watch/, which stays as it is. */
export function projectFolder(root: string, p: { id: string; name: string }, isNew: boolean): string | null {
  const dir = path.join(journeysDir(root), p.id);
  if (!isNew && !fs.existsSync(dir)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "project.json");
  if (!fs.existsSync(f) && titleCase(p.id) !== p.name) fs.writeFileSync(f, JSON.stringify({ name: p.name }, null, 2) + "\n");
  return p.id;
}
