/**
 * Retake's two areas, and the one sentence above them.
 *
 *   retake watch …   testing: your agent watches your app and says what broke or looks unclear
 *   retake demo …    videos: a manifest in, a product walkthrough out
 *
 * cli.ts defines every command where it always has; `organise()` then hangs
 * the video commands under `demo` and replaces the top-level help with the
 * sentence and the two areas. Nothing about a command changes when it moves:
 * the same action runs, with the same options and exit codes.
 *
 * The old top-level names (`retake run`, `retake verify`, …) keep working for
 * the scripts, schedules and agents that already type them: `withAliases()`
 * puts `demo` in front of them before commander sees the line. They are listed
 * nowhere.
 */
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

export const SENTENCE = "Retake: video recording for your coding agent — demos of your app, and testing you can watch.";

/** The video commands, in the groups `retake demo --help` shows them in. */
export const DEMO_GROUPS: [heading: string, names: string[]][] = [
  ["Make a video:", ["describe", "ideas", "validate", "dry", "run", "render", "check", "stitch", "share", "routine", "env"]],
  ["Judge a take:", ["verify", "sweep", "sense", "destroy", "calibrate", "flag", "unflag", "fixed", "notes", "intent", "contact"]],
  ["Takes and tools:", ["takes", "restore", "heal", "list", "presets", "golden", "gif", "scout", "build-native"]],
];
export const DEMO_AREA = new Set(DEMO_GROUPS.flatMap(([, names]) => names));

/** The Watch commands, in the order `retake watch --help` lists them. */
export const WATCH_ORDER = ["sessions", "journeys", "run", "suggest", "add", "accept", "share", "check", "schedule"];

/** Shared by both areas: they stay top-level. */
export const SHARED = ["install", "ui", "login", "logins", "doctor", "tidy"];

/** Plumbing a person rarely types (or an agent must not): top-level, listed nowhere. */
export const UNLISTED = ["mcp", "init", "agent", "secret", "signin"];

/** The three a newcomer needs from each area. The first three that exist are
    shown, so a command another change adds (watch suggest) takes its place by
    being defined, not by editing this file twice. */
const FEATURED: Record<"watch" | "demo", [name: string, args: string, says: string][]> = {
  watch: [
    ["suggest", "<url>", "journeys worth watching on your app"],
    ["run", "<journey|all>", "run them, compared with the last good run"],
    ["sessions", "", "every session, newest first"],
    ["schedule", "daily", "every night, silent unless something changed"],
  ],
  demo: [
    ["describe", "<name> <url> \"<what>\"", "draft a demo from one sentence"],
    ["run", "demos/<name>.yaml", "record it and render the video"],
    ["render", "outputs/<name>", "render again, without recording"],
  ],
};

const find = (parent: Command, name: string) => parent.commands.find((c) => c.name() === name);

/** `retake` and `retake --help`: the sentence, the two areas, and where the rest is. */
export function topHelp(program: Command): string {
  const rows = (area: "watch" | "demo") => {
    const group = find(program, area);
    return FEATURED[area].filter(([name]) => group && find(group, name)).slice(0, 3)
      .map(([name, args, says]) => [`retake ${area} ${name}${args ? " " + args : ""}`, says] as const);
  };
  const watch = rows("watch"), demo = rows("demo");
  const w = Math.max(...[...watch, ...demo].map(([l]) => l.length));
  const block = (r: readonly (readonly [string, string])[]) => r.map(([l, s]) => `  ${l.padEnd(w)}   ${s}`).join("\n");
  return [
    SENTENCE, "",
    "Watch: test your app", block(watch), "",
    "Demos: videos of your app", block(demo), "",
    "retake watch --help / retake demo --help for the rest.",
  ].join("\n") + "\n";
}

const SHARED_LINE = `\nShared: ${SHARED.map((s) => `retake ${s}`).join(" · ")}\n`;

/** Hang the video commands under `demo`, and give both areas their help. */
export function organise(program: Command): void {
  const top = program.commands as Command[];
  const demo = program.command("demo")
    .description("Demos: videos of your app, from websites, web apps and Mac apps. A short manifest in, a product walkthrough out")
    .action(() => { demo.outputHelp(); });
  for (const [heading, names] of DEMO_GROUPS) {
    for (const name of names) {
      const i = top.findIndex((c) => c.name() === name);
      if (i < 0) throw new Error(`the demo area names a command that does not exist: ${name}`);
      const [cmd] = top.splice(i, 1);
      demo.addCommand(cmd);
      cmd.helpGroup(heading);
    }
  }
  find(demo, "describe")?.alias("draft");
  demo.addHelpText("after", SHARED_LINE + "\nThe old names still work: `retake run` is `retake demo run`.\n");

  const watch = find(program, "watch");
  if (watch) {
    watch.description("Watch: testing you can watch. Your agent runs your app's key flows, live or overnight, and says what broke or looks unclear");
    watchLists(watch);
    // The order a newcomer meets them in; anything not named keeps its place after these.
    const rank = (c: Command) => { const i = WATCH_ORDER.indexOf(c.name()); return i < 0 ? WATCH_ORDER.length : i; };
    (watch.commands as Command[]).sort((a, b) => rank(a) - rank(b));
    watch.addHelpText("after", SHARED_LINE);
  }

  for (const name of UNLISTED) { const c = find(program, name); if (c) (c as unknown as { _hidden: boolean })._hidden = true; }
  program.helpInformation = () => topHelp(program);
}

/** The line as commander should see it: an old top-level name gets `demo` in
    front of it, so it runs exactly what it always ran. */
export function withAliases(argv: string[]): string[] {
  const [node, script, first, second, ...rest] = argv;
  if (first === undefined) return [node, script, "--help"];   // `retake` alone: the sentence and the two areas
  if (first && DEMO_AREA.has(first)) return [node, script, "demo", first, ...(second === undefined ? [] : [second]), ...rest];
  if (first === "help" && second && DEMO_AREA.has(second)) return [node, script, "demo", second, "--help"];
  return argv;
}

const say = (l: string) => process.stdout.write(l + "\n");
const outRoot = (root: string) => process.env.RETAKE_OUT?.trim() ? path.resolve(process.env.RETAKE_OUT.replace(/^~/, process.env.HOME ?? "")) : path.join(root, "outputs");

/** `watch sessions` and `watch journeys`: what the Watch area shows, as lines. */
function watchLists(watch: Command): void {
  watch
    .command("sessions")
    .description("every Watch session in this workspace, newest first, with its steps and flags")
    .action(async () => {
      const { readMeta, readSteps, readFlagsIn, safeId } = await import("./watch/session.js");
      const { shortDate } = await import("./watch/journey-store.js");
      const dir = path.join(outRoot(process.cwd()), "watch");
      let ids: string[] = [];
      try { ids = fs.readdirSync(dir).filter(safeId); } catch { /* none yet */ }
      const all = ids.map((id) => {
        const meta = readMeta(path.join(dir, id));
        if (!meta) return null;
        const steps = readSteps(path.join(dir, id)), flags = readFlagsIn(path.join(dir, id));
        return { id, meta, failed: steps.filter((s) => s.result === "fail").length, steps: steps.length, flags: flags.length };
      }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
      if (!all.length) { say("no sessions yet — a session is a test run under Watch; `retake ui` shows one live"); return; }
      for (const s of all) {
        const mark = !s.meta.endedAt ? "▶" : s.failed ? "✗" : "✓";
        const facts = [`${s.steps} step${s.steps === 1 ? "" : "s"}`, s.failed ? `${s.failed} failed` : "", s.flags ? `${s.flags} flagged` : ""].filter(Boolean).join(", ");
        say(`${mark} ${s.meta.title.padEnd(32)} ${shortDate(s.meta.startedAt).padEnd(12)} ${facts}`);
        say(`  ${path.relative(process.cwd(), path.join(dir, s.id)) || s.id}`);
      }
    });

  watch
    .command("journeys")
    .description("each journey in watch/, with how its last run went (the same as `retake watch`)")
    .action(async () => {
      const { journeyStates, summaryLine } = await import("./watch/journey-store.js");
      const all = journeyStates(process.cwd());
      if (!all.length) { say("no journeys yet — a journey is a script at watch/<name>.mjs in this workspace"); return; }
      const s = summaryLine(all.map((j) => j.last));
      if (s) say(s);
      for (const j of all) say(`${j.status === "failed" ? "✗" : j.status === "changed" ? "△" : j.status ? "✓" : "·"} ${j.name.padEnd(28)} ${j.line}`);
    });
}
