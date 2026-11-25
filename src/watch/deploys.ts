/**
 * Noticing a new version of an app by itself: no CI, no webhooks, nothing
 * to connect. Every few minutes Retake looks at each app's live address and
 * takes a cheap fingerprint of what is deployed there. When it moves, and
 * stays moved, that app's journeys run.
 *
 * The fingerprint, strongest first:
 *
 *   assets   the script and style files the page links to, when their names
 *            carry a content hash (index-B7f3a9.js, main.3f2a1b.css,
 *            /_next/static/<buildId>/…). A build makes new names; nothing else
 *            does. Nearly every bundler does this by default.
 *   marker   a version the app states: <meta name="version|build|generator">,
 *            data-build / data-version on <html> or <body>, Next's buildId, an
 *            x-build / x-version style header, or a version field from
 *            /version, /healthz or /readyz.
 *   etag     the entry page's ETag, when there is nothing better.
 *
 * Per-request noise never counts: nonces and CSRF tokens are attributes and
 * meta tags that are not read; inline scripts are not read; query values that
 * are tokens, cache-busters or timestamps are dropped from asset addresses.
 *
 * Settling: a new fingerprint must be seen on two checks in a row before
 * anything runs, so a deploy that is still rolling out (old and new servers
 * answering in turn) or a page that changes on every request runs nothing.
 *
 * An app with none of these (no hashed files, no version anywhere) cannot be
 * told apart from one version to the next by a cheap look. It is still run
 * every night; the window says so in one line.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "./journey-store.js";
import { listJourneys, readBaseline, readLast, readSnapshots } from "./journey-store.js";
import { readJson, writeJson } from "./session.js";

/** How often the light check wakes, in minutes. Decided, not a setting. */
export const CHECK_EVERY_MIN = 5;
/** A new fingerprint has to be seen this many checks in a row. */
export const SEEN_TO_SETTLE = 2;

export type Basis = "assets" | "marker" | "etag" | "none";
export type Fingerprint = {
  /** Null when nothing on the page tells one version from the next. */
  id: string | null;
  basis: Basis;
  /** The linked scripts and styles, noise stripped, sorted. */
  assets: string[];
  markers: Record<string, string>;
};

// ---------- reading a page ----------

const ATTR = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
};

/** Query keys that are per request or per visitor, never per build. */
const NOISE_KEYS = /^(nonce|csrf|_csrf|xsrf|token|auth|sig|signature|expires|t|ts|time|timestamp|_|cb|cachebust|cache|rand|random|r|session|sid|utm_.*|fbclid|gclid)$/i;
/** A value that is a moment in time: epoch seconds or milliseconds, or an ISO stamp. */
const looksLikeTime = (v: string) => /^1\d{9}(\d{3})?$/.test(v) || /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v);

/** An asset address with its per-request noise taken out. */
export function cleanAssetUrl(raw: string, base: string): string | null {
  if (!raw || /^(data|blob|javascript):/i.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const keep = [...u.searchParams.entries()].filter(([k, v]) => !NOISE_KEYS.test(k) && !looksLikeTime(v)).sort(([a], [b]) => a.localeCompare(b));
  const q = keep.length ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  // Same-origin files by path alone: the app may be reached by more than one name.
  const b = new URL(base);
  return (u.origin === b.origin ? "" : u.origin) + u.pathname + q;
}

/** Does this address change when the app is built again? A content hash or
    a build id in the file's name or path, or a version in its query. */
export function isHashedAsset(u: string): boolean {
  const [p, q = ""] = u.split("?");
  const file = p.split("/").pop() ?? "";
  const stem = file.replace(/\.(m?js|css|cjs)$/i, "");
  // index-B7f3a9Lk, main.3f2a1b, app_8d9c2e1f, chunk.4f1e2d3c.min
  for (const part of stem.split(/[.\-_~]/).slice(1)) if (part.length >= 6 && /\d/.test(part) && /^[A-Za-z0-9]+$/.test(part)) return true;
  // /_next/static/<buildId>/…, /build/<sha>/…, /assets/v2.14.1/…
  for (const seg of p.split("/").slice(0, -1)) {
    if (seg.length >= 8 && /\d/.test(seg) && /[a-z]/i.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg) && !/^(static|assets|chunks|build|dist)$/i.test(seg)) return true;
    if (/^v?\d+\.\d+(\.\d+)?$/.test(seg)) return true;
  }
  return /(^|&)(v|ver|version|h|hash|build|rev)=/.test(q);
}

const MARKER_META = /^(generator|version|app-version|application-version|build|build-id|buildid|release|revision|commit|git-sha)$/i;
const MARKER_HEADERS = ["x-build", "x-build-id", "x-version", "x-app-version", "x-release", "x-revision", "x-commit", "x-git-sha", "x-deploy-id", "x-deployment-id"];
const VERSION_KEYS = /^(version|appVersion|app_version|build|buildId|build_id|commit|sha|gitSha|git_sha|gitCommit|git_commit|revision|release|deployment|deploymentId|deployment_id|image|tag)$/;

/** A version field from a /version, /healthz or /readyz answer: top level, or
    one object down ({ "app": { "version": … } }). Times and counters never. */
export function versionFields(json: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (o: unknown, prefix: string, depth: number) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if ((typeof v === "string" || typeof v === "number") && VERSION_KEYS.test(k) && !looksLikeTime(String(v))) out[prefix + k] = String(v).slice(0, 120);
      else if (depth < 1 && v && typeof v === "object") take(v, `${prefix}${k}.`, depth + 1);
    }
  };
  take(json, "", 0);
  return out;
}

/**
 * The fingerprint of one look at an app: its entry page's HTML and headers,
 * and whatever its version endpoints said.
 */
export function fingerprintOf(o: { html: string; headers: Record<string, string>; base: string; probes?: Record<string, unknown>; offOrigin?: boolean }): Fingerprint {
  const assets = new Set<string>();
  const markers: Record<string, string> = {};
  const html = o.offOrigin ? "" : o.html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = ATTR(m[0], "src");
    const u = src ? cleanAssetUrl(src, o.base) : null;
    if (u) assets.add(u);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (ATTR(m[0], "rel") ?? "").toLowerCase();
    const as = (ATTR(m[0], "as") ?? "").toLowerCase();
    if (!/\b(stylesheet|modulepreload)\b/.test(rel) && !(/\bpreload\b/.test(rel) && /^(script|style)$/.test(as))) continue;
    const u = cleanAssetUrl(ATTR(m[0], "href") ?? "", o.base);
    if (u) assets.add(u);
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = ATTR(m[0], "name") ?? ATTR(m[0], "property") ?? "";
    const content = ATTR(m[0], "content");
    if (MARKER_META.test(name) && content && !looksLikeTime(content)) markers[`meta:${name.toLowerCase()}`] = content.slice(0, 120);
  }
  for (const m of html.matchAll(/<(html|body)\b[^>]*>/gi)) {
    for (const a of ["data-build", "data-version", "data-release", "data-commit"]) {
      const v = ATTR(m[0], a);
      if (v && !looksLikeTime(v)) markers[`${m[1].toLowerCase()}:${a}`] = v.slice(0, 120);
    }
  }
  const next = /"buildId"\s*:\s*"([^"]{4,80})"/.exec(html);
  if (next) markers["next:buildId"] = next[1];
  const h = Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of MARKER_HEADERS) if (h[k] && !looksLikeTime(h[k])) markers[`header:${k}`] = h[k].slice(0, 120);
  for (const [p, body] of Object.entries(o.probes ?? {})) for (const [k, v] of Object.entries(versionFields(body))) markers[`${p}:${k}`] = v;

  const list = [...assets].sort();
  let basis: Basis = list.some(isHashedAsset) ? "assets" : Object.keys(markers).length ? "marker" : h.etag ? "etag" : "none";
  const sorted = Object.fromEntries(Object.entries(markers).sort(([a], [b]) => a.localeCompare(b)));
  const material = basis === "none" ? null : basis === "etag" ? { etag: h.etag.replace(/^W\//, "") } : { assets: list, markers: sorted };
  if (basis === "etag" && !h.etag) basis = "none";
  const id = material ? crypto.createHash("sha1").update(JSON.stringify(material)).digest("hex").slice(0, 12) : null;
  return { id, basis, assets: list, markers: sorted };
}

/** Look at an app once. Null when it does not answer. */
export async function observe(entry: string, timeoutMs = 10_000): Promise<Fingerprint | null> {
  const headers = { "user-agent": "Retake-Watch (a check for a new version)", accept: "text/html,application/json;q=0.9,*/*;q=0.5" };
  const get = (u: string) => fetch(u, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  let res: Response;
  try { res = await get(entry); } catch { return null; }
  if (res.status >= 500) return null;
  const html = (await res.text().catch(() => "")).slice(0, 2_000_000);
  const origin = new URL(entry).origin;
  const offOrigin = (() => { try { return new URL(res.url || entry).origin !== origin; } catch { return false; } })();
  const probes: Record<string, unknown> = {};
  await Promise.all(["/version", "/healthz", "/readyz"].map(async (p) => {
    try {
      const r = await get(origin + p);
      if (!r.ok || !/json/i.test(r.headers.get("content-type") ?? "")) return;
      probes[p] = await r.json();
    } catch { /* not there */ }
  }));
  const hs: Record<string, string> = {};
  res.headers.forEach((v, k) => { hs[k] = v; });
  return fingerprintOf({ html, headers: offOrigin ? {} : hs, base: res.url || entry, probes, offOrigin });
}

// ---------- seen twice in a row ----------

export type OriginState = {
  origin: string;
  basis: Basis;
  /** The version the journeys last ran against (or the first one seen). */
  current: string | null;
  /** A new fingerprint seen, waiting to be seen again. */
  candidate: { id: string; seen: number; at: string } | null;
  checkedAt: string;
  changedAt?: string;
  /** The app did not answer on the last check. */
  down?: boolean;
};

/**
 * One check's worth of deciding. `changed` is true exactly once per new
 * version: on the check that sees it for the second time in a row.
 */
export function advance(prev: OriginState | undefined, origin: string, fp: Fingerprint | null, now = new Date()): { next: OriginState; changed: boolean } {
  const at = now.toISOString();
  const base: OriginState = prev ? { ...prev, checkedAt: at, down: false } : { origin, basis: "none", current: null, candidate: null, checkedAt: at };
  // Not answering is not a new version, and breaks a run of sightings.
  if (!fp) return { next: { ...base, candidate: null, down: true }, changed: false };
  base.basis = fp.basis;
  if (!fp.id) return { next: { ...base, current: null, candidate: null }, changed: false };
  // The first look is what is there now: nothing to run.
  if (!base.current) return { next: { ...base, current: fp.id, candidate: null }, changed: false };
  if (fp.id === base.current) return { next: { ...base, candidate: null }, changed: false };
  const seen = base.candidate?.id === fp.id ? base.candidate.seen + 1 : 1;
  if (seen >= SEEN_TO_SETTLE) return { next: { ...base, current: fp.id, candidate: null, changedAt: at }, changed: true };
  return { next: { ...base, candidate: { id: fp.id, seen, at: base.candidate?.id === fp.id ? base.candidate.at : at } }, changed: false };
}

const dotRetake = (root: string) => path.join(root, ".retake");
const stateFile = (root: string) => path.join(dotRetake(root), "watch-deploys.json");
export const readDeploys = (root: string) => readJson<Record<string, OriginState>>(stateFile(root), {});
export function writeDeploys(root: string, all: Record<string, OriginState>) {
  fs.mkdirSync(dotRetake(root), { recursive: true });
  writeJson(stateFile(root), all);
}

// ---------- which app a journey is about ----------

/** A journey's app, read from its file without running it: `export const url`,
    else the address its accepted run was on, else the first address it names. */
export function journeyOrigin(root: string, j: { name: string; file: string }): string | null {
  let src = "";
  try { src = fs.readFileSync(j.file, "utf8"); } catch { /* gone */ }
  const declared = /export\s+const\s+url\s*=\s*["'`]([^"'`]+)["'`]/.exec(src)?.[1];
  const tryOrigin = (u: string | undefined | null) => { try { return u && /^https?:/i.test(u) ? new URL(u).origin : null; } catch { return null; } };
  const d = tryOrigin(declared);
  if (d) return d;
  const steps = readBaseline(root, j.name)?.steps ?? (() => { const l = readLast(root, j.name); return l?.dir ? readSnapshots(l.dir) : []; })();
  for (const s of steps) { const o = tryOrigin(s.url); if (o) return o; }
  return tryOrigin(/https?:\/\/[^\s"'`)]+/.exec(src)?.[0]);
}

/** The journeys, grouped by the app they are about. */
export function journeysByOrigin(root: string): Map<string, { name: string; file: string }[]> {
  const out = new Map<string, { name: string; file: string }[]>();
  for (const j of listJourneys(root)) {
    const o = journeyOrigin(root, j);
    if (!o) continue;
    if (!out.has(o)) out.set(o, []);
    out.get(o)!.push(j);
  }
  return out;
}

export const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

// ---------- one run at a time ----------

const lockFile = (root: string) => path.join(dotRetake(root), "watch-run.lock");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Take the workspace's run lock, or null when another run holds it. */
export function takeRunLock(root: string): (() => void) | null {
  fs.mkdirSync(dotRetake(root), { recursive: true });
  const f = lockFile(root);
  try {
    const held = Number(fs.readFileSync(f, "utf8").trim());
    if (held && held !== process.pid && alive(held)) return null;
  } catch { /* free */ }
  fs.writeFileSync(f, String(process.pid));
  return () => { try { if (fs.readFileSync(f, "utf8").trim() === String(process.pid)) fs.rmSync(f); } catch { /* gone */ } };
}

// ---------- what the last run was, and why ----------

export type Trigger = "deploy" | "nightly" | "hand";
export type LastRun = { at: string; trigger: Trigger; host?: string; journeys: number; changed: number; failed: number; skipped: number };
const lastRunFile = (root: string) => path.join(dotRetake(root), "watch-last-run.json");
export const readLastRun = (root: string) => readJson<LastRun | null>(lastRunFile(root), null);
export function writeLastRun(root: string, r: LastRun) {
  fs.mkdirSync(dotRetake(root), { recursive: true });
  writeJson(lastRunFile(root), r);
}
export function lastRunOf(runs: Pick<RunRecord, "status">[], trigger: Trigger, o: { host?: string; skipped?: number; at?: Date } = {}): LastRun {
  return {
    at: (o.at ?? new Date()).toISOString(), trigger, ...(o.host ? { host: o.host } : {}),
    journeys: runs.length, changed: runs.filter((r) => r.status === "changed").length, failed: runs.filter((r) => r.status === "failed").length, skipped: o.skipped ?? 0,
  };
}

/** "6 journeys, nothing unexpected", "1 changed", "1 changed, 1 failed". */
export function outcomeWords(r: Pick<LastRun, "journeys" | "changed" | "failed">): string {
  if (!r.changed && !r.failed) return `${r.journeys} journey${r.journeys === 1 ? "" : "s"}, nothing unexpected`;
  return [r.changed ? `${r.changed} changed` : "", r.failed ? `${r.failed} failed` : ""].filter(Boolean).join(", ");
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The Watch area's header line: "Ran at 14:02 because app.example.com changed". */
export function ranLine(r: LastRun, now = new Date()): string {
  const d = new Date(r.at);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  const when = days === 0 ? `at ${hhmm(d)}` : days === 1 ? `yesterday at ${hhmm(d)}` : `on ${d.getDate()} ${MONTH[d.getMonth()]} at ${hhmm(d)}`;
  const why = r.trigger === "deploy" && r.host ? `because ${r.host} changed` : r.trigger === "nightly" ? "as it does every night" : "when asked";
  return `Ran ${when} ${why}`;
}

/** The notification for a run a new version started, or null to stay
    silent: the same rule as the nightly run. */
export function deployNotice(host: string, runs: Pick<RunRecord, "status" | "title">[]): { title: string; body: string } | null {
  const loud = runs.filter((r) => r.status !== "unchanged");
  if (!loud.length) return null;
  const o = outcomeWords({ journeys: runs.length, changed: runs.filter((r) => r.status === "changed").length, failed: runs.filter((r) => r.status === "failed").length });
  return { title: "Retake Watch", body: `${host} has a new version — ${o}: ${loud.map((r) => r.title).join(", ")}`.slice(0, 220) };
}

/** What a run a new version started says in the log and the terminal. */
export const deployLine = (host: string, runs: Pick<RunRecord, "status">[]) =>
  `${host} has a new version — ${outcomeWords({ journeys: runs.length, changed: runs.filter((r) => r.status === "changed").length, failed: runs.filter((r) => r.status === "failed").length })}`;

/** The one line the window shows for apps a cheap look cannot tell apart, or null. */
export function nightlyOnlyLine(root: string): string | null {
  const all = readDeploys(root);
  const blind = Object.values(all).filter((s) => s.basis === "none").map((s) => hostOf(s.origin));
  if (!blind.length) return null;
  const names = blind.length === 1 ? blind[0] : `${blind.slice(0, -1).join(", ")} and ${blind.at(-1)}`;
  return `${names} ${blind.length === 1 ? "shows" : "show"} no version to watch, so ${blind.length === 1 ? "it is" : "they are"} checked each night only.`;
}

// ---------- the one switch, in one line ----------

const listWords = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "the app") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs[0]} and ${xs.length - 1} more`;

/** `retake watch schedule` with nothing after it: where the switch stands. */
export function scheduleStatusLine(o: {
  nightly: { when: string; loaded: boolean; mechanism: string } | null;
  check: { loaded: boolean; mechanism: string } | null;
  hosts: string[]; blind: string[];
}): string {
  const broken = [o.nightly, o.check].find((x) => x && !x.loaded);
  if (broken) return `✗ written, but ${broken.mechanism} is not holding it — \`retake watch schedule on\` again`;
  if (!o.nightly && !o.check) return "off — `retake watch schedule on` runs every journey each night, and whenever the app has a new version";
  if (o.nightly && !o.check) return `✓ ${o.nightly.when}, nightly only — \`retake watch schedule on\` also runs them whenever the app has a new version`;
  const watched = o.hosts.filter((h) => !o.blind.includes(h));
  const change = watched.length ? `and whenever ${listWords(watched)} has a new version (a look every ${CHECK_EVERY_MIN} minutes)` : `and whenever the app has a new version (a look every ${CHECK_EVERY_MIN} minutes)`;
  const blind = o.blind.length ? `; ${listWords(o.blind)} ${o.blind.length === 1 ? "shows" : "show"} no version, so nightly only` : "";
  if (!o.nightly) return `✓ on, ${change.replace(/^and /, "")}${blind}`;
  return `✓ on — ${o.nightly.when}, ${change}${blind}`;
}
