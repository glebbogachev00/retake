/** What to call a group of journeys, in words rather than an address.

    Journeys about one app usually start their titles the same way
    ("Shop – checkout: …", "Shop – account: …"), so that shared start is
    the group's name, and each journey is called by the rest of its title
    ("Checkout: pay by card"). With nothing shared, the app's address
    gives a name ("larkspur.localhost:4471" is Larkspur). The address itself
    is kept for a hover and the journey's own page. */

const cap = (s: string) => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
const clean = (s: string) => s.replace(/[\s,:;–—-]+$/u, "").trim();

/** A readable name from an address: its first meaningful word. */
export function hostName(host: string | null): string | null {
  if (!host) return null;
  const bare = host.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(bare) || bare === "localhost") return null;
  const parts = bare.split(".").filter((p) => !/^(www|app|login|auth|my)$/.test(p));
  const word = parts.length > 2 ? parts[0] : parts[0] ?? bare;
  return cap(word.replace(/-/g, " "));
}

export function groupName(titles: string[], host: string | null): { name: string; short: (title: string) => string } {
  const keep = { short: (t: string) => t };
  if (!titles.length) return { name: hostName(host) ?? host ?? "Other journeys", ...keep };
  // "Shop – checkout: pay by card": the part before the dash, when every title has the same one.
  const heads = titles.map((t) => /^(.+?)\s+[–—-]\s+(.+)$/u.exec(t));
  if (heads.every((m) => m) && new Set(heads.map((m) => m![1])).size === 1) {
    const name = heads[0]![1];
    return { name, short: (t) => { const m = /^(.+?)\s+[–—-]\s+(.+)$/u.exec(t); return m && m[1] === name ? cap(m[2]) : t; } };
  }
  // "Sign-in screens" and "Sign-in screens, on a phone": the words they all start with.
  if (titles.length > 1) {
    const words = titles.map((t) => t.split(/\s+/));
    let n = 0;
    while (words.every((w) => w[n] !== undefined && w[n].replace(/,$/, "") === words[0][n].replace(/,$/, ""))) n++;
    // Small words at the end say nothing about the app ("See the" is not a name), and one word rarely does.
    const kept = words[0].slice(0, n).map((w) => w.replace(/,$/, ""));
    while (kept.length && /^(the|a|an|of|to|and|in|on|for|with)$/i.test(kept.at(-1)!)) kept.pop();
    const name = clean(kept.join(" "));
    if (kept.length >= 2 && name.length >= 3) return { name, short: (t) => { if (!t.startsWith(name)) return t; const rest = clean(t.slice(name.length).replace(/^[\s,:;–—-]+/u, "")); return rest ? cap(rest) : t; } };
  }
  return { name: hostName(host) ?? host ?? "Other journeys", ...keep };
}
