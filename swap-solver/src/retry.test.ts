import { test } from "node:test";
import assert from "node:assert/strict";

import { retry, isTransientError } from "./retry.js";

test("isTransientError: retries network/5xx/synchronizer", () => {
  assert.ok(isTransientError(new Error("fetch failed")));
  assert.ok(isTransientError(new Error("Connect Timeout Error")));
  assert.ok(isTransientError(new Error("503 Service Unavailable")));
  assert.ok(isTransientError(new Error("NOT_CONNECTED_TO_ANY_SYNCHRONIZER")));
  assert.ok(isTransientError(new Error("rate limit exceeded")));
});

test("isTransientError: does NOT retry deterministic failures", () => {
  assert.ok(!isTransientError(new Error("NotProven")));
  assert.ok(!isTransientError(new Error("insufficient CBTC float")));
  assert.ok(
    !isTransientError(new Error("Canton party does not match the recipient"))
  );
  assert.ok(!isTransientError(new Error("nonce too low")));
});

test("retry: succeeds after transient failures", async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("fetch failed");
      return "ok";
    },
    { retries: 5, baseMs: 1, maxMs: 5 }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("retry: gives up after max retries and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error("timeout");
      },
      { retries: 2, baseMs: 1, maxMs: 2 }
    ),
    /timeout/
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("retry: does NOT retry a deterministic error (fails fast)", async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error("NotProven");
      },
      { retries: 5, baseMs: 1 }
    ),
    /NotProven/
  );
  assert.equal(calls, 1); // no retries — failed fast
});

test("retry: returns immediately on first success", async () => {
  let calls = 0;
  const r = await retry(async () => {
    calls++;
    return 42;
  });
  assert.equal(r, 42);
  assert.equal(calls, 1);
});
