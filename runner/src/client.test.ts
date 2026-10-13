import { test } from "node:test";
import assert from "node:assert/strict";
import { reconnectDelay } from "./client.ts";

test("reconnect backoff grows, caps at 30s and is jittered (50-100% of the step)", () => {
  assert.equal(reconnectDelay(0, () => 1), 1_000);
  assert.equal(reconnectDelay(0, () => 0), 500);
  assert.equal(reconnectDelay(3, () => 1), 8_000);
  assert.equal(reconnectDelay(10, () => 1), 30_000);
  assert.equal(reconnectDelay(1_000, () => 1), 30_000);
  assert.equal(reconnectDelay(10, () => 0), 15_000);
  for (let i = 0; i < 50; i++) {
    const d = reconnectDelay(i % 8);
    assert.ok(d >= 500 && d <= 30_000, String(d));
  }
});
