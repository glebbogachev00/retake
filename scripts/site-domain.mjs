#!/usr/bin/env node
/**
 * Stamp the real domain into the landing page's absolute URLs.
 *
 * Social cards need absolute URLs — a scraper cannot resolve a relative
 * og:image — but the domain is only known once it is bought. Everything
 * else on the page is relative on purpose, so this touches exactly the
 * tags that must not be.
 *
 *   node scripts/site-domain.mjs retake.dev
 *
 * Re-runnable: it rewrites whatever host is there now.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raw = process.argv[2];
if (!raw) { console.error("usage: node scripts/site-domain.mjs <domain>   (e.g. retake.dev)"); process.exit(1); }
const host = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) { console.error(`"${raw}" does not look like a domain`); process.exit(1); }

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site", "index.html");
const before = fs.readFileSync(file, "utf8");
const after = before.replace(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/(?:og\.png)?)(?=")/gi, (m, tail) => `https://${host}${tail}`);
const n = (before.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/(?:og\.png)?(?=")/gi) ?? []).length;
fs.writeFileSync(file, after);
console.log(`site: ${n} absolute URL(s) now point at https://${host}`);
console.log(after.includes("retake.example.com") ? "⚠ placeholder still present — check site/index.html" : "✓ no placeholder left");
