/** Saved logins: one per site, kept where the computer keeps passwords.

    A demo behind a login needs a username and a password every time its
    session runs out. Before this they lived in each workspace's `.env`, in
    plain text, typed again for every new workspace. Now a login is saved
    once per site — like a password manager — and every demo of that site,
    in any workspace, signs in with it:

      macOS   the login Keychain (`security`), one item per field
      Linux   the Secret Service (`secret-tool`), when there is one
      else    ~/.config/retake/logins.json, readable by this user only

    A manifest references a saved login as ${LOGIN_USER}, ${LOGIN_PASSWORD}
    and ${TOTP:LOGIN_TOTP} inside `auth.setup` with `secret: true`. The site
    is the demo's own URL, so the agent never names it and never sees a
    value. A `.env` value of the same name still wins, so nothing that
    worked before changes.

    Values never go on a command line (other processes can read those):
    they reach `security` and `secret-tool` on stdin. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const LOGIN_FIELDS = { LOGIN_USER: "user", LOGIN_PASSWORD: "password", LOGIN_TOTP: "totp" } as const;
export type LoginField = (typeof LOGIN_FIELDS)[keyof typeof LOGIN_FIELDS];
export type Login = Partial<Record<LoginField, string>>;
const FIELDS: LoginField[] = ["user", "password", "totp"];

/** The site a URL signs in to: its host, with the port — two local apps on
    two ports are two different logins. */
export function siteOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return url.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, ""); }
}

/** A site as a file name, for its saved session. */
export const siteSlug = (site: string) => site.replace(/[^a-z0-9.-]+/gi, "-");

function configDir(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "retake");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "retake");
}

// ---------- where the values go ----------

interface Store {
  readonly where: string;
  get(site: string, field: LoginField): string | undefined;
  set(site: string, field: LoginField, value: string): void;
  remove(site: string, field: LoginField): void;
}

const has = (bin: string) => spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

/** Keychain items are read back with `-w`, which prints anything outside
    plain ASCII as hex. Such values are stored base64 behind a marker. */
const B64 = "retake-b64:";
const pack = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : B64 + Buffer.from(v, "utf8").toString("base64"));
const unpack = (v: string) => (v.startsWith(B64) ? Buffer.from(v.slice(B64.length), "base64").toString("utf8") : v);
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const keychain: Store = {
  where: "your Mac's Keychain",
  get(site, field) {
    const r = spawnSync("security", ["find-generic-password", "-s", `retake:${site}`, "-a", field, "-w"], { encoding: "utf8" });
    return r.status === 0 ? unpack(r.stdout.replace(/\n$/, "")) : undefined;
  },
  set(site, field, value) {
    const cmd = `add-generic-password -U -s ${quote(`retake:${site}`)} -a ${quote(field)} -l ${quote(`Retake — ${site}`)} -w ${quote(pack(value))}\n`;
    const r = spawnSync("security", ["-i"], { input: cmd, encoding: "utf8" });
    if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`the Keychain refused the ${field} for ${site}: ${r.stderr.trim() || "exit " + r.status}`);
  },
  remove(site, field) {
    spawnSync("security", ["delete-generic-password", "-s", `retake:${site}`, "-a", field], { encoding: "utf8" });
  },
};

const secretService: Store = {
  where: "your system keyring",
  get(site, field) {
    const r = spawnSync("secret-tool", ["lookup", "app", "retake", "site", site, "field", field], { encoding: "utf8" });
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : undefined;
  },
  set(site, field, value) {
    const r = spawnSync("secret-tool", ["store", `--label=Retake — ${site} (${field})`, "app", "retake", "site", site, "field", field], { input: value, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`the keyring refused the ${field} for ${site}: ${r.stderr.trim() || "exit " + r.status}`);
  },
  remove(site, field) {
    spawnSync("secret-tool", ["clear", "app", "retake", "site", site, "field", field], { encoding: "utf8" });
  },
};

function fileStore(file: string): Store {
  const read = (): Record<string, Login> => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  const write = (all: Record<string, Login>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  };
  return {
    where: `${file} (readable by you only)`,
    get: (site, field) => read()[site]?.[field],
    set(site, field, value) { const all = read(); (all[site] ??= {})[field] = value; write(all); },
    remove(site, field) {
      const all = read();
      if (!all[site]) return;
      delete all[site][field];
      if (!Object.keys(all[site]).length) delete all[site];
      write(all);
    },
  };
}

let chosen: Store | null = null;
function store(): Store {
  // RETAKE_LOGIN_FILE: a plain file instead — for tests, and for machines
  // whose keyring cannot be reached (a server, a container).
  if (process.env.RETAKE_LOGIN_FILE) return fileStore(process.env.RETAKE_LOGIN_FILE);
  if (chosen) return chosen;
  if (process.platform === "darwin" && has("security")) chosen = keychain;
  else if (process.platform === "linux" && has("secret-tool") && process.env.DBUS_SESSION_BUS_ADDRESS) chosen = secretService;
  else chosen = fileStore(path.join(configDir(), "logins.json"));
  return chosen;
}

/** Where a saved login is kept, in words a person reads. */
export const loginStoreName = () => store().where;

// ---------- which sites have one (names only, never values) ----------

const indexFile = () => process.env.RETAKE_LOGIN_FILE ? process.env.RETAKE_LOGIN_FILE + ".sites" : path.join(configDir(), "login-sites.json");
type Index = Record<string, { fields: LoginField[]; saved: string }>;
function readIndex(): Index { try { return JSON.parse(fs.readFileSync(indexFile(), "utf8")); } catch { return {}; } }
function writeIndex(ix: Index) {
  fs.mkdirSync(path.dirname(indexFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(indexFile(), JSON.stringify(ix, null, 2) + "\n", { mode: 0o600 });
}

/** The sites with a saved login, and which fields each has. */
export function listLogins(): { site: string; fields: LoginField[]; saved: string }[] {
  return Object.entries(readIndex()).map(([site, v]) => ({ site, ...v })).sort((a, b) => a.site.localeCompare(b.site));
}

// ---------- the API ----------

const cache = new Map<string, string | undefined>();

export function readLogin(site: string, field: LoginField): string | undefined {
  const key = `${site}\0${field}`;
  if (!cache.has(key)) cache.set(key, store().get(site, field));
  return cache.get(key);
}

/** Save (or replace) a site's login. Blank fields are left as they were,
    except that a new username without a code drops a stale code. */
export function saveLogin(site: string, login: Login): LoginField[] {
  const saved: LoginField[] = [];
  for (const f of FIELDS) {
    const v = login[f];
    if (v === undefined || v === "") continue;
    if (/[\r\n]/.test(v)) throw new Error(`the ${f} has a line break in it — paste it again on one line`);
    store().set(site, f, f === "totp" ? v.replace(/\s+/g, "") : v);
    cache.delete(`${site}\0${f}`);
    saved.push(f);
  }
  if (!saved.length) return saved;
  const ix = readIndex();
  const fields = new Set([...(ix[site]?.fields ?? []), ...saved]);
  ix[site] = { fields: FIELDS.filter((f) => fields.has(f)), saved: new Date().toISOString() };
  writeIndex(ix);
  return saved;
}

export function forgetLogin(site: string): boolean {
  const ix = readIndex();
  const known = !!ix[site];
  for (const f of FIELDS) { store().remove(site, f); cache.delete(`${site}\0${f}`); }
  delete ix[site];
  writeIndex(ix);
  return known;
}

/** Whether a site has a username and a password saved. */
export function hasLogin(site: string): boolean {
  return !!readLogin(site, "user") && !!readLogin(site, "password");
}

/** The ${…} names a saved login answers, for the agent. */
export function loginNames(site: string): string[] {
  return [`\${LOGIN_USER}`, `\${LOGIN_PASSWORD}`, ...(readLogin(site, "totp") ? [`\${TOTP:LOGIN_TOTP}`] : [])];
}
