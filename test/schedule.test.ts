/** A routine that runs itself. What goes to the machine's scheduler is pinned
    here — the time, the days, the PATH it will need, and that two workspaces
    never share a schedule — because a wrong schedule fails silently, at 9am,
    with nobody watching. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cronLine, describeSchedule, labelFor, parseAt, plistXml } from "../src/schedule.js";

const base = {
  label: labelFor("/Users/me/work/demos-ws"),
  program: ["/usr/local/bin/node", "/opt/retake/dist/cli.js", "routine", "run", "--scheduled", "-n", "1"],
  root: "/Users/me/work/demos-ws",
  log: "/Users/me/work/demos-ws/.retake/schedule.log",
  env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: "/Users/me" },
};

test("times are 24-hour HH:MM, nothing looser", () => {
  assert.deepEqual(parseAt("09:00"), { hour: 9, minute: 0 });
  assert.deepEqual(parseAt("7:30"), { hour: 7, minute: 30 });
  assert.throws(() => parseAt("9am"));
  assert.throws(() => parseAt("24:00"));
});

test("each workspace has its own schedule", () => {
  assert.notEqual(labelFor("/a/demos"), labelFor("/b/demos"));
  assert.equal(labelFor("/a/demos"), labelFor("/a/demos"));
  assert.match(labelFor("/Users/me/My Demos"), /^app\.retake\.routine\.my-demos\.[0-9a-f]{8}$/);
});

test("launchd gets a valid plist: the time, weekdays only, and the PATH the shell had", () => {
  const xml = plistXml({ ...base, spec: { every: "weekdays", at: "09:05", count: 1 } });
  assert.equal((xml.match(/<key>Weekday<\/key>/g) ?? []).length, 5);
  assert.match(xml, /<key>Hour<\/key><integer>9<\/integer><key>Minute<\/key><integer>5<\/integer>/);
  assert.match(xml, /\/opt\/homebrew\/bin/);
  assert.match(xml, /<string>--scheduled<\/string>/);
  if (process.platform === "darwin") {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retake-plist-")), "x.plist");
    fs.writeFileSync(f, xml);
    assert.equal(spawnSync("plutil", ["-lint", f]).status, 0, "plutil rejects the plist");
  }
  const daily = plistXml({ ...base, spec: { every: "daily", at: "18:30", count: 2 } });
  assert.ok(!daily.includes("Weekday"));
});

test("cron gets one line that it can be removed by", () => {
  const line = cronLine({ ...base, spec: { every: "weekdays", at: "09:00", count: 1 } });
  assert.match(line, /^0 9 \* \* 1-5 cd '\/Users\/me\/work\/demos-ws' && PATH='/);
  assert.ok(line.endsWith(`# ${base.label}`));
  assert.match(line, />> '\/Users\/me\/work\/demos-ws\/\.retake\/schedule\.log' 2>&1/);
});

test("the schedule says itself in words", () => {
  assert.equal(describeSchedule({ every: "weekdays", at: "09:00", count: 1 }), "every weekday at 09:00, one video");
  assert.equal(describeSchedule({ every: "daily", at: "18:30", count: 3 }), "every day at 18:30, up to 3 videos");
});
