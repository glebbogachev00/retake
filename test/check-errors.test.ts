import { test } from "node:test";
import assert from "node:assert/strict";
import { isNonVisualResourceError } from "../src/render.js";

test("transient browser resource failures do not masquerade as visible app errors", () => {
  for (const text of [
    "Failed to load resource: net::ERR_CONNECTION_CLOSED",
    "Failed to load resource: net::ERR_CONNECTION_RESET",
    "Failed to load resource: net::ERR_ABORTED",
    "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT",
  ]) assert.equal(isNonVisualResourceError(text), true, text);
});

test("real application and server errors remain blocking", () => {
  for (const text of [
    "TypeError: total is undefined",
    "Failed to fetch account balance",
    "500 Internal Server Error",
    "Failed to load resource: net::ERR_CERT_INVALID",
  ]) assert.equal(isNonVisualResourceError(text), false, text);
});
