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

test("a failed load from an ad or tracking server never decides the ending; the app's own still does", () => {
  const ssl = "Failed to load resource: net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH";
  assert.equal(isNonVisualResourceError(ssl, "https://cm.g.doubleclick.net/partnerpixels?x=1"), true);
  assert.equal(isNonVisualResourceError(ssl, "https://ads.pubmatic.com/AdServer/js/user_sync.html"), true);
  assert.equal(isNonVisualResourceError(ssl, "https://grid.bidswitch.net/hbjson"), true);
  assert.equal(isNonVisualResourceError("Failed to load resource: the server responded with a status of 409 ()", "https://api.gdevelop-app.com/analytics/session"), true, "an analytics endpoint only reports");
  assert.equal(isNonVisualResourceError(ssl, "https://gd.games/assets/hero.png"), false, "the app's own asset failing may be on screen");
  assert.equal(isNonVisualResourceError(ssl), false, "with no URL, it cannot be excused");
  assert.equal(isNonVisualResourceError("Uncaught TypeError: x is undefined", "https://cm.g.doubleclick.net/a.js"), false, "only failed loads, never script errors");
});
