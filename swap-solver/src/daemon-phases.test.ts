import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runDaemonPhases } from "./daemon-phases.js";

test("runDaemonPhases is serial and attempts the second phase after failure", async () => {
  const events: string[] = [];
  await assert.rejects(
    runDaemonPhases([
      [
        "expire/reconcile",
        async () => {
          events.push("expire:start");
          await Promise.resolve();
          events.push("expire:end");
          throw new Error("expire failed");
        }
      ],
      [
        "fill",
        async () => {
          events.push("fill:start");
          await Promise.resolve();
          events.push("fill:end");
        }
      ]
    ]),
    /expire\/reconcile: expire failed/
  );
  assert.deepEqual(events, [
    "expire:start",
    "expire:end",
    "fill:start",
    "fill:end"
  ]);
});

test("runDaemonPhases reports failures from every phase", async () => {
  await assert.rejects(
    runDaemonPhases([
      ["one", async () => Promise.reject(new Error("first"))],
      ["two", async () => Promise.reject(new Error("second"))]
    ]),
    /one: first; two: second/
  );
});
