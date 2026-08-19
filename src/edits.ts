/**
 * Apply structured edits to a manifest file, keeping its comments.
 *
 * The model never writes YAML back. It names an edit from a small vocabulary
 * and Retake makes the change with the document API — so a fix for "slower at
 * the end" cannot also rewrite the captions, and a person's earlier edits
 * survive. Each applied edit is described in one plain sentence for the UI.
 */
import fs from "node:fs";
import YAML from "yaml";
import { Manifest } from "./manifest.js";
import type { Edit } from "./describe.js";
import type { Take } from "./record.js";

export type Applied = { yaml: string; done: string[]; skipped: string[]; rerecord: boolean };

export function applyEdits(file: string, edits: Edit[]): Applied {
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  const done: string[] = [];
  const skipped: string[] = [];
  let rerecord = false;

  const steps = doc.get("steps") as YAML.YAMLSeq | undefined;
  const scene = (label: unknown) => steps?.items.find((it) => { const n = it as YAML.YAMLMap; return typeof n.get === "function" && n.get("action") === "scene" && n.get("label") === label; }) as YAML.YAMLMap | undefined;
  const step = (i: unknown) => { const n = steps?.items[Number(i)] as YAML.YAMLMap | undefined; return n && typeof n.get === "function" ? n : undefined; };
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : Number(v));

  for (const e of edits) {
    try {
      switch (e.op) {
        case "set_caption": { const n = scene(e.scene); if (!n) throw new Error(`no scene "${e.scene}"`); if (e.caption) n.set("caption", String(e.caption)); else n.delete("caption"); done.push(`Caption on “${e.scene}” → “${e.caption}”`); break; }
        case "set_camera": { const n = scene(e.scene); if (!n) throw new Error(`no scene "${e.scene}"`); const c = e.camera; if (c === "static") n.set("camera", "static"); else if (c === "auto") n.delete("camera"); else n.set("camera", { zoom: num(c) }); done.push(`Camera on “${e.scene}” → ${c === "auto" ? "auto" : c === "static" ? "none" : num(c) + "×"}`); break; }
        case "set_hold": { const n = scene(e.scene); if (!n) throw new Error(`no scene "${e.scene}"`); n.set("holdMs", num(e.holdMs)); done.push(`Hold “${e.scene}” for ${(num(e.holdMs) / 1000).toFixed(1)}s`); break; }
        case "set_trim": { const head = num(e.head ?? 0) || 0, tail = num(e.tail ?? 0) || 0; if (!head && !tail) doc.delete("trim"); else doc.set("trim", { head, tail }); done.push(`Trim ${head}s off the start, ${tail}s off the end`); break; }
        case "set_format": { doc.set("preset", String(e.preset)); done.push(`Format → ${e.preset}`); rerecord = true; break; }
        case "set_layout": { doc.set("layout", String(e.layout)); done.push(`Captions → ${e.layout}`); break; }
        case "set_cursor": { const c = String(e.cursor); if (c === "none") doc.set("cursor", false); else if (c === "touch") doc.set("cursor", { style: "touch" }); else doc.delete("cursor"); done.push(`Cursor → ${c}`); rerecord = true; break; }
        case "add_wait": { const i = Number(e.after); if (!steps || !steps.items[i]) throw new Error(`no step ${i}`); steps.items.splice(i + 1, 0, doc.createNode({ action: "wait", ms: num(e.ms) })); done.push(`Pause ${(num(e.ms) / 1000).toFixed(1)}s after step ${i}`); rerecord = true; break; }
        case "wait_for": {
          const i = Number(e.step); const n = step(i); if (!n || !steps) throw new Error(`no step ${i}`);
          const node = doc.createNode({ action: "waitFor", selector: String(e.selector), timeout: 30000 });
          if (n.get("action") === "wait") { steps.items.splice(i, 1, node); done.push(`Step ${i} now waits for ${e.selector} instead of a fixed pause`); }
          else { steps.items.splice(i + 1, 0, node); done.push(`Waits for ${e.selector} after step ${i}`); }
          rerecord = true; break;
        }
        case "set_wait": { const n = step(e.step); if (!n || n.get("action") !== "wait") throw new Error(`step ${e.step} is not a wait`); n.set("ms", num(e.ms)); done.push(`Wait at step ${e.step} → ${(num(e.ms) / 1000).toFixed(1)}s`); rerecord = true; break; }
        case "set_text": { const n = step(e.step); if (!n || !["type", "fill"].includes(String(n.get("action")))) throw new Error(`step ${e.step} does not type`); n.set("text", String(e.text)); done.push(`Step ${e.step} now types “${e.text}”`); rerecord = true; break; }
        case "replace_selector": { const n = step(e.step); if (!n || !n.has("selector")) throw new Error(`step ${e.step} has no selector`); n.set("selector", String(e.selector)); done.push(`Step ${e.step} now targets ${e.selector}`); rerecord = true; break; }
        case "delete_step": { const i = Number(e.step); if (!steps || !steps.items[i]) throw new Error(`no step ${i}`); const n = steps.items[i] as YAML.YAMLMap; const what = typeof n.get === "function" ? `${n.get("action")}${n.has("selector") ? " " + n.get("selector") : ""}` : `step ${i}`; steps.items.splice(i, 1); done.push(`Removed ${what}`); rerecord = true; break; }
        case "rerecord": { done.push("Recording again from scratch"); rerecord = true; break; }
        default: skipped.push(`unknown edit ${String((e as { op: string }).op)}`);
      }
    } catch (err) {
      skipped.push(`${e.op}: ${(err as Error).message}`);
    }
  }

  const yaml = doc.toString();
  const parsed = Manifest.safeParse(YAML.parse(yaml));
  if (!parsed.success) throw new Error("edit would make the manifest invalid: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (done.length) fs.writeFileSync(file, yaml);
  return { yaml, done, skipped, rerecord };
}

/** What the model needs to know about the last take, in plain text with the
    indexes and labels it must use. Secrets never appear (describe() redacts). */
export function receiptsFor(take: Take | null, manifestSteps: { action: string; label?: string; selector?: string; text?: string; ms?: number; caption?: string; secret?: boolean }[]): string {
  const lines: string[] = [];
  lines.push("Steps (index · action):");
  manifestSteps.forEach((s, i) => {
    let desc = s.action;
    if (s.action === "scene") desc = `scene "${s.label}"${s.caption ? ` — caption “${s.caption}”` : ""}`;
    else if (s.action === "wait") desc = `wait ${s.ms}ms`;
    else if (s.selector) desc = `${s.action} ${s.selector}${s.text && !s.secret ? ` “${s.text.slice(0, 40)}”` : ""}`;
    lines.push(`  ${i}: ${desc}`);
  });
  if (take) {
    lines.push("", `Last take: ${(take.duration - take.trimBefore).toFixed(1)}s, ${take.ok ? "all steps passed" : "some steps FAILED"}${take.partial ? ", partial" : ""}.`);
    const fails = take.timeline.filter((t) => !t.ok);
    if (fails.length) lines.push("Failed: " + fails.map((t) => `step ${t.index} (${t.summary}) — ${t.error}`).join("; "));
    const scenes = take.timeline.filter((t) => t.action === "scene");
    lines.push("Scene timings: " + scenes.map((s) => `${s.label}@${(s.start - take.trimBefore).toFixed(1)}s`).join(", "));
  }
  return lines.join("\n");
}
