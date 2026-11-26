/**
 * Which apps journeys may change.
 *
 * A journey that only reads (opens pages, signs in, looks) can run against
 * anything. A journey that changes data (creates a project, invites someone)
 * runs only against an app the person has said is a test space, asked once
 * per app: "Is app.example.com a test space? Journeys that change data run
 * only there." Without a yes, it is skipped, and says so.
 *
 *   // watch/create-project.mjs
 *   export const url = "https://staging.example.com";   // the app it is about
 *   export const changesData = true;                     // only where that app is a test space
 *
 * The answers are kept beside the journeys (watch/.spaces.json), because
 * they are a decision a person made about the apps, like a baseline.
 */
import fs from "node:fs";
import path from "node:path";
import { journeysDir, listJourneys } from "./journey-store.js";
import { readJson, writeJson } from "./session.js";

type Answer = { test: boolean; at: string };
const file = (root: string) => path.join(journeysDir(root), ".spaces.json");
const readAll = (root: string) => readJson<Record<string, Answer>>(file(root), {});

/** A host that lives on this computer or this network: served over plain
    http, nearly always. localhost, *.local, 127.x, 10.x, 192.168.x,
    172.16–31.x, 0.0.0.0, ::1. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0" || h === "::1") return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** An address as typed, with its scheme: as given, else http:// for an app on
    this computer or network (127.0.0.1:4563, localhost:3000), else https://. */
export function withScheme(raw: string): string {
  const t = raw.trim();
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const host = t.replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  return `${isLocalHost(host) ? "http" : "https"}://${t}`;
}

export const originOf = (url: string): string | null => {
  try { const u = new URL(withScheme(url)); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; }
};

/** True, false, or null when nobody has been asked about this app yet. */
export function spaceAnswer(root: string, url: string): boolean | null {
  const o = originOf(url);
  if (!o) return null;
  const a = readAll(root)[o];
  return a ? a.test : null;
}

export const isTestSpace = (root: string, url: string) => spaceAnswer(root, url) === true;

export function markSpace(root: string, url: string, test: boolean): string {
  const o = originOf(url);
  if (!o) throw new Error(`"${url}" is not an app's address`);
  const all = readAll(root);
  all[o] = { test, at: new Date().toISOString() };
  fs.mkdirSync(journeysDir(root), { recursive: true });
  writeJson(file(root), all);
  return o;
}

/** What a journey file says about itself, read without running it. */
export function journeyMeta(source: string): { url: string | null; changesData: boolean; title: string | null; makes: string[] } {
  const str = (name: string) => new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(source)?.[2] ?? null;
  // What a data journey creates, by its exact text: `export const makes = ["Watch check"]`.
  let makes: string[] = [];
  const m = /export\s+const\s+makes\s*=\s*(\[[^\]]*\])/.exec(source);
  if (m) { try { makes = (JSON.parse(m[1]) as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0); } catch { /* not plain JSON: none */ } }
  return { url: str("url"), changesData: /export\s+const\s+changesData\s*=\s*true\b/.test(source), title: str("title"), makes };
}

export const hostName = (url: string) => { try { return new URL(originOf(url) ?? url).host; } catch { return url; } };

/** May this journey run now? A reason in one sentence when not. */
export function gate(root: string, j: { name: string; file: string }, originGuess?: string | null): { run: true } | { run: false; why: string; origin: string | null } {
  let src = "";
  try { src = fs.readFileSync(j.file, "utf8"); } catch { return { run: true }; }
  const m = journeyMeta(src);
  if (!m.changesData) return { run: true };
  const o = (m.url && originOf(m.url)) || originGuess || null;
  if (!o) return { run: false, why: "it changes data and does not say which app (export const url), so it is skipped", origin: null };
  if (isTestSpace(root, o)) return { run: true };
  return { run: false, why: `it changes data, and ${hostName(o)} is not marked as a test space`, origin: o };
}

/** The question, asked once per app, word for word. */
export const spaceQuestion = (url: string) => `Is ${hostName(url)} a test space? Journeys that change data run only there.`;

/** The journey already watching this on this app, by its title, or null:
    adding the same app twice must not make two of everything. */
export function alreadyWatched(root: string, origin: string, p: { title: string }): string | null {
  for (const j of listJourneys(root)) {
    let m: ReturnType<typeof journeyMeta>;
    try { m = journeyMeta(fs.readFileSync(j.file, "utf8")); } catch { continue; }
    if ((m.title ?? j.name).trim().toLowerCase() === p.title.trim().toLowerCase() && m.url && originOf(m.url) === origin) return j.name;
  }
  return null;
}
