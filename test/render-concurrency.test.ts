/** Frame grabs must not scale with the manifest. Unbounded was not just
    reckless — measured on a 65-scene demo it was 13.1s against 5.5s at eight,
    sixty-five decoders fighting over one file and eight cores. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STILL_WORKERS, inBatches } from "../src/render.js";

test("never more than the limit at once, however long the demo", async () => {
  let now = 0, most = 0;
  const items = Array.from({ length: 200 }, (_, i) => i);
  await inBatches(items, 8, async () => {
    now++; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 1));
    now--;
  });
  assert.equal(most, 8, `ran ${most} at once`);
});

test("everything still runs, exactly once", async () => {
  const seen: number[] = [];
  await inBatches([1, 2, 3, 4, 5, 6, 7], 3, async (i) => { seen.push(i); });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});

test("fewer items than workers is fine, and an empty list does not hang", async () => {
  let ran = 0;
  await inBatches([1, 2], 8, async () => { ran++; });
  assert.equal(ran, 2);
  await inBatches([], 8, async () => { ran++; });
  assert.equal(ran, 2);
});

test("the limit is a real number, chosen near a core count", () => {
  assert.ok(STILL_WORKERS >= 4 && STILL_WORKERS <= 16, `${STILL_WORKERS} is not a plausible measured limit`);
});
