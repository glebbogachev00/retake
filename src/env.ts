/**
 * The workspace `.env` — where an app's demo-account credentials live.
 *
 * Three things write it: the person (by hand, or `retake secret NAME`), the
 * window (when an agent asks for a secret by name), and Settings. None of
 * them ever hands a value to a model: the agent learns that `APP_PASSWORD`
 * is *set*, and references it as `${APP_PASSWORD}` with `secret: true`.
 */
import fs from "node:fs";
import path from "node:path";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Parse KEY=value lines (quotes stripped, comments and blanks ignored). */
export function readEnvFile(root: string): Record<string, string> {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = m[2].trim();
    // Double-quoted values are JSON strings (that is how writeEnvFile writes
    // anything awkward); single-quoted are literal; bare is bare.
    if (v.startsWith('"') && v.endsWith('"')) { try { out[m[1]] = JSON.parse(v); continue; } catch { /* fall through */ } }
    out[m[1]] = v.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Set (or, with "", remove) keys in .env, leaving every other line alone.
    Returns the keys actually written. Also updates process.env so the
    calling process sees the new values without a restart. */
export function writeEnvFile(root: string, set: Record<string, string | undefined>): string[] {
  const file = path.join(root, ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const written: string[] = [];
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    const i = lines.findIndex((l) => l.startsWith(k + "="));
    // Quote when the value has anything a shell-ish parser would trip on.
    const line = `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`;
    if (v === "") { if (i >= 0) lines.splice(i, 1); delete process.env[k]; }
    else { if (i >= 0) lines[i] = line; else lines.push(line); process.env[k] = v; }
    written.push(k);
  }
  fs.writeFileSync(file, lines.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  // `mode` above only applies to a new file; an existing .env keeps whatever
  // it had. Credentials went in, so: owner-only, every time.
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  return written;
}

/** Which of these names are not set (missing or blank) in .env + the environment. */
export function missingSecrets(root: string, names: string[]): string[] {
  const file = readEnvFile(root);
  return names.filter((n) => !(process.env[n]?.trim() || file[n]?.trim()));
}
