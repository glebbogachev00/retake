/**
 * Two areas, and nothing broken on the way there.
 *
 * `retake watch …` and `retake demo …` are the names now, but scripts,
 * schedules and agents have typed `retake run` and `retake verify` for months.
 * Every old top-level name has to keep running exactly what it ran: the same
 * action, the same options, the same exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { DEMO_AREA, DEMO_GROUPS, SENTENCE, SHARED, withAliases } from "../src/areas.js";

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "retake-areas-"));
const cli = (...a: string[]) => spawnSync(process.execPath, [tsx, path.resolve("src/cli.ts"), ...a], { cwd: root, encoding: "utf8", env: { ...process.env, RETAKE_ROOT: root, RETAKE_OUT: "" } });

test("every old top-level video command resolves to the same command under demo", () => {
  for (const name of DEMO_AREA) {
    assert.deepEqual(withAliases(["node", "retake", name, "x", "--flag"]), ["node", "retake", "demo", name, "x", "--flag"], name);
  }
  // `retake help verify` is `retake demo verify --help`.
  assert.deepEqual(withAliases(["node", "retake", "help", "verify"]), ["node", "retake", "demo", "verify", "--help"]);
  // The areas, the shared commands and the new names are left alone.
  for (const line of [["watch", "run", "all"], ["demo", "run", "x.yaml"], ...SHARED.map((s) => [s]), ["mcp"], ["--version"]]) {
    assert.deepEqual(withAliases(["node", "retake", ...line]), ["node", "retake", ...line], line.join(" "));
  }
  // `retake` alone is the help.
  assert.deepEqual(withAliases(["node", "retake"]), ["node", "retake", "--help"]);
});

test("no command is in two places at once", () => {
  const all = DEMO_GROUPS.flatMap(([, names]) => names);
  assert.equal(new Set(all).size, all.length, "a command is listed in two demo groups");
  for (const s of SHARED) assert.ok(!DEMO_AREA.has(s), `${s} is shared, so it stays top-level`);
  assert.ok(!DEMO_AREA.has("watch") && !DEMO_AREA.has("demo"));
});

test("`retake` and `retake --help` say the sentence, the two areas, and where the rest is — nothing else", () => {
  for (const args of [[], ["--help"]]) {
    const r = cli(...args);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines[0], SENTENCE);
    assert.equal(lines.at(-1), "retake watch --help / retake demo --help for the rest.");
    const watch = lines.filter((l) => l.startsWith("  retake watch "));
    const demo = lines.filter((l) => l.startsWith("  retake demo "));
    assert.equal(watch.length, 3, r.stdout);
    assert.equal(demo.length, 3, r.stdout);
    assert.ok(lines.indexOf("Watch: test your app") < lines.indexOf("Demos: videos of your app"), "Watch comes first");
    // Sentence, blank, two headed blocks of three, blank lines between, the pointer.
    assert.equal(lines.length, 1 + 1 + 4 + 1 + 4 + 1 + 1, r.stdout);
    assert.doesNotMatch(r.stdout, /Usage:|Options:/);
  }
});

test("each area's help lists its own commands, and the shared ones once", () => {
  const demo = cli("demo", "--help");
  assert.equal(demo.status, 0, demo.stderr);
  for (const [heading, names] of DEMO_GROUPS) {
    assert.match(demo.stdout, new RegExp(`^${heading}$`, "m"));
    for (const n of names) assert.match(demo.stdout, new RegExp(`^  ${n}\\b`, "m"), `${n} missing from demo --help`);
  }
  assert.match(demo.stdout, /^Shared: retake install · retake ui/m);
  const watch = cli("watch", "--help");
  assert.equal(watch.status, 0, watch.stderr);
  for (const n of ["sessions", "journeys", "run", "accept", "schedule"]) assert.match(watch.stdout, new RegExp(`^  ${n}\\b`, "m"));
  assert.ok(watch.stdout.indexOf("  sessions") < watch.stdout.indexOf("  run "), "sessions come before run");
  assert.doesNotMatch(watch.stdout, /^ {2}(verify|render)\b/m, "video commands stay out of Watch");
});

test("an old name behaves exactly as the new one: same output, same exit code", () => {
  const missing = path.join(root, "no-such-take");
  const old = cli("check", missing), now = cli("demo", "check", missing);
  assert.equal(old.status, 3);
  assert.equal(now.status, old.status);
  assert.equal(now.stdout, old.stdout);
  // A failing command keeps its exit code (1) and its message.
  const badOld = cli("validate", path.join(root, "nope.yaml")), badNew = cli("demo", "validate", path.join(root, "nope.yaml"));
  assert.equal(badOld.status, 1);
  assert.equal(badNew.status, 1);
  assert.equal(badNew.stderr, badOld.stderr);
  // `draft` is the MCP tool's name for describe; the CLI answers to both.
  assert.match(cli("demo", "draft", "--help").stdout, /Usage: retake demo describe\|draft/);
});

test("watch sessions and watch journeys answer on an empty workspace", () => {
  const s = cli("watch", "sessions");
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /no sessions yet/);
  const j = cli("watch", "journeys");
  assert.equal(j.status, 0, j.stderr);
  assert.match(j.stdout, /no journeys yet/);
});
