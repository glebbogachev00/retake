/**
 * What the product is for.
 *
 * Every judge in Retake was reading a screenshot with no idea what it was
 * looking at. It judged a charter operations console and a thought-capture
 * app by the same generic standard, which is how a deliberately faint internal
 * note — "Held in Operations. Never shown to the customer" — comes back as a
 * contrast defect, and how anything unusual on purpose reads as broken.
 *
 * The gap this closes is the one that makes an agent technically diligent and
 * wrong about the product: code shows implementation risk, a frame shows what
 * is there, and neither says whether what is there is what was meant.
 *
 * `demos/style.md` already exists and is a different thing — it is how the
 * PERSON wants their demos shot. This is what the APP is, who it is for, and
 * what about it is deliberate.
 *
 * It is optional. Without it the checks work exactly as before, and say so
 * rather than pretending to context they do not have.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * A demo name that cannot leave the folder it is meant to be in.
 *
 * `intentPath` and `writeIntent` put this straight into `path.join`, so
 * `--demo ../../escaped` wrote its file outside `demos/` entirely. Measured,
 * not theorised, and in a released package. Kebab-case is the rule every other
 * name in Retake already follows; the containment check afterwards is the belt
 * for anything that rule ever stops catching.
 */
export function safeDemo(demo: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(demo)) {
    throw new Error(`"${demo}" is not a demo name — lowercase letters, numbers and hyphens only`);
  }
  return demo;
}

/** Belt for the braces: whatever we built, it has to be inside `dir`. */
function within(dir: string, file: string): string {
  const root = path.resolve(dir);
  const full = path.resolve(file);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside ${dir}`);
  }
  return full;
}

/**
 * Where a demo's product note lives.
 *
 * Per demo first, workspace second. One workspace here holds demos for three
 * different products — a charter console, a thought-capture app, a coding
 * school — and a single note describing "the product" would be wrong for two
 * of them every time it was read.
 */
export function intentPath(demosDir: string, demo?: string): string {
  if (demo) {
    const own = within(demosDir, path.join(demosDir, `${safeDemo(demo)}.product.md`));
    if (fs.existsSync(own)) return own;
  }
  return within(demosDir, path.join(demosDir, "product.md"));
}

export function readIntent(demosDir: string, demo?: string): string | null {
  // A bad name is not an error when reading — it is simply no note. Only
  // writing refuses, because writing is where the damage would be.
  try {
    const t = fs.readFileSync(intentPath(demosDir, demo), "utf8").trim();
    return filled(t) ? t : null;
  } catch { return null; }
}

/**
 * Has anybody actually written in it?
 *
 * The starter is headings and HTML comments. Handing that to a judge as
 * "what this product is" is worse than handing it nothing — it looks like
 * context and contains none.
 */
export function filled(text: string): boolean {
  const words = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^#+.*$/gm, "").trim();
  return words.length > 0;
}

export function writeIntent(demosDir: string, text: string, demo?: string): string {
  const f = within(demosDir, path.join(demosDir, demo ? `${safeDemo(demo)}.product.md` : "product.md"));
  fs.mkdirSync(demosDir, { recursive: true });
  fs.writeFileSync(f, text.trim() + "\n");
  return f;
}

/** The starter, so nobody has to guess what belongs in it. */
export const TEMPLATE = `# What this product is

<!-- One or two sentences. What it does, and for whom. -->

## Who uses it

<!-- The person on the other side of the screen, and what they are in the
     middle of when they open it. -->

## What is deliberate

<!-- The things that would look like mistakes to someone who does not know.
     Quiet text that is meant to be quiet. A screen that is meant to be
     nearly empty. A word you use differently from everyone else. This is the
     section that stops a check reporting your choices as defects. -->

## What would actually be wrong

<!-- The failures that matter for THIS product, in your words. -->
`;

/**
 * The block a judge is shown before it looks at anything.
 *
 * Deliberately framed as context, never as instruction: a judge told what the
 * product is meant to be is more useful, but a judge told what to conclude is
 * worthless.
 */
export function intentBlock(demosDir: string, demo?: string): string {
  const t = readIntent(demosDir, demo);
  if (!t) return "";
  return [
    "",
    "WHAT THIS PRODUCT IS — written by the person who built it, so you are not judging it as a generic web page:",
    "",
    t.split("\n").map((l) => `  ${l}`).join("\n"),
    "",
    "Use that to tell a deliberate choice from a defect. It does not tell you what to conclude, and something plainly broken is still broken however it is described above.",
    "",
  ].join("\n");
}

/** Said out loud when there is none, so nobody mistakes silence for context. */
export const NO_INTENT_NOTE =
  "no demos/product.md — the judge is looking at this as a generic web page, so anything deliberate about it may come back as a defect. `retake intent` writes a starter.";
