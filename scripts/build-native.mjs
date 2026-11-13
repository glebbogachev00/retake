// Builds Retake's Mac capture helper from source: native/capture → native/bin/retake-capture.
// Mac only, needs Xcode's command-line tools. Until the helper ships signed and
// notarized, this is how it is made; `retake doctor` says when it is missing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") { console.log("· the capture helper is Mac only; skipped"); process.exit(0); }
const out = path.join(root, "native", "bin", "retake-capture");
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync("xcrun", ["swiftc", "-O", "-swift-version", "5", path.join(root, "native", "capture", "retake-capture.swift"), "-o", out], { stdio: "inherit" });
console.log(`✓ ${path.relative(process.cwd(), out)}`);
