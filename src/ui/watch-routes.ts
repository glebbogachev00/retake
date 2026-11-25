/**
 * Watch mode in the window.
 *
 * A test script (src/watch.ts) registers a session here, streams the live
 * picture in, and reports each step. The person watches /watch/<id>, picks
 * the pace, and flags what looks unclear. Their flags are written straight
 * into the session folder, so nothing depends on the script surviving, and
 * a finished session plays back from its video on the same screen.
 *
 *   GET  /watch                      the newest live session, or the list
 *   GET  /watch/<id>                 one session: live, or replay
 *   GET  /watch-files/<id>/<file>    its video and screenshots
 *   GET  /api/watch/where            where sessions go, and the chosen speed
 *   GET  /api/watch/sessions         every session, newest first
 *   POST /api/watch/sessions         a script starts one
 *   POST /api/watch/speed            the person's pace (watch | step | fast)
 *   GET  /api/watch/<id>             its state
 *   GET  /api/watch/<id>/stream      SSE: its state, whenever it changes
 *   GET  /api/watch/<id>/live.mjpg   the live picture
 *   POST /api/watch/<id>/frame       a script's newest frame
 *   POST /api/watch/<id>/event       a script's step, result, end…
 *   GET  /api/watch/<id>/wait        a script waits for the person's pace
 *   POST /api/watch/<id>/next        the person presses Next
 *   POST /api/watch/<id>/hold        the person is writing a note
 *   POST /api/watch/<id>/flag        Unclear, or a note, at a moment
 *   POST /api/watch/<id>/note        the words for a flag
 *   POST /api/watch/<id>/fix         send the notes to be fixed (after 10 s)
 *   POST /api/watch/<id>/fix/undo    …unless taken back
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ffmpegBin } from "../media-bin.js";
import {
  appendFlag, isSpeed, queueStatus, readFlagsIn, readMeta, readSteps, runFix, safeId, stepAt, unsent, updateFlag,
  writeFixRequest, writeReport, type FlagRecord, type Speed,
} from "../watch/session.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIX_UNDO_MS = 10_000;
/** A script that has said nothing for this long has died without ending. */
const GONE_MS = 45_000;
const alive = (l: { ended: boolean; lastSeen: number } | undefined) => !!l && !l.ended && Date.now() - l.lastSeen < GONE_MS;

type Live = {
  id: string;
  dir: string;
  title: string;
  startedAt: number;
  frame: Buffer | null;
  url: string;
  scenario: string | null;
  next: number;
  hold: boolean;
  waiting: boolean;
  ended: boolean;
  fix: { repo: string; command: string } | null;
  mjpeg: Set<http.ServerResponse>;
  /** Re-sends the newest frame: Chrome shows a part only once the next one
      begins, so a screen that has gone still would sit one frame behind. */
  echo: NodeJS.Timeout | null;
  waiters: Set<() => void>;
  lastSeen: number;
};
type PendingFix = { timer: NodeJS.Timeout; sendAt: number; notes: number };

export type WatchDeps = {
  root: string;
  outRoot: () => string;
  token: string;
  /** Tell the activity feed: anybody watching it can pick the fix up. */
  activity: (type: string, data: unknown) => void;
};

export function watchRoutes(deps: WatchDeps) {
  const live = new Map<string, Live>();
  const watchers = new Map<string, Set<(state: unknown) => void>>();
  const fixes = new Map<string, PendingFix>();
  const lastFix = new Map<string, { name: string; notes: number; at: number }>();
  const locks = new Map<string, Promise<unknown>>();
  const watchRoot = () => path.join(deps.outRoot(), "watch");
  const speedFile = path.join(deps.root, ".drafts", "watch-speed");
  let speed: Speed = (() => { try { const s = fs.readFileSync(speedFile, "utf8").trim(); return isSpeed(s) ? s : "watch"; } catch { return "watch"; } })();

  const page = () => fs.readFileSync(path.join(HERE, "watch.html"), "utf8")
    .replace("</head>", `<script>window.__retakeToken=${JSON.stringify(deps.token)}</script></head>`);

  const dirFor = (id: string): string | null => {
    if (!safeId(id)) return null;
    const l = live.get(id);
    if (l) return l.dir;
    const d = path.join(watchRoot(), id);
    return fs.existsSync(path.join(d, "session.json")) ? d : null;
  };

  /** One write at a time per session: a flag's number and its picture's
      name must agree even when two land together. */
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(id, run.catch(() => {}));
    return run;
  };

  function state(id: string) {
    const dir = dirFor(id);
    if (!dir) return null;
    const meta = readMeta(dir);
    const l = live.get(id);
    const steps = readSteps(dir);
    const statuses = queueStatus(path.dirname(dir));
    const flags = readFlagsIn(dir).map((f) => ({ ...f, fixStatus: f.fix ? statuses.get(`${dir}#${f.fix}`) ?? "sent" : null }));
    const pf = fixes.get(id);
    const isLive = alive(l) && !meta?.endedAt;
    return {
      id, dir, title: meta?.title ?? l?.title ?? id, startedAt: meta?.startedAt ?? null, endedAt: meta?.endedAt ?? null,
      video: meta?.video ?? null, problem: meta?.problem ?? null,
      live: isLive, speed, waiting: !!l?.waiting, hold: !!l?.hold, next: l?.next ?? 0,
      scenario: l?.scenario ?? null, url: l?.url ?? "",
      steps, flags,
      fix: { pending: pf ? { sendAt: pf.sendAt, notes: pf.notes } : null, last: lastFix.get(id) ?? null },
      now: Date.now(),
    };
  }

  const push = (id: string) => {
    const set = watchers.get(id);
    if (!set?.size) return;
    const s = state(id);
    for (const w of set) w(s);
  };
  const wake = (l: Live) => { for (const w of [...l.waiters]) w(); };
  const control = (l?: Live) => ({ speed, next: l?.next ?? 0, hold: !!l?.hold });

  function list() {
    let ids: string[] = [];
    try { ids = fs.readdirSync(watchRoot()).filter((x) => safeId(x)); } catch { /* none yet */ }
    for (const id of live.keys()) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => {
      const dir = dirFor(id);
      const meta = dir ? readMeta(dir) : null;
      if (!dir || !meta) return null;
      const steps = readSteps(dir), flags = readFlagsIn(dir);
      const l = live.get(id);
      return {
        id, title: meta.title, startedAt: meta.startedAt, endedAt: meta.endedAt, video: meta.video,
        live: alive(l) && !meta.endedAt,
        steps: steps.length, passed: steps.filter((s) => s.result === "pass").length, failed: steps.filter((s) => s.result === "fail").length, flags: flags.length,
      };
    }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Send a session's unsent notes after the undo window. */
  function scheduleFix(id: string): PendingFix | null {
    const dir = dirFor(id);
    if (!dir) return null;
    const todo = unsent(readFlagsIn(dir));
    if (!todo.length) return null;
    const had = fixes.get(id);
    if (had) clearTimeout(had.timer);
    const pf: PendingFix = {
      sendAt: Date.now() + FIX_UNDO_MS, notes: todo.length,
      timer: setTimeout(() => {
        fixes.delete(id);
        void serial(id, async () => {
          const sent = writeFixRequest(dir);
          if (sent) {
            writeReport(dir);
            lastFix.set(id, { name: sent.name, notes: sent.notes, at: Date.now() });
            deps.activity("fix-request", { dir, request: sent.name, notes: sent.notes, brief: sent.md, json: sent.json });
            const fix = live.get(id)?.fix;
            if (fix) runFix(fix, sent.md);
          }
          push(id);
        });
      }, FIX_UNDO_MS),
    };
    fixes.set(id, pf);
    push(id);
    return pf;
  }

  /** A picture of the moment: the live frame, or the video at that time. */
  async function shotFor(id: string, dir: string, n: number, source: "live" | "replay", time: number): Promise<string | null> {
    const rel = `shots/flag-${String(n).padStart(2, "0")}.jpg`;
    const out = path.join(dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const l = live.get(id);
    if (source === "live" && l?.frame) { fs.writeFileSync(out, l.frame); return rel; }
    const video = path.join(dir, "session.mp4");
    if (!fs.existsSync(video)) return null;
    const grab = (seek: string[]) => new Promise<boolean>((done) => {
      fs.rmSync(out, { force: true });
      execFile(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...seek, "-i", video, "-frames:v", "1", "-q:v", "3", out], (e) => done(!e && fs.existsSync(out)));
    });
    // A moment at the very end of the video has no frame after it to seek
    // to: the last frame is the picture of it.
    if (await grab(["-ss", Math.max(0, time).toFixed(2)])) return rel;
    return (await grab(["-sseof", "-0.3"])) ? rel : null;
  }

  function sendFile(f: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const stat = fs.statSync(f);
    const type = f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".jpg") ? "image/jpeg" : f.endsWith(".png") ? "image/png" : f.endsWith(".md") ? "text/markdown; charset=utf-8" : f.endsWith(".json") ? "application/json" : "application/octet-stream";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const pipe = (s: fs.ReadStream) => { s.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); }); s.pipe(res); };
    if (range) {
      const start = Number(range[1] || 0);
      const end = Math.min(range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1);
      if (start > end || start >= stat.size) { res.writeHead(416, { "content-range": `bytes */${stat.size}` }); return res.end(); }
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      return pipe(fs.createReadStream(f, { start, end }));
    }
    res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes", "cache-control": "no-store" });
    pipe(fs.createReadStream(f));
  }

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    if (res.headersSent) { res.end(); return true; }
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return true;
  };

  /** Pages and files: no token, like the window's own page. */
  function handlePage(req: http.IncomingMessage, res: http.ServerResponse, p: string): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (p === "/watch" || p === "/watch/" || /^\/watch\/[a-z0-9-]+$/.test(p)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page());
      return true;
    }
    const mf = /^\/watch-files\/([a-z0-9-]+)\/((?:shots\/)?[A-Za-z0-9._-]+)$/.exec(p);
    if (mf) {
      const dir = dirFor(mf[1]);
      const f = dir ? path.join(dir, mf[2]) : "";
      if (!f || mf[2].startsWith(".") || !fs.existsSync(f)) return json(res, 404, { error: "not found" });
      sendFile(f, req, res);
      return true;
    }
    return false;
  }

  /** /api/watch/…, after the window's guard has passed it. */
  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string, readBody: () => Promise<string>): Promise<boolean> {
    if (!p.startsWith("/api/watch")) return false;
    const body = async <T>() => { const t = await readBody(); return (t ? JSON.parse(t) : {}) as T; };

    if (p === "/api/watch/where" && req.method === "GET") return json(res, 200, { out: deps.outRoot(), speed });
    if (p === "/api/watch/sessions" && req.method === "GET") return json(res, 200, list());
    if (p === "/api/watch/speed" && req.method === "POST") {
      const b = await body<{ speed?: string }>();
      if (!isSpeed(b.speed)) return json(res, 400, { error: "speed is watch, step or fast" });
      speed = b.speed;
      try { fs.mkdirSync(path.dirname(speedFile), { recursive: true }); fs.writeFileSync(speedFile, speed); } catch { /* kept in memory */ }
      for (const l of live.values()) { wake(l); push(l.id); }
      return json(res, 200, { speed });
    }
    if (p === "/api/watch/sessions" && req.method === "POST") {
      const b = await body<{ id?: string; dir?: string; title?: string; startedAt?: string; fix?: { repo?: string; command?: string } | null }>();
      if (!b.id || !safeId(b.id) || !b.dir || path.basename(b.dir) !== b.id || !fs.existsSync(path.join(b.dir, "session.json"))) return json(res, 400, { error: "a session needs its id and the folder it writes to" });
      const had = live.get(b.id);
      const l: Live = had ?? {
        id: b.id, dir: path.resolve(b.dir), title: String(b.title ?? b.id), startedAt: Date.parse(b.startedAt ?? "") || Date.now(),
        frame: null, url: "", scenario: null, next: 0, hold: false, waiting: false, ended: false,
        fix: b.fix?.repo && b.fix?.command ? { repo: b.fix.repo, command: b.fix.command } : null,
        mjpeg: new Set(), echo: null, waiters: new Set(), lastSeen: Date.now(),
      };
      live.set(b.id, l);
      deps.activity("watch", { id: l.id, title: l.title, link: `/watch/${l.id}` });
      push(l.id);
      return json(res, 200, { ok: true, ...control(l) });
    }

    const m = /^\/api\/watch\/([a-z0-9-]+)(?:\/(stream|live\.mjpg|frame|event|wait|next|hold|flag|note|fix|fix\/undo))?$/.exec(p);
    if (!m) return json(res, 404, { error: "not found" });
    const id = m[1], sub = m[2] ?? "";
    const dir = dirFor(id);
    if (!dir) return json(res, 404, { error: "no such session" });
    const l = live.get(id);
    if (l) l.lastSeen = Date.now();

    if (!sub && req.method === "GET") return json(res, 200, state(id));

    if (sub === "stream" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (s: unknown) => res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`);
      send(state(id));
      const set = watchers.get(id) ?? new Set();
      watchers.set(id, set);
      set.add(send);
      const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => { set.delete(send); clearInterval(beat); });
      return true;
    }

    if (sub === "live.mjpg" && req.method === "GET") {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store", connection: "keep-alive" });
      // Each part is closed by the next boundary at once, so the browser
      // shows a frame the moment it arrives rather than when the next comes.
      res.write("--frame\r\n");
      if (l?.frame) { writePart(res, l.frame); writePart(res, l.frame); }
      if (!l) return true;
      l.mjpeg.add(res);
      req.on("close", () => l.mjpeg.delete(res));
      return true;
    }

    if (sub === "frame" && req.method === "POST") {
      const b = await body<{ data?: string; url?: string }>();
      if (!l) return json(res, 409, { error: "not live" });
      if (b.data) {
        l.frame = Buffer.from(b.data, "base64");
        const frame = l.frame;
        for (const r of l.mjpeg) if (r.writableLength < 4_000_000) writePart(r, frame);
        if (l.echo) clearTimeout(l.echo);
        l.echo = setTimeout(() => { l.echo = null; if (l.frame === frame) for (const r of l.mjpeg) writePart(r, frame); }, 150);
      }
      if (b.url) l.url = b.url;
      return json(res, 200, control(l));
    }

    if (sub === "event" && req.method === "POST") {
      const b = await body<{ kind?: string; url?: string; scenario?: string | null }>();
      if (!l) return json(res, 409, { error: "not live" });
      if (b.url) l.url = b.url;
      if (b.kind === "scenario") l.scenario = b.scenario ?? null;
      if (b.kind === "end") {
        l.ended = true; l.waiting = false; l.hold = false;
        for (const r of l.mjpeg) r.end();
        l.mjpeg.clear();
        wake(l);
        scheduleFix(id);
      }
      push(id);
      return json(res, 200, control(l));
    }

    if (sub === "wait" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const ms = Math.min(Math.max(Number(url.searchParams.get("ms") ?? 1500), 0), 30_000);
      if (!l || l.ended || l.next > after) return json(res, 200, control(l));
      const was = { speed, hold: l.hold };
      await new Promise<void>((done) => {
        const finish = () => { clearTimeout(t); l.waiters.delete(check); req.off("close", finish); done(); };
        const check = () => { if (l.next > after || speed !== was.speed || l.hold !== was.hold || l.ended) finish(); };
        const t = setTimeout(finish, ms);
        l.waiters.add(check);
        req.on("close", finish);
        l.waiting = true;
        push(id);
      });
      if (!l.waiters.size) l.waiting = false;
      push(id);
      return json(res, 200, control(l));
    }

    if (sub === "next" && req.method === "POST") {
      if (!l || l.ended) return json(res, 409, { error: "not live" });
      l.next++;
      wake(l);
      push(id);
      return json(res, 200, control(l));
    }

    if (sub === "hold" && req.method === "POST") {
      const b = await body<{ on?: boolean }>();
      if (l && !l.ended) { l.hold = !!b.on; wake(l); push(id); }
      return json(res, 200, control(l));
    }

    if (sub === "flag" && req.method === "POST") {
      const b = await body<{ kind?: string; note?: string; time?: number }>();
      const kind: FlagRecord["kind"] = b.kind === "note" ? "note" : "unclear";
      const isLive = !!l && !l.ended;
      const source: FlagRecord["source"] = isLive ? "live" : "replay";
      const meta = readMeta(dir);
      const startMs = l?.startedAt ?? Date.parse(meta?.startedAt ?? "");
      const time = isLive ? (Date.now() - startMs) / 1000 : Math.max(0, Number(b.time ?? 0));
      const flag = await serial(id, async () => {
        const n = (readFlagsIn(dir).at(-1)?.n ?? 0) + 1;
        const steps = readSteps(dir);
        const step = stepAt(steps, time * 1000);
        const shot = await shotFor(id, dir, n, source, time);
        const url0 = isLive ? l!.url : steps.find((s) => s.n === step)?.url ?? "";
        const f = appendFlag(dir, { kind, step, time: Math.round(time * 100) / 100, at: new Date().toISOString(), note: String(b.note ?? "").slice(0, 500), screenshot: shot, url: url0, source });
        if (meta?.endedAt) writeReport(dir);
        return f;
      });
      // Already counting down to send? Then this one goes too, and the person gets their ten seconds again.
      if (fixes.has(id)) scheduleFix(id);
      push(id);
      return json(res, 200, { flag });
    }

    if (sub === "note" && req.method === "POST") {
      const b = await body<{ n?: number; note?: string }>();
      const f = await serial(id, async () => {
        const r = updateFlag(dir, Number(b.n), { note: String(b.note ?? "").slice(0, 500) });
        if (r && readMeta(dir)?.endedAt) writeReport(dir);
        return r;
      });
      push(id);
      return f ? json(res, 200, { flag: f }) : json(res, 404, { error: "no such flag" });
    }

    if (sub === "fix" && req.method === "POST") {
      if (l && !l.ended) return json(res, 409, { error: "the session is still running" });
      const pf = fixes.get(id) ?? scheduleFix(id);
      return json(res, 200, { pending: pf ? { sendAt: pf.sendAt, notes: pf.notes } : null });
    }
    if (sub === "fix/undo" && req.method === "POST") {
      const pf = fixes.get(id);
      if (pf) { clearTimeout(pf.timer); fixes.delete(id); }
      push(id);
      return json(res, 200, { undone: !!pf });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  return { handlePage, handleApi };
}

function writePart(res: http.ServerResponse, jpeg: Buffer) {
  res.write(`Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write("\r\n--frame\r\n");
}
