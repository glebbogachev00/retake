/** App demos, sprint 1: a demo can name a Mac app instead of a URL, and
    `validate` says plainly what an app cannot do. Nothing records yet. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Manifest } from "../src/manifest.js";
import { appAddress, isAppAddress, nativeTargetProblem, parseNativeTarget } from "../src/native-target.js";
import { dryRun } from "../src/dryrun.js";

const textedit = {
  name: "textedit-note",
  title: "Write a note",
  app: "TextEdit",
  launch: "fresh",
  seed: [{ kind: "command", run: "true" }],
  steps: [
    { action: "scene", label: "start", caption: "An empty note" },
    { action: "click", selector: 'role=textbox[name="First Text View"]' },
    { action: "type", selector: "role=textbox >> nth=0", text: "Hello" },
    { action: "waitFor", selector: 'role=text[name="Hello"]' },
    { action: "keyboard", key: "Enter" },
    { action: "scene", label: "end", caption: "Written" },
  ],
};
const problems = (m: unknown) => {
  const r = Manifest.safeParse(m);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

test("an app demo parses, and gets an app:// address everything else can read", () => {
  const r = Manifest.safeParse(textedit);
  assert.ok(r.success, problems(textedit).join("\n"));
  assert.equal(r.data.app, "TextEdit");
  assert.equal(r.data.launch, "fresh");
  assert.equal(r.data.url, "app://TextEdit");
  assert.ok(isAppAddress(r.data.url));
  assert.equal(appAddress("com.indepth.hub"), "app://com.indepth.hub");
});

test("a demo names a web page or an app, exactly one", () => {
  assert.match(problems({ ...textedit, url: "http://localhost:3000" }).join(), /either `url:` .* or `app:` .*, not both/);
  const { app: _a, ...neither } = textedit;
  assert.match(problems({ ...neither, launch: undefined }).join(), /give `url:` \(a web page\) or `app:`/);
  assert.match(problems({ name: "web", url: "http://localhost:3000", launch: "fresh", steps: [{ action: "wait", ms: 10 }] }).join(), /`launch:` is for app demos/);
});

test("web demos are exactly as before", () => {
  const r = Manifest.safeParse({ name: "web", url: "http://localhost:3000", steps: [{ action: "click", selector: "#go" }] });
  assert.ok(r.success);
  assert.equal(r.data.url, "http://localhost:3000");
  assert.equal(r.data.app, undefined);
});

test("browser-only actions are refused, with what to do instead", () => {
  const with_ = (step: object) => problems({ ...textedit, steps: [...textedit.steps, step] }).join("\n");
  assert.match(with_({ action: "navigate", url: "http://x" }), /no URLs in an app; click the control/);
  assert.match(with_({ action: "evaluate", script: "1" }), /no page to run script in/);
  assert.match(with_({ action: "hover", selector: "role=button" }), /hovering is not supported in apps yet/);
  assert.match(problems({ ...textedit, setup: [{ action: "navigate", url: "http://x" }] }).join(), /setup\.0\.action/);
});

test("browser settings are refused by name", () => {
  for (const [key, value, why] of [
    ["viewport", { width: 800, height: 600 }, /sized from the preset/],
    ["scale", 2, /display's own scale/],
    ["auth", { storageState: ".auth/x.json" }, /sign in with steps/],
    ["persistentCss", "body{}", /no CSS/],
    ["reducedMotion", true, /System Settings/],
    ["stub", [{ url: "**/api", body: "{}" }], /cannot be stubbed/],
  ] as const) {
    assert.match(problems({ ...textedit, [key]: value }).join("\n"), why, key);
  }
  assert.match(problems({ ...textedit, seed: [{ kind: "evaluate", script: "1" }] }).join(), /use a `command` seed/);
});

test("targets are role and name, not CSS, and say how to write one", () => {
  assert.deepEqual(parseNativeTarget('role=button[name="Sign in"]'), { role: "button", name: "Sign in" });
  assert.deepEqual(parseNativeTarget("role=textbox >> nth=1"), { role: "textbox", nth: 1 });
  assert.deepEqual(parseNativeTarget("role=AXDisclosureTriangle[name='Details']"), { role: "AXDisclosureTriangle", name: "Details" });
  assert.equal(parseNativeTarget("#login"), null);
  assert.match(nativeTargetProblem("button:has-text('Go')")!, /An app has no CSS: write role=<role>\[name="<name>"\]/);
  assert.match(nativeTargetProblem("role=widget")!, /not a role Retake knows in an app/);
  const css = problems({ ...textedit, steps: [{ action: "click", selector: "#go" }] }).join();
  assert.match(css, /steps\.0\.selector: .*An app has no CSS/);
});

test("an app demo cannot be dry-run or recorded yet, and says so", async () => {
  const m = Manifest.parse(textedit);
  await assert.rejects(() => dryRun(m, process.cwd(), () => {}), /Recording Mac apps is not built yet/);
});
