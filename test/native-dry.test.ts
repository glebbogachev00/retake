/** App demos, sprint 3: finding controls, listing them for scout, and
    performing each step on the exact control. Runs against a fake session;
    the real TextEdit dry run is checked by hand (see the sprint notes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { find, menusOf, perform, targetsFor, visibleText, type Ctx, type El } from "../src/drivers/native.js";
import { Manifest } from "../src/manifest.js";
import { parseNativeTarget } from "../src/native-target.js";
import type { CuaSession } from "../src/drivers/cua.js";

const els: El[] = [
  { role: "AXWindow", label: "note.txt", element_token: "w" },
  { role: "AXTextArea", label: "First Text View", element_token: "t1", actions: ["AXShowMenu"], frame: { x: 40, y: 92, w: 960, h: 500 } },
  { role: "AXButton", label: "Save", element_token: "b1", actions: ["AXPress"] },
  { role: "AXButton", label: "Save", element_token: "b2", actions: ["AXPress"] },
  { role: "AXButton", element_token: "b3", actions: ["AXPress"] },
  { role: "AXStaticText", value: "Saved", element_token: "s1" },
  { role: "AXMenuBarItem", label: "Apple", element_token: "m0" },
  { role: "AXMenuBarItem", label: "File", element_token: "m1" },
  { role: "AXMenuItem", label: "Recent Items", element_token: "m2" },
];

test("a target finds its control by role, name and position", () => {
  assert.equal(find(els, parseNativeTarget('role=textbox[name="First Text View"]')!)?.element_token, "t1");
  assert.equal(find(els, parseNativeTarget('role=button[name="Save"] >> nth=1')!)?.element_token, "b2");
  assert.equal(find(els, parseNativeTarget('role=text[name="Saved"]')!)?.element_token, "s1", "plain text is named by what it says");
  assert.equal(find(els, parseNativeTarget('role=button[name="Sign in"]')!), undefined);
});

test("scout lists the window's controls, unique first, menus apart, and never the Apple menu", () => {
  const t = targetsFor(els).map((x) => x.target);
  assert.deepEqual(t, ["role=textbox", "role=button", 'role=text[name="Saved"]', 'role=button[name="Save"]', 'role=button[name="Save"] >> nth=1']);
  // A text area named after its contents is listed by order: the name would
  // change as the demo types, and copy the document into the demo file.
  const typed = targetsFor([{ role: "AXTextArea", label: "Dear Sam, the contract…", value: "Dear Sam, the contract…", element_token: "t" }, { role: "AXTextField", label: "E-mail", value: "", element_token: "f" }]);
  assert.deepEqual(typed.map((x) => [x.target, x.hint]), [["role=textbox", undefined], ["role=textbox >> nth=1", "E-mail"]]);
  assert.ok(!JSON.stringify(typed).includes("Dear Sam"));
  assert.ok(!t.some((x) => /menu/i.test(x)));
  assert.deepEqual(menusOf(els), ["File"]);
  assert.ok(!visibleText(els).includes("Recent Items"));
  for (const x of t) assert.ok(Manifest.safeParse({ name: "x", app: "TextEdit", steps: [{ action: "click", selector: x }] }).success, `${x} is a target a manifest accepts`);
});

function fakeCtx(state: El[] = els) {
  const calls: [string, Record<string, unknown>][] = [];
  const s = {
    async call(tool: string, args: Record<string, unknown> = {}) {
      calls.push([tool, args]);
      if (tool === "get_window_state") return { elements: state, window_bounds: { x: 40, y: 60, width: 960, height: 540 }, screenshot_width: 1920 };
      return {};
    },
  } as unknown as CuaSession;
  const ctx: Ctx = { s, w: { pid: 7, windowId: 70, scale: 2, points: { width: 960, height: 540 } }, dry: true };
  return { ctx, calls: () => calls.filter(([t]) => t !== "get_window_state") };
}

test("each step goes to the exact control", async () => {
  const { ctx, calls } = fakeCtx();
  await perform(ctx, { action: "click", selector: 'role=button[name="Save"]' } as never);
  await perform(ctx, { action: "click", selector: 'role=textbox[name="First Text View"]' } as never);
  await perform(ctx, { action: "type", selector: "role=textbox", text: "Hi" } as never);
  await perform(ctx, { action: "keyboard", key: "Enter" } as never);
  await perform(ctx, { action: "keyboard", key: "Meta+S" } as never);
  await perform(ctx, { action: "fill", selector: "role=textbox", text: "All new" } as never);
  assert.deepEqual(calls(), [
    ["click", { pid: 7, window_id: 70, element_token: "b1" }],
    // A text area cannot be pressed: a real click at its centre, in screenshot pixels.
    ["click", { pid: 7, window_id: 70, x: 960, y: 564 }],
    ["type_text", { pid: 7, window_id: 70, element_token: "t1", text: "Hi" }],
    // Return in a text control is text: it reaches a background window
    // where a key event is refused. Other keys go to that control, never "the app".
    ["type_text", { pid: 7, window_id: 70, element_token: "t1", text: "\n" }],
    ["hotkey", { pid: 7, window_id: 70, element_token: "t1", keys: ["cmd", "s"] }],
    ["set_value", { pid: 7, window_id: 70, element_token: "t1", value: "All new" }],
  ]);
});

test("Return on a button is a real key press, sent to that button", async () => {
  const { ctx, calls } = fakeCtx();
  await perform(ctx, { action: "click", selector: 'role=button[name="Save"]' } as never);
  await perform(ctx, { action: "keyboard", key: "Enter" } as never);
  assert.deepEqual(calls().at(-1), ["press_key", { pid: 7, window_id: 70, element_token: "b1", key: "return" }]);
});

test("a missing control fails with what the window shows", async () => {
  const { ctx } = fakeCtx();
  await assert.rejects(() => perform(ctx, { action: "click", selector: 'role=button[name="Sign in"]', timeout: 200 } as never), /no role=button\[name="Sign in"\] in the window — it shows: “note\.txt · First Text View · Save · Saved/);
  await assert.rejects(() => perform(ctx, { action: "waitFor", selector: 'role=text[name="Done"]', gone: false, timeout: 200 } as never), /never appeared after 0 s/);
  await perform(ctx, { action: "waitFor", selector: 'role=text[name="Done"]', gone: true, timeout: 200 } as never);
  await perform(ctx, { action: "waitFor", selector: 'role=text[name="Saved"]', gone: false, timeout: 200 } as never);
});

test("a dry run caps waits; validate checks a scroll's target too", async () => {
  const { ctx } = fakeCtx();
  const t = Date.now();
  await perform(ctx, { action: "wait", ms: 60_000 } as never);
  assert.ok(Date.now() - t < 2600);
  const r = Manifest.safeParse({ name: "x", app: "TextEdit", steps: [{ action: "scroll", to: ".list" }] });
  assert.ok(!r.success && /steps\.0\.to/.test(JSON.stringify(r.error.issues.map((i) => i.path.join(".")))));
});
