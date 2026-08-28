/**
 * The flows nobody wrote down.
 *
 * A demo is the happy path — the one somebody thought to describe. Everything
 * that has ever gone wrong in a real app went wrong just off it: the second
 * click, the reload halfway through, the provider being down, the very long
 * name, the empty first run. Those are not infinite creativity. They are a
 * short list, and this applies the list to a flow the app actually has.
 *
 * What it produces is MANIFESTS, not findings. A bug found by a random walk
 * that nobody can replay is worth less than nothing; a bug that arrives as a
 * readable file you can re-run, keep, or throw away is a bug report with the
 * repro already attached. So every candidate here is an ordinary Retake demo,
 * written to disk, runnable with the verbs that already exist.
 *
 * Two hard boundaries, because this one clicks things:
 *
 *   · it never writes into an existing demo's output — everything lands under
 *     outputs/.destroy/<demo>/, and the take you already have is untouchable;
 *   · it refuses a remote URL, and refuses to RUN a manifest that does not
 *     seed its own state. Both can be overridden by someone who means it, and
 *     neither by accident.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Manifest } from "../manifest.js";
import { dryRun } from "../dryrun.js";
import { record, type Take } from "../record.js";
import { tag, type Evidence } from "./evidence.js";

export type Shape = {
  name: string;
  /** What it does to the app, in the words you would use to a person. */
  asks: string;
  /** Why a real product breaks here. */
  because: string;
  /** null when this demo gives it nothing to work with — said out loud, never
      silently skipped. */
  apply: (m: Manifest) => Manifest | null;
  /**
   * What the outcome MEANS for this shape — and it is not the same for all of
   * them. A double-submit whose second click finds nothing is the app having
   * removed the button, which is the app winning; reporting that as a failure
   * is crying wolf on the most valuable shape there is. A reload that breaks
   * the flow is the app losing. Without this, destroy is a step-failure
   * counter wearing a costume.
   */
  read: (failed: boolean, why: string[]) => Reading;
};

/** destroy performs the flow. Whatever it reports, it did. */
export const DESTROY_EVIDENCE: Evidence = "reproduced";

export type Reading = { verdict: Verdict; note: string };
/** `look` is the honest third answer: something happened that a person has to
    interpret, and pretending it is a pass or a bug would be a guess. */
export type Verdict = "broke" | "look" | "held";

/** The common case: the abuse went through cleanly, or it did not. */
const breaks = (failed: boolean): Reading => failed
  ? { verdict: "broke", note: "the flow came apart" }
  : { verdict: "held", note: "the app took it" };

type Step = Record<string, unknown> & { action: string };
const steps = (m: Manifest) => m.steps as unknown as Step[];
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const withSteps = (m: Manifest, s: Step[]): Manifest => ({ ...clone(m), steps: s as unknown as Manifest["steps"] });

/** The click that commits something: the last click before the run starts
    waiting for a result. That is the one worth pressing twice. */
function submitIndex(s: Step[]): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].action !== "waitFor") continue;
    for (let j = i - 1; j >= 0; j--) if (s[j].action === "click") return j;
  }
  return s.findIndex((x) => x.action === "click");
}

const LONG = "Nguyen".repeat(90);                       // 540 characters, no spaces
const WEIRD = `Ω 𝔘nicode "quotes" <b>tags</b> 'and' \\backslash\\ 🎉🎉 ${"عربى"} ${"表意文字"}`;

export const SHAPES: Shape[] = [
  {
    name: "double-submit",
    asks: "presses the button that commits the thing twice, fast",
    because: "a slow response and an impatient hand is how one order becomes two",
    apply: (m) => {
      const s = clone(steps(m));
      const i = submitIndex(s);
      if (i < 0) return null;
      s.splice(i + 1, 0, { ...clone(s[i]), pauseAfter: 0 });
      return withSteps(m, s);
    },
    // Inverted on purpose. The second click failing is the button having gone
    // away, which is the app defending itself.
    read: (failed) => failed
      ? { verdict: "held", note: "the second press found nothing — the button was gone after the first, which is the app refusing to do it twice" }
      : { verdict: "look", note: "the second press landed. Look at whether it made a second one" },
  },
  {
    name: "reload-midway",
    asks: "reloads the page while the app is still working on it",
    because: "people reload when a spinner takes too long, and the work is often already half done",
    apply: (m) => {
      const s = clone(steps(m));
      const i = submitIndex(s);
      if (i < 0) return null;
      s.splice(i + 1, 0, { action: "wait", ms: 400 }, { action: "evaluate", script: "location.reload()" }, { action: "wait", ms: 2500 });
      return withSteps(m, s);
    },
    read: breaks,
  },
  {
    name: "back-button",
    asks: "hits the browser's back button after the thing has happened",
    because: "back into a completed flow is where apps show a stale screen or let it be done again",
    apply: (m) => {
      const s = clone(steps(m));
      const last = s.map((x) => x.action).lastIndexOf("scene");
      if (last < 1) return null;
      s.splice(last + 1, 0, { action: "wait", ms: 600 }, { action: "evaluate", script: "history.back()" }, { action: "wait", ms: 2000 }, { action: "scene", label: "after-back" });
      return withSteps(m, s);
    },
    read: breaks,
  },
  {
    name: "provider-down",
    asks: "makes everything the app depends on answer 500",
    because: "the question is never whether it fails, it is whether the person's input survives the failure",
    apply: (m) => {
      if (!m.stub?.length) return null;
      return { ...clone(m), stub: m.stub.map((s) => ({ ...s, status: 500, json: { error: "upstream unavailable" } })) };
    },
    // Ambiguous by nature: a flow that cannot continue might be a handled
    // error screen doing its job, or a dead end. Only a person can say.
    read: (failed) => failed
      ? { verdict: "look", note: "the flow could not continue. Look at the picture: is that a handled error, or a dead end with the person's input gone?" }
      : { verdict: "held", note: "the flow finished even with everything answering 500 — worth knowing what it showed" },
  },
  {
    name: "provider-empty",
    asks: "makes everything the app depends on answer successfully, with nothing in it",
    because: "empty is the case that gets handled last — a 200 with no rows renders differently from a 500",
    apply: (m) => {
      if (!m.stub?.length) return null;
      return { ...clone(m), stub: m.stub.map((s) => ({ ...s, status: 200, json: [] })) };
    },
    read: (failed) => failed
      ? { verdict: "look", note: "nothing came back and the flow stopped. Is that an empty state, or a blank screen?" }
      : { verdict: "held", note: "it rendered something with no data at all" },
  },
  {
    name: "empty-state",
    asks: "runs the whole flow against an app with nothing in it yet",
    because: "every screenshot in every deck has data in it; the first thing a new person sees does not",
    apply: (m) => (m.seed?.length ? { ...clone(m), seed: [] } : null),
    read: (failed) => failed
      ? { verdict: "look", note: "the flow needs data that is not there yet — which is what a new person has. Look at what they would see" }
      : { verdict: "held", note: "it works from empty" },
  },
  {
    name: "long-input",
    asks: "types 540 characters into every field that takes text",
    because: "layouts break, columns overflow, and the truncation nobody wrote shows up here",
    apply: (m) => {
      const s = clone(steps(m));
      let hit = 0;
      for (const st of s) if ((st.action === "type" || st.action === "fill") && typeof st.text === "string") { st.text = LONG; hit++; }
      return hit ? withSteps(m, s) : null;
    },
    // A step failing here is real, but the damage is usually visual and a dry
    // pass cannot see it — so a clean pass is still worth a look.
    read: (failed) => failed
      ? { verdict: "broke", note: "540 characters was enough to break the flow" }
      : { verdict: "look", note: "it accepted all of it. Whether the layout survived is a question for the pictures — `--run`, then `verify`" },
  },
  {
    name: "awkward-input",
    asks: "types quotes, tags, emoji and right-to-left script into every field",
    because: "an apostrophe in a surname has taken down more checkouts than any load test",
    apply: (m) => {
      const s = clone(steps(m));
      let hit = 0;
      for (const st of s) if ((st.action === "type" || st.action === "fill") && typeof st.text === "string") { st.text = WEIRD; hit++; }
      return hit ? withSteps(m, s) : null;
    },
    read: (failed) => failed
      ? { verdict: "broke", note: "quotes, tags or emoji broke the flow" }
      : { verdict: "look", note: "it took all of it. Check the pictures for mangled text or an unescaped tag" },
  },
  {
    name: "impatient",
    asks: "stops waiting for things to be ready before clicking them",
    because: "a button that is clickable a moment before it is meant to be is a race nobody sees on a fast machine",
    apply: (m) => {
      const s = clone(steps(m)).filter((x) => x.action !== "waitFor");
      if (s.length === steps(m).length) return null;
      return withSteps(m, s);
    },
    // Also inverted: refusing to be clicked early is the app being careful.
    read: (failed) => failed
      ? { verdict: "held", note: "it would not be clicked before it was ready" }
      : { verdict: "look", note: "every step went through with no waiting at all. Check nothing was submitted before it was meant to be" },
  },
];

/** Why a shape produced nothing, in words that name the fix. */
export const NOTHING_TO_DO: Record<string, string> = {
  "provider-down": "this demo stubs nothing, so there is no dependency to take down — add a `stub:` for the API it calls",
  "provider-empty": "this demo stubs nothing, so there is nothing to empty out",
  "empty-state": "this demo seeds nothing, so it is already running against whatever is there",
  "long-input": "this demo types nothing",
  "awkward-input": "this demo types nothing",
  "impatient": "this demo has no `waitFor` to remove — which is its own problem",
  "double-submit": "this demo clicks nothing",
  "reload-midway": "this demo clicks nothing",
  "back-button": "this demo has no scene to come back to",
};

export type Candidate = { shape: Shape; file: string; manifest: Manifest };
export type Plan = { root: string; candidates: Candidate[]; skipped: { name: string; why: string }[]; refused?: string };

/** Where destroy is allowed to write. Never outputs/<demo>/ — the take you
    already have cannot be reached from here. */
export const sandbox = (outRoot: string, demo: string) => path.join(outRoot, ".destroy", demo);

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i;

/**
 * Write the candidates. Generating is always safe — it produces files and
 * touches nothing — so the refusals here are about the app, not the disk, and
 * they bite when somebody asks to RUN one.
 */
export function planDestroy(m: Manifest, outRoot: string, opts: { only?: string[] } = {}): Plan {
  const root = sandbox(outRoot, m.name);
  const candidates: Candidate[] = [];
  const skipped: { name: string; why: string }[] = [];
  const want = opts.only?.length ? SHAPES.filter((s) => opts.only!.includes(s.name)) : SHAPES;
  const unknown = (opts.only ?? []).filter((n) => !SHAPES.some((s) => s.name === n));
  if (unknown.length) return { root, candidates: [], skipped: [], refused: `no such shape: ${unknown.join(", ")} — one of ${SHAPES.map((s) => s.name).join(", ")}` };

  fs.mkdirSync(root, { recursive: true });
  for (const shape of want) {
    const made = shape.apply(m);
    if (!made) { skipped.push({ name: shape.name, why: NOTHING_TO_DO[shape.name] ?? "this demo gives it nothing to work with" }); continue; }
    // Its own name, so a candidate can never be confused for the real demo
    // and can never be written over it.
    const named: Manifest = { ...made, name: `${m.name}-${shape.name}`.slice(0, 60) };
    const file = path.join(root, `${shape.name}.yaml`);
    fs.writeFileSync(file, [
      `# ${shape.name} — ${shape.asks}.`,
      `# ${shape.because}.`,
      `#`,
      `# Generated by \`retake destroy ${m.name}\` from demos/${m.name}.yaml. It is an`,
      `# ordinary manifest: read it, change it, keep it, or delete the folder.`,
      "",
      YAML.stringify(named),
    ].join("\n"));
    candidates.push({ shape, file, manifest: named });
  }
  return { root, candidates, skipped };
}

/**
 * Is somebody else filming this app right now?
 *
 * Learned the hard way: destroy was dry-run and then run against a live app
 * on :3200 while another agent was recording a seven-minute take of the same
 * app. Nothing stopped it. A folder lock protects the OUTPUT; nothing was
 * protecting the APP, and destroy is the one verb that deliberately abuses it.
 *
 * So: any output folder holding a fresh lock whose recorded manifest points at
 * the same host and port counts as somebody working. Fifteen minutes, because
 * a lock older than that is more likely a dead run than a live one.
 */
export function appIsBusy(m: Manifest, outRoot: string, now = Date.now()): string | null {
  let here: string;
  try { here = new URL(m.url).host; } catch { return null; }
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(outRoot); } catch { return null; }
  for (const d of dirs) {
    if (d.startsWith(".")) continue;
    const dir = path.join(outRoot, d);
    try {
      if (now - fs.statSync(path.join(dir, ".retake-lock")).mtimeMs > 15 * 60_000) continue;
      const used = YAML.parse(fs.readFileSync(path.join(dir, "manifest.used.yaml"), "utf8")) as { url?: string };
      if (used?.url && new URL(used.url).host === here) return d;
    } catch { /* no lock, no manifest, or an unreadable one */ }
  }
  return null;
}

/** The refusals, checked separately so the message can name which one. */
export function refuseToRun(m: Manifest, env: NodeJS.ProcessEnv = process.env, outRoot?: string): string | null {
  const busy = outRoot ? appIsBusy(m, outRoot) : null;
  if (busy && env.RETAKE_DESTROY_ANYWAY !== "1") {
    return `something is recording "${busy}" against ${new URL(m.url).host} right now. destroy types into that app and clicks things in it, which would land in the middle of their take.\n  Wait for it to finish, or set RETAKE_DESTROY_ANYWAY=1 if you know that lock is dead.`;
  }
  if (!LOCAL.test(m.url) && env.RETAKE_DESTROY_REMOTE !== "1") {
    return `${m.url} is not local. destroy clicks things and fills things in; it will not do that to an app it did not start.\n  If you genuinely mean to point it at ${new URL(m.url).host}, set RETAKE_DESTROY_REMOTE=1.`;
  }
  // The author has to have taken control of the state somewhere: `seed:` puts
  // the app in a known place, `stub:` means the flow is reading canned data
  // rather than whatever is really in there. A demo with neither is pointed
  // at live state, and destroy is about to click things in it.
  if (!m.seed?.length && !m.stub?.length && env.RETAKE_DESTROY_UNSEEDED !== "1") {
    return `this demo neither seeds its state nor stubs anything, so it is pointed at whatever is really in the app — and destroy is about to click things in it.\n  Give the manifest a \`seed:\` so a run is repeatable, or \`stub:\` what it reads, or set RETAKE_DESTROY_UNSEEDED=1 if the data is disposable.`;
  }
  return null;
}

/** The report a plan makes before anything runs. */
export function describePlan(p: Plan, m: Manifest): string[] {
  if (p.refused) return [p.refused];
  const out: string[] = [];
  out.push(`${p.candidates.length} way${p.candidates.length === 1 ? "" : "s"} to break ${m.name}, written to ${path.relative(process.cwd(), p.root)}/`);
  out.push("");
  for (const c of p.candidates) out.push(`  ${c.shape.name.padEnd(16)} ${c.shape.asks}`);
  if (p.skipped.length) {
    out.push("");
    out.push("  not applicable to this demo:");
    for (const s of p.skipped) out.push(`    ${s.name.padEnd(16)} ${s.why}`);
  }
  out.push("");
  out.push("These are ordinary manifests. Read one before you run it:");
  out.push(`  retake dry ${path.relative(process.cwd(), p.candidates[0]?.file ?? path.join(p.root, "<shape>.yaml"))}`);
  return out;
}

// --- trying them ------------------------------------------------------------

export type Trial = {
  shape: string;
  /** What the shape itself made of the outcome — see Shape.read. "unrunnable"
      is the generator's own fault and is reported as such, never as a finding
      about the app. */
  verdict: Verdict | "unrunnable";
  /** The shape's sentence about what that means. */
  note: string;
  why: string[];
  dir?: string;
};

/** What a take says went wrong, in the words that name the fix. */
export function readTake(t: Take): string[] {
  const out: string[] = [];
  for (const s of t.timeline.filter((x) => !x.ok)) out.push(`step ${s.index} (${s.summary}) — ${s.error}`);
  // An error the APP threw is the find. A step failing is often just the
  // candidate reaching for something the abuse removed.
  for (const e of (t.pageErrors ?? []).slice(0, 4)) out.push(`the app threw: ${e.text.slice(0, 160)}`);
  if (t.partial && !/\((?:from|until)\)/.test(t.partial)) out.push(t.partial);
  return out;
}

/**
 * Put each candidate through the app.
 *
 * `dry` is seconds and proves the flow still resolves — it does NOT click, so
 * it cannot catch a double-submit bug. `run` actually performs the steps, with
 * no render at all: this is a test, not a video, and encoding one would be
 * most of the cost for none of the answer.
 */
export async function tryCandidates(
  plan: Plan,
  opts: { mode: "dry" | "run"; manifestDir: string; outRoot: string; log?: (l: string) => void; only?: string[] },
): Promise<Trial[]> {
  const say = opts.log ?? (() => {});
  const trials: Trial[] = [];
  for (const c of plan.candidates) {
    const dir = path.join(plan.root, c.shape.name);
    say(`${c.shape.name}: ${c.shape.asks}`);
    try {
      if (opts.mode === "dry") {
        const r = await dryRun(c.manifest, opts.manifestDir, () => {}, { outRoot: plan.root });
        const why = r.failures > 0 ? r.lines.filter((l) => /✗/.test(l)).slice(0, 6) : [];
        const read = c.shape.read(r.failures > 0, why);
        trials.push({ shape: c.shape.name, ...read, why, dir });
      } else {
        const take = await record(c.manifest, { outDir: dir, manifestDir: opts.manifestDir, headed: false, log: () => {} });
        const why = readTake(take);
        const read = c.shape.read(why.length > 0, why);
        // An error the app itself threw is not ambiguous, whatever the shape
        // thinks: nothing should throw, however it is being abused.
        const threw = (take.pageErrors ?? []).length > 0;
        trials.push({ shape: c.shape.name, verdict: threw ? "broke" : read.verdict, note: threw ? "the app threw an error" : read.note, why, dir });
      }
    } catch (e) {
      trials.push({ shape: c.shape.name, verdict: "unrunnable", note: "the candidate itself did not work", why: [String((e as Error).message).split("\n")[0].slice(0, 200)], dir });
    }
    const t = trials[trials.length - 1];
    say(`  ${MARK[t.verdict]} ${t.note}`);
    for (const w of t.why.slice(0, 2)) say(`    ${w}`);
  }
  return trials;
}

const MARK: Record<Trial["verdict"], string> = { broke: "✗", look: "?", held: "·", unrunnable: "—" };

/** The report. Three buckets, because two would mean guessing at the middle
    one — and honest about what a dry pass can and cannot see. */
export function describeTrials(trials: Trial[], mode: "dry" | "run"): string[] {
  const of = (v: Trial["verdict"]) => trials.filter((t) => t.verdict === v);
  const broke = of("broke"), look = of("look"), held = of("held"), dud = of("unrunnable");
  const out: string[] = [""];
  const show = (t: Trial) => {
    out.push(`  ${MARK[t.verdict]} ${tag(DESTROY_EVIDENCE)} ${t.shape} — ${t.note}`);
    for (const w of t.why.slice(0, 3)) out.push(`      ${w}`);
    if (t.dir) out.push(`      ${path.relative(process.cwd(), t.dir)}/`);
  };

  if (broke.length) { out.push(`${broke.length} broke it:`); broke.forEach(show); }
  if (look.length) { if (broke.length) out.push(""); out.push(`${look.length} worth a look — ${look.length === 1 ? "this one is" : "these are"} not a verdict, ${look.length === 1 ? "it needs" : "they need"} your eyes:`); look.forEach(show); }
  if (!broke.length && !look.length) out.push(`nothing gave — all ${held.length} held.`);
  else if (held.length) { out.push(""); out.push(`${held.length} held: ${held.map((t) => t.shape).join(", ")}`); }

  if (dud.length) {
    out.push("");
    out.push(`${dud.length} candidate${dud.length === 1 ? "" : "s"} could not run at all. That is this tool's fault, not the app's: ${dud.map((d) => d.shape).join(", ")}`);
  }
  out.push("");
  out.push(mode === "dry"
    ? "That was a dry pass: it really does click and fill, at full speed with short timeouts — but it keeps no frames, so anything whose damage is visual (a broken layout, mangled text) will pass here and still be wrong. `--run` keeps the pictures; `verify` and `sense` judge them."
    : "That was a real run, with no video rendered. The frames are in each candidate's folder — `retake verify` and `retake sense` can judge them.");
  return out;
}
