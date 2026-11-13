/** `dry` and `scout` for Mac apps. Dry has the web's strictness: it opens the
    app, performs every step on the real controls without recording, and
    fails a step with what the window showed. Like the web dry run, it really
    acts: use test data. */
import { Manifest } from "../manifest.js";
import type { DryResult } from "../dryrun.js";
import { describe, runFileOrCommandSeed } from "../record.js";
import { CuaSession } from "./cua.js";
import { requireReady } from "./native-doctor.js";
import { menusOf, openApp, perform, snapshot, targetsFor, visibleText, type Ctx } from "./native.js";


export async function dryNative(m: Manifest, manifestDir: string, log: (l: string) => void, opts: { seed?: boolean } = {}): Promise<DryResult> {
  requireReady();
  if (opts.seed !== false) for (const sd of m.seed) await runFileOrCommandSeed(sd, manifestDir, log);
  const s = await CuaSession.open();
  const lines: string[] = [];
  let failures = 0;
  try {
    const w = await openApp(s, m, log);
    const ctx: Ctx = { s, w, dry: true };
    const all = [...m.setup.map((st) => ({ st, tag: "setup" })), ...m.steps.map((st, i) => ({ st, tag: String(i).padStart(3, "0") }))];
    for (const { st, tag } of all) {
      try {
        await perform(ctx, st);
        const line = `✓ [${tag}] ${describe(st)}`;
        lines.push(line); log(line);
      } catch (e) {
        failures++;
        const line = `✗ [${tag}] ${describe(st)} — ${(e as Error).message.split("\n")[0]}`;
        lines.push(line); log(line);
        if (m.onFail !== "continue") break;
      }
    }
  } finally { await s.close(); }
  const ok = failures === 0;
  log(ok ? `dry run: all ${m.steps.length} steps resolved` : `dry run: ${failures} step(s) would fail`);
  return { ok, lines, failures };
}

/** The app's controls as manifest-ready targets: what an agent writes steps
    from, so its first draft points at controls that exist. */
export async function scoutApp(app: string, launch: "fresh" | "reuse" = "reuse"): Promise<string[]> {
  requireReady();
  const s = await CuaSession.open();
  try {
    const m = Manifest.parse({ name: "scout", app, launch, steps: [{ action: "wait", ms: 0 }] });
    const w = await openApp(s, m, () => {});
    const snap = await snapshot(s, w);
    const t = targetsFor(snap.elements);
    return [
      `${app} · ${t.length} control${t.length === 1 ? "" : "s"} in its window (${w.points.width}×${w.points.height} pt). Use these targets verbatim:`,
      ...t.slice(0, 120).map((x) => `- ${x.target}${x.actions.includes("AXPress") ? "" : x.role === "textbox" ? "  (type into it)" : ""}`),
      ...(t.length > 120 ? [`… and ${t.length - 120} more`] : []),
      ...(menusOf(snap.elements).length ? ["", `menus: ${menusOf(snap.elements).join(" · ")} — click one with role=menuitem[name="File"], then its item, e.g. role=menuitem[name="Save…"]`] : []),
      "",
      `the window shows: “${visibleText(snap.elements, 400)}”`,
    ];
  } finally { await s.close(); }
}
