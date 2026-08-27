/**
 * The reader that can see — shared by every extension that needs one.
 *
 * All of these checks come down to the same move: hand a model some frames
 * and a bounded question, and read an answer back out of whatever the CLI
 * printed. Getting that last part wrong is how a real verdict silently
 * becomes "could not answer", so it lives in one place with its own tests
 * rather than being written twice.
 *
 * Only providers that can actually take an image are used. Answering a
 * question about a picture from a filename would be worse than not answering.
 */
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pickProvider, type Provider } from "../describe.js";

/** A provider that can be shown an image, or null with the reason why not. */
export function pickJudge(): { provider: Provider | null; name: string; why?: string } {
  const p = pickProvider();
  if (!p) return { provider: null, name: "none", why: "nothing is signed in that can look at a picture — sign in to the `claude` or `codex` CLI" };
  if (p.name !== "claude-code" && p.name !== "codex") return { provider: null, name: p.name, why: `${p.name} cannot be given an image — verify and sense need the \`claude\` or \`codex\` CLI` };
  return { provider: p, name: `${p.name}${p.model !== "default" ? ` (${p.model})` : ""}` };
}

/** Put a prompt and some images to the judge. Returns raw stdout, or throws. */
function shape(p: Provider, prompt: string, images: string[]): { args: string[]; body: string } {
  const dirs = [...new Set(images.map((i) => path.dirname(i)))];
  const args = p.name === "claude-code"
    ? ["-p", "--output-format", "text", ...dirs.flatMap((d) => ["--add-dir", d]), "--allowedTools", "Read", ...(p.model !== "default" ? ["--model", p.model] : [])]
    : ["exec", "--skip-git-repo-check"];
  const body = images.length
    ? `${prompt}\n\n${images.length === 1 ? "The screenshot is the file at:" : "The screenshots, in order, are the files at:"}\n${images.map((i) => `  ${i}`).join("\n")}\nRead ${images.length === 1 ? "that image file" : "those image files"} first, then answer.`
    : prompt;
  return { args, body };
}

export function ask(p: Provider, prompt: string, images: string[], timeoutMs = 180_000): string {
  const { args, body } = shape(p, prompt, images);
  // stderr is piped, not inherited: the codex CLI prints a session banner and
  // a token count to it, which would bury the one line that matters.
  return execFileSync(p.baseUrl, args, { input: body, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 22, stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * Pull the last JSON value out of whatever the CLI printed.
 *
 * Walks backwards to the last candidate that actually parses AND satisfies
 * `want`. Some CLIs echo the prompt before answering, and the prompt contains
 * the example shape — which matches any pattern you'd write and is not valid
 * JSON. Reading that as the answer turns a real verdict into a shrug.
 */
export function readJson<T>(out: string, want: (v: unknown) => v is T): T | null {
  const cands: string[] = [];
  // Objects and arrays, innermost-last: a crude but dependency-free scan that
  // takes balanced {...} and [...] spans.
  for (const open of ["{", "["] as const) {
    const close = open === "{" ? "}" : "]";
    let depth = 0, start = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === open) { if (depth === 0) start = i; depth++; }
      else if (out[i] === close && depth > 0) { depth--; if (depth === 0 && start >= 0) cands.push(out.slice(start, i + 1)); }
    }
  }
  for (let i = cands.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(cands[i]) as unknown;
      if (want(v)) return v;
    } catch { /* the echoed template, or prose with a brace in it */ }
  }
  return null;
}

/** One line of a caught error, short enough to print next to a question. */
export const why = (e: unknown) => String((e as Error).message).split("\n")[0].slice(0, 140);


/**
 * The same question, asked without blocking.
 *
 * `spawn`, not `execFile`: the async execFile has no `input` option — only the
 * sync one does — so the prompt has to be written to stdin by hand. Passing
 * `input` to execFile silently sends nothing, and the judge answers a question
 * it was never asked.
 */
export function askAsync(p: Provider, prompt: string, images: string[], timeoutMs = 180_000): Promise<string> {
  const { args, body } = shape(p, prompt, images);
  return new Promise((resolve, reject) => {
    const child = spawn(p.baseUrl, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`the judge took longer than ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += String(d).slice(0, 2000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.split("\n").filter(Boolean).pop() ?? `the judge exited ${code}`));
    });
    child.stdin.on("error", () => { /* the judge closed stdin early; the close handler reports */ });
    child.stdin.end(body);
  });
}

/** Run at most `limit` at once. Order of results matches order of inputs. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
