/**
 * A seed prepares data and exits. Starting a process is `start_app`'s job, and
 * that one is gated on the person's explicit say-so — so a seed command must
 * not become the way around that gate.
 *
 * These check both halves: the ordinary seed every demo uses still runs, and
 * the ways of leaving something behind do not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSeedCommand } from "../src/record.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "retake-seed-"));

test("an ordinary data seed runs and its effect lands", async () => {
  const dir = tmp();
  await runSeedCommand(`node -e "require('fs').writeFileSync('board.json','[]')"`, "seed board", dir);
  assert.equal(fs.readFileSync(path.join(dir, "board.json"), "utf8"), "[]");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failing seed reports the exit code, not a silent pass", async () => {
  const dir = tmp();
  await assert.rejects(() => runSeedCommand("node -e \"process.exit(3)\"", "bad seed", dir), /exit 3/);
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [cmd, why] of [
  ["npm run dev &", "trailing &"],
  ["nohup npm start", "nohup"],
  ["node server.js & echo started", "& before another command"],
  ["pm2 start server.js", "pm2"],
  ["tmux new-session -d 'npm run dev'", "tmux"],
] as const) {
  test(`refuses to background a seed: ${why}`, async () => {
    const dir = tmp();
    await assert.rejects(() => runSeedCommand(cmd, cmd, dir), /Refusing to run this seed command|start_app/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("a quoted URL's query string is not mistaken for backgrounding", async () => {
  const dir = tmp();
  // `?a=1&b=2` inside quotes is data. Refusing it would break real seeds.
  await runSeedCommand(`node -e "require('fs').writeFileSync('ok','1')" "http://x/api?a=1&b=2"`, "seed with a URL", dir);
  assert.equal(fs.existsSync(path.join(dir, "ok")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a seed that never exits is killed, and nothing survives it", async () => {
  const dir = tmp();
  // Writes its own pid, then sleeps far past the timeout. If the kill only
  // reached the shell, this pid would still be alive afterwards.
  const cmd = `node -e "require('fs').writeFileSync('pid','' + process.pid); setTimeout(()=>{}, 60000)"`;
  await assert.rejects(() => runSeedCommand(cmd, "hanging seed", dir, 1500), /did not finish within 2s|did not finish/);
  const pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `pid ${pid} outlived the seed — the timeout killed the shell but not its child`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the demos in this repo all still pass the gate", async () => {
  const dir = path.join(import.meta.dirname, "..", "demos");
  if (!fs.existsSync(dir)) return;
  const runs: string[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/kind:\s*command,\s*run:\s*"([^"]+)"/g)) runs.push(m[1]);
  }
  // Not executed — only checked against the refusal rules, so a real demo can
  // never be broken by tightening them.
  for (const r of runs) {
    await assert.doesNotReject(
      () => runSeedCommand(`node -e "0" # ${r.replace(/"/g, "")}`, r, os.tmpdir()).catch((e) => { if (/Refusing/.test(String(e.message))) throw e; }),
      `a real demo's seed would now be refused: ${r}`,
    );
  }
});
