import test from "node:test";
import assert from "node:assert/strict";
import { browserLaunchOptions } from "../src/record.js";

test("macOS recording enables Metal instead of SwiftShader", () => {
  assert.deepEqual(browserLaunchOptions("darwin"), {
    headless: true,
    args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"],
  });
});

test("other platforms keep Playwright defaults", () => {
  assert.deepEqual(browserLaunchOptions("linux"), { headless: true });
  assert.deepEqual(browserLaunchOptions("win32"), { headless: true });
});
