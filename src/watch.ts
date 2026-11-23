/**
 * Watch mode: a person watches an AI test their app, and stops it on any
 * moment that works but does not look clear.
 *
 * The test script keeps its own browser. It hands its Playwright page to
 * `startWatch`, says what it is about to do before each step and how it went
 * after, and Retake does the rest: the live picture in the window, the pace
 * the person chose, the masks over secrets, and a folder that holds the whole
 * session — video, steps, the person's flags and a plain report.
 *
 *   import { startWatch } from "<retake>/dist/watch.js";
 *   const w = await startWatch(page, { title: "Client portal – licences", ui: "http://localhost:4311" });
 *   await w.scenario("L4 Licence running out");
 *   await w.step("Click Renew", "The request form opens, already filled in");
 *   await page.click("text=Renew");
 *   await w.result(true, "Form pre-filled: Survey Suite, 1 seat");
 *   await w.beat();
 *   const { dir, flags } = await w.end();
 *
 * Nothing here launches a browser or imports Playwright at run time: the page
 * is the script's, from whichever Playwright it uses.
 *
 * The window is optional. Without one, the session still records, paces
 * itself at Watch speed, and writes its folder.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CDPSession, Locator, Page } from "playwright";
import { PKG_ROOT } from "./paths.js";
import {
  MaskList, WATCH_INTENT_MS, concatList, gateDecision, isCssSelector, isSpeed, jpegSize, readFlagsIn, sessionId,
  runFix, writeFixRequest, writeMeta, writeReport, writeSteps, writeFlagsIn,
  type FlagRecord, type SessionMeta, type Speed, type StepRecord,
} from "./watch/session.js";
import { CURSOR_SCRIPT, maskScript } from "./watch/page-scripts.js";

export type WatchOptions = {
  title: string;
  /** The Retake window to show the session in. `false` for none. Default: $RETAKE_UI, else http://localhost:4310. */
  ui?: string | false;
  /** Where outputs/ is. Sessions go to <out>/watch/<id>/. Default: the window's, else $RETAKE_OUT, else Retake's own outputs/. */
  out?: string;
  /** Hidden from the first frame, before anything is shown. Same as calling mask() at once. */
  mask?: MaskTarget | MaskTarget[];
  /** Off unless given: when the person's notes go out as a fix request, run
      this command in this repo with the brief on stdin. */
  fix?: { repo: string; command: string };
};

export type MaskTarget = string | Locator;

export type Watch = {
  /** The session folder. */
  readonly dir: string;
  /** The window's link to this session, when there is a window. */
  readonly link: string | null;
  scenario(name: string): Promise<void>;
  step(intent: string, expect: string): Promise<void>;
  result(ok: boolean, note?: string): Promise<void>;
  beat(): Promise<void>;
  mask(target: MaskTarget | MaskTarget[]): Promise<void>;
  unmask(target: MaskTarget | MaskTarget[]): Promise<void>;
  end(): Promise<{ dir: string; flags: FlagRecord[] }>;
};

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const say = (l: string) => process.stdout.write(`retake watch: ${l}\n`);

type Control = { speed: Speed; next: number; hold: boolean };

/** The window, from the script's side. Every call is best-effort and short:
    a window that is closed or restarting must never stop a test. */
class WindowLink {
  token = "";
  ok = false;
  state: Control = { speed: "watch", next: 0, hold: false };
  rejoin: (() => Promise<boolean>) | null = null;
  rejoined = 0;
  constructor(readonly base: string) {}

  private headers() { return { "content-type": "application/json", "x-retake-token": this.token }; }

  /** The window inlines its token into its own page, which only a local
      process (or the window itself) can read. */
  async connect(): Promise<{ out: string } | null> {
    try {
      const page = await fetch(`${this.base}/watch`, { signal: AbortSignal.timeout(1500) }).then((r) => r.text());
      const m = /__retakeToken=("[^"]+")/.exec(page);
      if (!m) return null;
      this.token = JSON.parse(m[1]) as string;
      const where = await this.get<{ out: string; speed: Speed }>("/api/watch/where");
      if (!where) return null;
      if (isSpeed(where.speed)) this.state.speed = where.speed;
      this.ok = true;
      return where;
    } catch { return null; }
  }

  async get<T>(p: string, timeoutMs = 2000): Promise<T | null> {
    try {
      const r = await fetch(this.base + p, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? ((await r.json()) as T) : null;
    } catch { return null; }
  }

  async post<T>(p: string, body: unknown, timeoutMs = 3000): Promise<T | null> {
    if (!this.token) return null;
    try {
      const r = await fetch(this.base + p, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) {
        // The window was restarted and no longer knows this session: say hello again, then retry once.
        if ((r.status === 401 || r.status === 404 || r.status === 409) && this.rejoin && !p.endsWith("/sessions") && Date.now() - this.rejoined > 5000) {
          this.rejoined = Date.now();
          if (await this.rejoin()) return this.post<T>(p, body, timeoutMs);
        }
        return null;
      }
      const v = (await r.json()) as T & Partial<Control>;
      this.take(v);
      return v;
    } catch { return null; }
  }

  take(v: Partial<Control> | null) {
    if (!v) return;
    if (isSpeed(v.speed)) this.state.speed = v.speed;
    if (typeof v.next === "number") this.state.next = v.next;
    if (typeof v.hold === "boolean") this.state.hold = v.hold;
  }
}

function isLocator(t: unknown): t is Locator {
  return !!t && typeof t === "object" && typeof (t as Locator).evaluateAll === "function";
}

export async function startWatch(page: Page, opts: WatchOptions): Promise<Watch> {
  const title = String(opts?.title ?? "").trim() || "Watch session";
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();

  // ---- where it goes, and whether anybody is watching ----
  const uiBase = opts.ui === false ? null : String(opts.ui || process.env.RETAKE_UI || "http://localhost:4310").replace(/\/+$/, "");
  const link = uiBase ? new WindowLink(uiBase) : null;
  const where = link ? await link.connect() : null;
  const outRoot = path.resolve(opts.out ?? process.env.RETAKE_OUT ?? where?.out ?? (process.env.RETAKE_ROOT ? path.join(process.env.RETAKE_ROOT, "outputs") : path.join(PKG_ROOT, "outputs")));
  const watchRoot = path.join(outRoot, "watch");
  fs.mkdirSync(watchRoot, { recursive: true });
  const id = sessionId(title, new Date(t0), (x) => fs.existsSync(path.join(watchRoot, x)));
  const dir = path.join(watchRoot, id);
  const framesDir = path.join(dir, ".frames");
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const meta: SessionMeta = { id, title, startedAt, endedAt: null, video: null };
  const steps: StepRecord[] = [];
  writeMeta(dir, meta);
  writeSteps(dir, steps);
  writeFlagsIn(dir, []);

  const ui = link?.ok ? link : null;
  const sessionLink = ui ? `${ui.base}/watch/${id}` : null;
  say(`session folder ${dir}`);
  if (sessionLink) say(`watch it live at ${sessionLink}`);
  else if (uiBase) say(`no Retake window at ${uiBase} — recording without a live view`);

  const context = page.context();
  const now = () => Date.now() - t0;

  // ---- masks: in the page before anything is shown ----
  const css = new MaskList();
  const marked: { target: Locator; key: string; css: string }[] = [];
  let markN = 0;
  const everyFrame = async (script: string) => { await Promise.all(page.frames().map((f) => f.evaluate(script).catch(() => {}))); };
  const markLocators = async () => {
    for (const m of marked) {
      await m.target.evaluateAll((els, key) => {
        for (const e of els) {
          const have = (e.getAttribute("data-retake-mask") ?? "").split(/\s+/).filter(Boolean);
          if (!have.includes(key)) e.setAttribute("data-retake-mask", [...have, key].join(" "));
        }
      }, m.key).catch(() => {});
    }
  };
  const painted = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(null))))).catch(() => {});

  const addMask = async (targets: MaskTarget[]) => {
    const add: string[] = [];
    for (const t of targets) {
      if (typeof t === "string" && isCssSelector(t)) { if (css.add(t)) add.push(t.trim()); continue; }
      const target = typeof t === "string" ? page.locator(t) : t;
      if (marked.some((m) => m.target === target)) continue;
      const key = `m${++markN}`;
      const sel = `[data-retake-mask~="${key}"]`;
      marked.push({ target, key, css: sel });
      css.add(sel);
      add.push(sel);
    }
    if (!add.length) return;
    const script = maskScript({ add });
    await context.addInitScript(script);
    await everyFrame(script);
    await markLocators();
    await painted();
  };
  const removeMask = async (targets: MaskTarget[]) => {
    const remove: string[] = [];
    for (const t of targets) {
      if (typeof t === "string" && isCssSelector(t)) { if (css.remove(t)) remove.push(t.trim()); continue; }
      const i = marked.findIndex((m) => m.target === t || (typeof t === "string" && String(m.target) === String(page.locator(t))));
      if (i < 0) continue;
      const [m] = marked.splice(i, 1);
      css.remove(m.css);
      remove.push(m.css);
    }
    if (!remove.length) return;
    const script = maskScript({ remove });
    await context.addInitScript(script);
    await everyFrame(script);
    await painted();
  };

  if (opts.mask) await addMask(Array.isArray(opts.mask) ? opts.mask : [opts.mask]);
  await context.addInitScript(CURSOR_SCRIPT);
  await page.evaluate(CURSOR_SCRIPT).catch(() => {});
  // A page that navigates gets its locator masks marked again as soon as it has a DOM.
  const onLoad = () => { void markLocators(); };
  page.on("domcontentloaded", onLoad);

  // ---- the live picture ----
  const frames: { file: string; t: number }[] = [];
  const writing = new Set<Promise<void>>();
  let latest: Buffer | null = null;
  let lastFrameAt = 0;
  let frameCount = 0;
  let sending = false;
  let pendingFrame: { data: string; url: string } | null = null;
  const sendFrame = async (f: { data: string; url: string }) => {
    if (!ui) return;
    if (sending) { pendingFrame = f; return; }
    sending = true;
    await ui.post(`/api/watch/${id}/frame`, f, 2000);
    sending = false;
    if (pendingFrame) { const next = pendingFrame; pendingFrame = null; void sendFrame(next); }
  };

  let cdp: CDPSession | null = null;
  try {
    cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
      cdp?.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
      const buf = Buffer.from(ev.data, "base64");
      const n = frames.length + 1;
      const file = `.frames/${String(n).padStart(6, "0")}.jpg`;
      frames.push({ file, t: now() });
      const w = fs.promises.writeFile(path.join(dir, file), buf).catch(() => {});
      writing.add(w);
      void w.finally(() => writing.delete(w));
      latest = buf; lastFrameAt = Date.now(); frameCount++;
      void sendFrame({ data: ev.data, url: page.url() });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 });
  } catch (e) {
    meta.problem = `The live picture could not start (${(e as Error).message.split("\n")[0]}), so there is no video; steps and screenshots are still kept.`;
    writeMeta(dir, meta);
    say(meta.problem);
  }

  // ---- steps ----
  let scenario: string | null = null;
  let current: StepRecord | null = null;
  let armed: { step: StepRecord; since: number } | null = null;
  let gateDue = false;
  let consumed = 0;
  let ended = false;

  const event = (kind: string, extra: Record<string, unknown> = {}) =>
    ui ? ui.post(`/api/watch/${id}/event`, { kind, url: page.url(), ...extra }) : Promise.resolve(null);

  const register = () => (ui ? ui.post<{ ok: boolean; next: number }>("/api/watch/sessions", { id, dir, title, startedAt, fix: opts.fix ?? null }) : Promise.resolve(null));
  const registered = await register();
  if (registered) consumed = registered.next ?? 0;
  if (ui) ui.rejoin = async () => {
    // A new window has a new token, read off its page.
    const again = await ui.connect();
    const r = again ? await register() : null;
    if (r) consumed = r.next ?? 0;
    return !!r;
  };

  const saveShot = (s: StepRecord, buf: Buffer) => {
    const rel = `shots/step-${String(s.n).padStart(2, "0")}.jpg`;
    fs.writeFileSync(path.join(dir, rel), buf);
    s.screenshot = rel;
    writeSteps(dir, steps);
    void event("shot", { step: s.n, screenshot: rel });
  };

  // The step's picture is the screen once the action it starts has settled:
  // the first change after the step began, then half a second of stillness.
  const settle = setInterval(() => {
    if (!armed || !latest) return;
    if (frameCount > armed.since && Date.now() - lastFrameAt >= 500) {
      const s = armed.step;
      armed = null;
      if (!s.screenshot) saveShot(s, latest);
    }
  }, 120);
  // Locator masks are found again a few times a second: anything the page
  // adds later is covered within a frame or two.
  const remark = setInterval(() => { if (marked.length) void markLocators(); }, 250);
  // The window counts a session as gone when its script falls silent.
  const heartbeat = setInterval(() => { void event("ping"); }, 10_000);
  settle.unref?.(); remark.unref?.(); heartbeat.unref?.();

  /** The pause between steps, at the person's pace. */
  const gate = async () => {
    gateDue = false;
    const began = Date.now();
    // A window that stops answering mid-pause must not hold the test forever:
    // the rest of this pause is Watch pace.
    let offline = !ui;
    for (;;) {
      const st = ui && !offline ? ui.state : { speed: "watch" as Speed, next: 0, hold: false };
      const d = gateDecision({ speed: st.speed, elapsedMs: Date.now() - began, pressed: !offline && st.next > consumed, hold: st.hold, ui: !offline });
      if (d.go) { if (!offline) consumed = Math.max(consumed, st.next); return; }
      if (!ui || offline) { await sleep(d.waitMs); continue; }
      const r = await ui.get<Control>(`/api/watch/${id}/wait?after=${consumed}&ms=${Math.ceil(d.waitMs)}`, d.waitMs + 3000);
      if (r) { ui.take(r); continue; }
      if (!(await event("ping"))) offline = true;     // a restarted window is rejoined by the ping
    }
  };

  const closeCurrent = () => {
    if (!current) return;
    current.endedAt = new Date().toISOString();
    current.tEnd = now();
    current = null;
    armed = null;
  };

  const shoot = async (s: StepRecord) => {
    if (s.screenshot) return;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 70, timeout: 5000 });
      saveShot(s, buf);
    } catch {
      if (latest) saveShot(s, latest);
    }
  };

  const w: Watch = {
    dir,
    link: sessionLink,

    async scenario(name: string) {
      scenario = String(name ?? "").trim() || null;
      await event("scenario", { scenario });
    },

    async step(intent: string, expect: string) {
      if (ended) throw new Error("this watch session has ended");
      if (gateDue) await gate();
      if (current) closeCurrent();
      const s: StepRecord = {
        n: steps.length + 1, scenario, intent: String(intent ?? ""), expect: String(expect ?? ""),
        result: null, note: "", startedAt: new Date().toISOString(), endedAt: null, t: now(), tEnd: null, url: page.url(), screenshot: null,
      };
      steps.push(s);
      current = s;
      writeSteps(dir, steps);
      await event("step", { step: s });
      if ((ui?.state.speed ?? "watch") !== "fast") await sleep(WATCH_INTENT_MS);
      armed = { step: s, since: frameCount };
    },

    async result(ok: boolean, note = "") {
      if (ended) throw new Error("this watch session has ended");
      let s = current ?? steps.at(-1) ?? null;
      if (!s) {
        s = { n: 1, scenario, intent: String(note || "Check"), expect: "", result: null, note: "", startedAt: new Date().toISOString(), endedAt: null, t: now(), tEnd: null, url: page.url(), screenshot: null };
        steps.push(s);
      }
      await shoot(s);
      s.result = ok ? "pass" : "fail";
      s.note = String(note ?? "");
      s.url = page.url();
      if (current === s) closeCurrent();
      else { s.endedAt ??= new Date().toISOString(); s.tEnd ??= now(); }
      writeSteps(dir, steps);
      await event("result", { step: s });
      gateDue = true;
    },

    async beat() {
      if (ended) return;
      await gate();
    },

    async mask(target) { await addMask(Array.isArray(target) ? target : [target]); },
    async unmask(target) { await removeMask(Array.isArray(target) ? target : [target]); },

    async end() {
      if (ended) return { dir, flags: readFlagsIn(dir) };
      ended = true;
      if (current) { const s = current as StepRecord; await shoot(s); closeCurrent(); writeSteps(dir, steps); }
      clearInterval(settle); clearInterval(remark); clearInterval(heartbeat);
      page.off("domcontentloaded", onLoad);
      const endMs = now();
      if (cdp) {
        await cdp.send("Page.stopScreencast").catch(() => {});
        await cdp.detach().catch(() => {});
      }
      await Promise.all([...writing]);
      await event("ending");

      // The video, from the frames as they arrived.
      if (!frames.length && !page.isClosed()) {
        try { fs.writeFileSync(path.join(framesDir, "000001.jpg"), await page.screenshot({ type: "jpeg", quality: 70 })); frames.push({ file: ".frames/000001.jpg", t: 0 }); } catch { /* no picture at all */ }
      }
      if (frames.length) {
        try {
          await encode(dir, frames, endMs);
          meta.video = "session.mp4";
          fs.rmSync(framesDir, { recursive: true, force: true });
        } catch (e) {
          meta.problem = `The video could not be made (${(e as Error).message.split("\n")[0]}); the frames are kept in .frames/.`;
          say(meta.problem);
        }
      }
      meta.endedAt = new Date().toISOString();
      writeMeta(dir, meta);
      writeReport(dir);

      // The person's notes go to whoever fixes things. The window gives them
      // ten seconds to take it back; with no window, they go now.
      const told = ui ? await event("end", { video: meta.video }) : null;
      if (!told) {
        const sent = writeFixRequest(dir);
        if (sent) {
          say(`${sent.notes} note${sent.notes === 1 ? "" : "s"} sent to fix: ${sent.md}`);
          if (opts.fix) runFix(opts.fix, sent.md);
        }
        writeReport(dir);
      }
      const flags = readFlagsIn(dir);
      say(`done — ${steps.length} steps, ${flags.length} flagged. ${path.join(dir, "report.md")}`);
      return { dir, flags };
    },
  };
  return w;
}

/** frames → session.mp4, with Retake's own ffmpeg. */
async function encode(dir: string, frames: { file: string; t: number }[], endMs: number): Promise<void> {
  const { ffmpegBin } = await import("./media-bin.js");
  const list = path.join(dir, ".frames", "list.ffconcat");
  fs.writeFileSync(list, concatList(frames.map((f) => ({ file: path.basename(f.file), t: f.t })), endMs));
  const first = jpegSize(fs.readFileSync(path.join(dir, frames[0].file)));
  const W = Math.max(2, Math.floor((first?.width ?? 1280) / 2) * 2), H = Math.max(2, Math.floor((first?.height ?? 720) / 2) * 2);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=white,fps=15,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", path.join(dir, "session.mp4")];
  await new Promise<void>((ok, no) => {
    const p = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c: Buffer) => { err += c; });
    p.on("error", no);
    p.on("close", (code) => (code === 0 ? ok() : no(new Error(err.trim().split("\n").pop() || `ffmpeg exited ${code}`))));
  });
}
