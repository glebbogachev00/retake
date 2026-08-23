/** Credentials: written locally, read by the engine, never by a model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvFile, writeEnvFile, missingSecrets, SECRET_NAME } from "../src/env.js";
import { expandEnv, totp } from "../src/manifest.js";

test("writeEnvFile round-trips awkward values, quotes them, keeps other lines, mode 600", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retake-env-"));
  fs.writeFileSync(path.join(root, ".env"), "# keep me\nRETAKE_MODEL=claude-code\nAPP_USER=\n");
  writeEnvFile(root, { APP_USER: "demo@example.com", APP_PASSWORD: "p4ss #1 'q' \"dq\"" });
  const back = readEnvFile(root);
  assert.equal(back.APP_USER, "demo@example.com");
  assert.equal(back.APP_PASSWORD, "p4ss #1 'q' \"dq\"");
  assert.equal(back.RETAKE_MODEL, "claude-code");
  assert.match(fs.readFileSync(path.join(root, ".env"), "utf8"), /^# keep me\n/);
  assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
  writeEnvFile(root, { APP_PASSWORD: "" });
  assert.equal(readEnvFile(root).APP_PASSWORD, undefined, "empty removes the key");
});

test("a blank APP_USER= in .env counts as missing, and expandEnv refuses it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retake-env-"));
  fs.writeFileSync(path.join(root, ".env"), "APP_USER=\nAPP_PASSWORD=x\n");
  delete process.env.APP_USER; delete process.env.APP_PASSWORD;
  assert.deepEqual(missingSecrets(root, ["APP_USER", "APP_PASSWORD"]), ["APP_USER"]);
  process.env.APP_USER = "";
  assert.throws(() => expandEnv("${APP_USER}"), /not set/);
  delete process.env.APP_USER;
});

test("secret names are UPPER_SNAKE only", () => {
  for (const ok of ["APP_USER", "APP_TOTP_SECRET", "X1"]) assert.ok(SECRET_NAME.test(ok), ok);
  for (const bad of ["app_user", "APP USER", "../x", "A"]) assert.ok(!SECRET_NAME.test(bad), bad);
});

test("${TOTP:NAME} computes RFC 6238 codes from a base32 secret", () => {
  const rfc = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
  assert.equal(totp(rfc, 59_000), "287082");
  assert.equal(totp(rfc, 1111111109_000), "081804");
  assert.equal(totp(rfc, 1234567890_000), "005924");
  process.env.APP_TOTP_SECRET = rfc;
  assert.match(expandEnv("${TOTP:APP_TOTP_SECRET}"), /^\d{6}$/);
  delete process.env.APP_TOTP_SECRET;
});
