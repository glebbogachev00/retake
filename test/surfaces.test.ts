/**
 * A feature agents cannot see does not exist.
 *
 * The whole `flag` / `fixed` / `unflag` loop was built, tested, demoed in the
 * window and released — with no MCP tool and no mention in a single document.
 * Agents drive Retake over MCP with no shell. They could never have found it.
 * It shipped as dead weight and nobody would have noticed for weeks.
 *
 * So this is a build failure rather than a habit. Every verb has to be
 * declared: agent-facing, and then it must have a tool and appear in the docs
 * an agent actually reads — or human-only, which is a decision somebody made
 * on purpose rather than a thing that was forgotten.
 *
 * If a new verb makes this fail, add the tool and the docs. Do not move it to
 * HUMAN_ONLY to get a green build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

/**
 * Verbs a person runs at a terminal, or that set the workspace up. An agent
 * driving Retake has no shell and no reason to reach for these — several of
 * them (install, ui, signin, secret) exist precisely BECAUSE an agent must
 * not do that part.
 */
const HUMAN_ONLY = new Set([
  "install", "init", "doctor", "ui", "mcp", "agent", "help",
  "signin", "secret",                    // the person types the password, never the agent
  "list", "presets", "validate",         // the agent has read_manifest / write_manifest / the tool list
  "takes", "restore", "tidy",            // housekeeping over the whole workspace
  "describe", "contact", "gif", "check", // covered by draft / receipts / the run tool's own report
]);

/** Everything the CLI exposes, straight from the source. */
function cliVerbs(): string[] {
  const src = read("src/cli.ts");
  return [...src.matchAll(/\.command\("([a-z-]+)"\)/g)].map((m) => m[1]).sort();
}

/** Everything the MCP server exposes. */
function mcpTools(): string[] {
  const src = read("src/operator/tools.ts");
  return [...src.matchAll(/registerTool\("([a-z_]+)"/g)].map((m) => m[1]).sort();
}

test("every CLI verb is either agent-facing or deliberately human-only", () => {
  // The point is that adding a verb forces the decision. A verb that is
  // neither is a verb somebody forgot to finish.
  const tools = new Set(mcpTools());
  const invisible = cliVerbs().filter((v) => !HUMAN_ONLY.has(v) && !tools.has(v));
  assert.deepEqual(invisible, [], `these verbs exist but no agent can reach them: ${invisible.join(", ")}\n` +
    "Give each one an MCP tool, or add it to HUMAN_ONLY with a reason.");
});

test("every agent-facing verb appears in the documents an agent reads", () => {
  const agents = read("AGENTS.md");
  const skill = read("skill/SKILL.md");
  const missing: string[] = [];
  for (const v of cliVerbs()) {
    if (HUMAN_ONLY.has(v)) continue;
    const named = new RegExp(`(retake ${v}\\b|\`${v}\`)`);
    if (!named.test(agents)) missing.push(`${v} → AGENTS.md`);
    if (!named.test(skill)) missing.push(`${v} → skill/SKILL.md`);
  }
  assert.deepEqual(missing, [], `built but undocumented:\n  ${missing.join("\n  ")}`);
});

test("every MCP tool carries a description an agent can act on", () => {
  // A tool with a one-line label is a tool nobody picks. These descriptions
  // are the only thing an agent sees before deciding to call it.
  const src = read("src/operator/tools.ts");
  const thin: string[] = [];
  for (const m of src.matchAll(/registerTool\("([a-z_]+)",\s*\{\s*\n?\s*description:\s*(["'`])([\s\S]*?)\2/g)) {
    if (m[3].trim().length < 60) thin.push(m[1]);
  }
  assert.deepEqual(thin, [], `these tools describe themselves too thinly to be chosen well: ${thin.join(", ")}`);
});

test("the checks that judge a picture are all reachable, and all documented", () => {
  // Named explicitly rather than derived: these are the ones whose whole value
  // is that an agent runs them without being asked each time, and they are the
  // ones that went missing.
  for (const v of ["verify", "sweep", "sense", "destroy", "notes", "flag", "fixed"]) {
    assert.ok(mcpTools().includes(v), `${v} has no MCP tool`);
    assert.match(read("skill/SKILL.md"), new RegExp(`\`${v}\``), `${v} is not in the skill`);
  }
});

test("the README lists the verbs a person types", () => {
  const readme = read("README.md");
  for (const v of ["verify", "sweep", "sense", "destroy", "notes", "fixed"]) {
    assert.match(readme, new RegExp(`retake ${v}`), `${v} is missing from the README`);
  }
});
