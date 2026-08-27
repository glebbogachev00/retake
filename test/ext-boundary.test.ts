/**
 * The seam, enforced.
 *
 * `src/ext/` is where the things that are NOT the core live: the checks and
 * the readers. The core is "drive a real browser to a known state and prove
 * what happened"; everything in ext hangs off that and must be deletable
 * without the core noticing.
 *
 * A folder named ext is a naming convention. These tests are what make it an
 * architecture — without them the first import in the wrong direction goes in
 * unnoticed, and a year later there is no seam, only a folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The only files allowed to reach into ext: the two places a person or an
    agent asks for something by name. Nothing else may depend on an extension
    being installed. */
const SURFACES = ["cli.ts", path.join("operator", "tools.ts"), path.join("ui", "server.ts")];

/** Every .ts under src/, relative to src/. */
function walk(dir: string, base = SRC): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f, base));
    else if (e.name.endsWith(".ts")) out.push(path.relative(base, f));
  }
  return out;
}

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
/** import lines, split into type-only (erased at compile time, no runtime
    coupling) and real ones. */
function imports(src: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of src.matchAll(/^import\s+(type\s+)?([^;]*?)from\s+"([^"]+)"/gm)) {
    out.push({ spec: m[3], typeOnly: !!m[1] || /^\s*\{\s*type\s/.test(m[2]) && !/,/.test(m[2]) });
  }
  return out;
}

test("the core never imports an extension", () => {
  const offenders: string[] = [];
  for (const rel of walk(SRC)) {
    if (rel.startsWith("ext" + path.sep)) continue;
    if (SURFACES.includes(rel)) continue;
    for (const i of imports(read(rel))) {
      if (/(^|\/)ext\//.test(i.spec)) offenders.push(`${rel} → ${i.spec}`);
    }
  }
  assert.deepEqual(offenders, [], `the core reached into ext:\n  ${offenders.join("\n  ")}`);
});

test("an extension never renders — no video machinery behind the seam", () => {
  // Extensions read what a run left behind and judge it. The moment one can
  // encode a video it is not an extension any more, it is a second core.
  const offenders: string[] = [];
  const EXT = path.join(SRC, "ext");
  for (const rel of walk(EXT, EXT)) {
    for (const i of imports(read(path.join("ext", rel)))) {
      if (i.typeOnly) continue;
      if (/render\.js$|cards\.js$|captions\.js$|voice\.js$|ffmpeg/.test(i.spec)) offenders.push(`ext/${rel} → ${i.spec}`);
    }
  }
  assert.deepEqual(offenders, [], `an extension reached for the renderer:\n  ${offenders.join("\n  ")}`);
});

test("every extension is deletable — nothing outside the two surfaces names one", () => {
  // The real property: `rm -rf src/ext` and `retake run` still records. This
  // proves the static half; test/ext-absent.test.ts proves it by actually
  // removing them.
  const exts = walk(path.join(SRC, "ext"), path.join(SRC, "ext")).map((f) => path.basename(f, ".ts"));
  assert.ok(exts.length > 0, "src/ext is empty — did something move?");
  const offenders: string[] = [];
  for (const rel of walk(SRC)) {
    if (rel.startsWith("ext" + path.sep) || SURFACES.includes(rel)) continue;
    const src = read(rel);
    for (const name of exts) {
      if (new RegExp(`from "[^"]*${name}\\.js"`).test(src)) offenders.push(`${rel} names ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the surfaces reach extensions only through src/ext/", () => {
  // Guards against the other failure: an extension quietly moved back into
  // src/ and nobody noticing that the seam stopped meaning anything.
  for (const s of SURFACES) {
    if (!fs.existsSync(path.join(SRC, s))) continue;
    for (const i of imports(read(s))) {
      if (/(verify|notes|sense|destroy)\.js$/.test(i.spec)) {
        assert.match(i.spec, /ext\//, `${s} imports ${i.spec} — extensions live in src/ext/`);
      }
    }
  }
});

test("nothing the recorder reaches, however indirectly, is an extension", () => {
  // The static checks above look one hop. This walks the whole graph out from
  // the recorder: if `rm -rf src/ext` would break `retake run`, it fails here
  // rather than on somebody's machine.
  const seen = new Set<string>();
  const stack = ["record.ts", "render.ts", "dryrun.ts", "manifest.ts"];
  while (stack.length) {
    const rel = stack.pop()!;
    if (seen.has(rel) || !fs.existsSync(path.join(SRC, rel))) continue;
    seen.add(rel);
    for (const i of imports(read(rel))) {
      if (!i.spec.startsWith(".")) continue;
      const next = path.normalize(path.join(path.dirname(rel), i.spec.replace(/\.js$/, ".ts")));
      assert.ok(!next.startsWith("ext" + path.sep), `${rel} reaches ${next} — the recorder must not need an extension`);
      stack.push(next);
    }
  }
  assert.ok(seen.size > 5, "the walk found almost nothing — did the graph change shape?");
});

test("nothing that runs during a recording can reach the flag ledger or the clip cutter", () => {
  // His constraint, stated plainly: the extended functionality must not slow
  // the recording down in any way. The strongest form of that is that the
  // recorder cannot reach it at all — so it cannot run, cost time, or fail
  // while a camera is rolling.
  const reach = new Set<string>();
  const stack = ["record.ts", "render.ts"];
  while (stack.length) {
    const rel = stack.pop()!;
    if (reach.has(rel) || !fs.existsSync(path.join(SRC, rel))) continue;
    reach.add(rel);
    for (const i of imports(read(rel))) {
      if (!i.spec.startsWith(".")) continue;
      stack.push(path.normalize(path.join(path.dirname(rel), i.spec.replace(/\.js$/, ".ts"))));
    }
  }
  for (const forbidden of ["ext/flags.ts", "ext/clip.ts", "ext/sense.ts", "ext/verify.ts", "ext/destroy.ts", "ext/notes.ts"]) {
    assert.ok(!reach.has(forbidden), `the recorder reaches ${forbidden}`);
  }
});
