/** When Microsoft's voice service refuses, the person reads what to do —
    not a command line with their whole script pasted into it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeFailure } from "../src/voice.js";

const REFUSED = `Traceback (most recent call last):
  ...
aiohttp.client_exceptions.WSServerHandshakeError: 403, message='Invalid response status', url='wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=x'`;

test("a refused voice request names the upgrade, not the script", () => {
  const m = edgeFailure(REFUSED, "edge-tts");
  assert.match(m, /refused the request \(403\)/);
  assert.match(m, /pipx upgrade edge-tts/);
  assert.doesNotMatch(m, /speech\.platform|Traceback/);
  assert.match(edgeFailure(REFUSED, "python3"), /pip install -U edge-tts/);
});

test("no network says so; anything else keeps its last line", () => {
  assert.match(edgeFailure("aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host", "edge-tts"), /could not reach/);
  assert.equal(edgeFailure("ValueError: Invalid voice 'xx'\n", "edge-tts"), "voiceover: edge-tts failed — ValueError: Invalid voice 'xx'");
});
