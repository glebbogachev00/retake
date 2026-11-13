/** Driving a Mac app: open it at a known size, read its controls, find a
    step's target, and perform the step on that exact control.

    Every action goes to an element, never to "the app": cua-driver refuses
    keyboard input it cannot prove reaches one window (an app with a hidden
    second window is common), and an element is also what lets the app sit
    behind the person's own windows while it is driven.

    Loaded only by dynamic import, from dryrun.ts and record.ts. */
import { spawnSync } from "node:child_process";
import { expandEnv, resolve, type Manifest, type Step } from "../manifest.js";
import { NATIVE_ROLES, parseNativeTarget, type NativeTarget } from "../native-target.js";
import type { CuaSession } from "./cua.js";

export type El = { role: string; label?: string; value?: string; frame?: { x: number; y: number; w: number; h: number }; element_token: string; actions?: string[] };
export type Snapshot = { elements: El[]; window: { x: number; y: number; width: number; height: number }; shot: { width: number } };
export type AppWindow = { pid: number; windowId: number; scale: number; points: { width: number; height: number } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isBundleId = (app: string) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(app);
const osa = (script: string) => spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 15_000 });
const appRef = (app: string) => (isBundleId(app) ? `application id "${app}"` : `application "${app.replace(/"/g, "")}"`);

export function appRunning(app: string): boolean {
  return osa(`${appRef(app)} is running`).stdout.trim() === "true";
}

/** Quit the app so the take starts from a known state. A graceful quit, so
    an app with unsaved work asks instead of losing it; if it is still running
    after that, Retake stops and says so rather than force-quitting it. */
export async function quitApp(app: string): Promise<void> {
  if (!appRunning(app)) return;
  osa(`tell ${appRef(app)} to quit`);
  for (let i = 0; i < 40 && appRunning(app); i++) await sleep(250);
  if (appRunning(app)) throw new Error(`${app} did not quit, probably because it has unsaved work or a question open. Save or close it yourself, then run again — Retake will not force it closed.`);
}

/** Open the app and size its main window to the preset, in points. */
export async function openApp(s: CuaSession, m: Manifest, log: (l: string) => void): Promise<AppWindow> {
  const app = m.app!;
  const screen = await s.call<{ scale_factor?: number }>("get_screen_size");
  const scale = screen.scale_factor ?? 2;
  if (m.launch === "fresh") { log(`app: quitting ${app} to start it fresh`); await quitApp(app); }
  const launched = await s.call<{ pid?: number }>("launch_app", isBundleId(app) ? { bundle_id: app } : { name: app });
  // The main window: the largest on-screen window the app owns, once it has one.
  type W = { pid: number; window_id: number; app_name?: string; bounds: { width: number; height: number }; is_on_screen?: boolean; layer?: number };
  let win: W | undefined;
  for (let i = 0; i < 60 && !win; i++) {
    const all = (await s.call<{ windows: W[] }>("list_windows", launched.pid ? { pid: launched.pid } : {})).windows;
    win = all.filter((w) => (launched.pid ? w.pid === launched.pid : w.app_name === app) && w.is_on_screen !== false && (w.layer ?? 0) === 0)
      .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
    if (!win) await sleep(250);
  }
  if (!win) throw new Error(`${app} opened no window within 15 s. If it shows nothing until a file is open, add a \`command\` seed that opens one (e.g. open -a "${app}" ~/file).`);
  const q = resolve(m);
  const points = { width: Math.round(q.viewport.width / scale), height: Math.round(q.viewport.height / scale) };
  // A new window is listed before the app exposes it to accessibility: retry briefly.
  for (let i = 0; ; i++) {
    try { await s.call("set_window_frame", { pid: win.pid, window_id: win.window_id, x: 40, y: 60, ...points }); break; }
    catch (e) { if (i >= 30 || !/no matching AXWindow/.test((e as Error).message)) throw new Error(`${app}'s window could not be sized to ${points.width}×${points.height}: ${(e as Error).message}`); await sleep(250); }
  }
  log(`app: ${app} · window ${points.width}×${points.height} pt (${q.viewport.width}×${q.viewport.height} px at ${scale}×)`);
  return { pid: win.pid, windowId: win.window_id, scale, points };
}

/** The window's controls. Without the screenshot by default: reading the
    tree alone is ~1 s in TextEdit against ~3 s with the grab, and every step
    reads it. Only a pixel click needs the screenshot's coordinate space. */
export async function snapshot(s: CuaSession, w: AppWindow, o: { shot?: boolean } = {}): Promise<Snapshot> {
  const r = await s.call<{ elements?: El[]; window_bounds?: Snapshot["window"]; screenshot_width?: number }>("get_window_state", { pid: w.pid, window_id: w.windowId, ...(o.shot ? {} : { include_screenshot: false }) });
  return { elements: r.elements ?? [], window: r.window_bounds ?? { x: 40, y: 60, ...w.points }, shot: { width: r.screenshot_width ?? w.points.width * w.scale } };
}

/** The name a control goes by: its label, or for plain text, what it says. */
const nameOf = (e: El) => (e.label?.trim() || (e.role === "AXStaticText" ? e.value?.trim() : "") || "");
const webRole = (axRole: string) => Object.entries(NATIVE_ROLES).find(([, ax]) => ax.includes(axRole))?.[0];

export function find(els: El[], t: NativeTarget): El | undefined {
  const roles = NATIVE_ROLES[t.role] ?? [t.role];
  const hits = els.filter((e) => roles.includes(e.role) && (t.name === undefined || nameOf(e) === t.name));
  return hits[t.nth ?? 0];
}

const MENU = /^AX(MenuBar|MenuBarItem|Menu|MenuItem)$/;

/** The app's own menus, by name, without the Apple menu: that one lists the
    person's recent apps and documents, which do not belong in a demo file. */
export function menusOf(els: El[]): string[] {
  return [...new Set(els.filter((e) => e.role === "AXMenuBarItem").map(nameOf).filter((n) => n && n !== "Apple"))];
}

/** Every control in the window as a manifest-ready target, unique ones
    first. Menus are listed apart (menusOf): hundreds of menu items would
    bury the window's own controls. */
export function targetsFor(all: El[]): { target: string; role: string; name: string; actions: string[] }[] {
  const els = all.filter((e) => !MENU.test(e.role));
  const seen = new Map<string, number>();
  const out: { target: string; role: string; name: string; actions: string[]; dup: boolean }[] = [];
  for (const e of els) {
    const role = webRole(e.role) ?? (/^AX/.test(e.role) ? e.role : null);
    if (!role || role === "window") continue;
    const name = nameOf(e);
    const key = `${role}\0${name}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const base = name ? `role=${role}[name=${JSON.stringify(name)}]` : `role=${role}`;
    out.push({ target: n ? `${base} >> nth=${n}` : base, role, name, actions: e.actions ?? [], dup: n > 0 });
  }
  // A target is unique only if nothing after it shares its role and name.
  const unique = (t: (typeof out)[number]) => (seen.get(`${t.role}\0${t.name}`) ?? 0) === 1;
  return [...out.filter(unique), ...out.filter((t) => !unique(t))].map(({ dup: _d, ...t }) => t);
}

/** What the window shows, in a line: for "no such control", the answer to
    "what is there instead". */
export function visibleText(els: El[], max = 140): string {
  const words = [...new Set(els.filter((e) => !/Menu/.test(e.role)).map(nameOf).filter(Boolean))].join(" · ");
  return words.length > max ? words.slice(0, max - 1) + "…" : words;
}

const KEYS: Record<string, string> = { Enter: "return", Return: "return", Escape: "escape", Tab: "tab", Backspace: "delete", Delete: "forward_delete", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Space: "space", Home: "home", End: "end", PageUp: "page_up", PageDown: "page_down" };
const MODS: Record<string, string> = { Meta: "cmd", Command: "cmd", Cmd: "cmd", Control: "ctrl", Ctrl: "ctrl", Alt: "option", Option: "option", Shift: "shift" };

export type Ctx = { s: CuaSession; w: AppWindow; dry: boolean; last?: El; win?: Snapshot["window"]; /** screenshot px per window point, measured once */ shotScale?: number };

/** Perform one step on the app. Throws with what went wrong and what the
    window showed, the way the web dry run does. */
export async function perform(ctx: Ctx, step: Step): Promise<void> {
  const { s, w } = ctx;
  const target = async (selector: string, timeout = 8000): Promise<El> => {
    const t = parseNativeTarget(selector);
    if (!t) throw new Error(`"${selector}" is not an app target`);
    const until = Date.now() + timeout;
    let snap: Snapshot;
    do {
      snap = await snapshot(s, w);
      ctx.win = snap.window;
      const e = find(snap.elements, t);
      if (e) return e;
      await sleep(150);
    } while (Date.now() < until);
    throw new Error(`no ${selector} in the window — it shows: “${visibleText(snap.elements)}”`);
  };
  const base = { pid: w.pid, window_id: w.windowId };
  switch (step.action) {
    case "scene": case "screenshot": return;
    case "wait": await sleep(ctx.dry ? Math.min(step.ms, 2000) : step.ms); return;
    case "callout": if (step.selector) await target(step.selector); return;
    case "click": {
      if (!step.selector) throw new Error("clicking a point in an app is not built yet; give the control as a target");
      const e = await target(step.selector);
      if ((e.actions ?? []).includes("AXPress")) await s.call("click", { ...base, element_token: e.element_token });
      else {
        // Not every control can be "pressed" (a text area only offers its
        // menu): a real click at its centre, in the screenshot's pixels.
        if (!e.frame) throw new Error(`${step.selector} cannot be pressed and has no position to click`);
        // The screenshot's scale is fixed for the take: measured once, it
        // spares every later click a slow read with the screen grab.
        if (!ctx.shotScale || !ctx.win) { const snap = await snapshot(s, w, { shot: true }); ctx.shotScale = snap.shot.width / snap.window.width; ctx.win = snap.window; }
        const k = ctx.shotScale, at = ctx.win;
        await s.call("click", { ...base, x: Math.round((e.frame.x + e.frame.w / 2 - at.x) * k), y: Math.round((e.frame.y + e.frame.h / 2 - at.y) * k) });
      }
      ctx.last = e;
      return;
    }
    case "type": {
      const e = await target(step.selector);
      await s.call("type_text", { ...base, element_token: e.element_token, text: expandEnv(step.text) });
      ctx.last = e;
      return;
    }
    case "fill": {
      const e = await target(step.selector);
      await s.call("set_value", { ...base, element_token: e.element_token, value: expandEnv(step.text) });
      ctx.last = e;
      return;
    }
    case "keyboard": {
      const parts = step.key.split("+");
      const key = parts.pop()!;
      const mods = parts.map((p) => MODS[p] ?? p.toLowerCase());
      const name = KEYS[key] ?? key.toLowerCase();
      // Keys go to the control last acted on: sent to the app as a whole,
      // they may land in another of its windows, and the driver refuses them.
      // Its handle is re-read first: a handle from an earlier read is stale.
      let el = ctx.last;
      if (el) {
        // Matched by role and position, not name: a text area is often named
        // after what it contains, which the step before just changed.
        const now = (await snapshot(s, w)).elements;
        const same = (e: El) => e.role === el!.role && !!e.frame && !!el!.frame && e.frame.x === el!.frame.x && e.frame.y === el!.frame.y && e.frame.w === el!.frame.w;
        const fresh = now.find(same) ?? now.find((e) => e.role === el!.role && nameOf(e) === nameOf(el!)) ?? el;
        el = ctx.last = fresh;
        // Return and Tab in a text control are text: inserted the way typing
        // is, which reaches a background window when a key event would not.
        if (!mods.length && /TextArea|TextField/.test(el.role) && (name === "return" || name === "tab")) {
          await s.call("type_text", { ...base, element_token: el.element_token, text: name === "return" ? "\n" : "\t" });
          return;
        }
      }
      const at = el ? { element_token: el.element_token } : {};
      if (mods.length) await s.call("hotkey", { ...base, ...at, keys: [...mods, name] });
      else await s.call("press_key", { ...base, ...at, key: name });
      return;
    }
    case "scroll": {
      const to = typeof step.to === "string" && step.to !== "top" && step.to !== "bottom" ? await target(step.to) : null;
      const direction = step.to === "top" || (step.y ?? 0) < 0 ? "up" : "down";
      await s.call("scroll", { ...base, ...(to ? { element_token: to.element_token } : {}), direction, amount: Math.max(1, Math.round(Math.abs(step.y ?? 300) / 100)) });
      return;
    }
    case "waitFor": {
      const t = parseNativeTarget(step.selector);
      if (!t) throw new Error(`"${step.selector}" is not an app target`);
      const timeout = step.timeout ?? 10_000;
      const until = Date.now() + timeout;
      let snap: Snapshot;
      do {
        snap = await snapshot(s, w);
        if (!!find(snap.elements, t) !== step.gone) return;
        await sleep(150);
      } while (Date.now() < until);
      throw new Error(`${step.selector} ${step.gone ? "was still there" : "never appeared"} after ${Math.round(timeout / 1000)} s — the window shows: “${visibleText(snap.elements)}”`);
    }
    default:
      throw new Error(`\`${step.action}\` is not available in an app`);
  }
}
