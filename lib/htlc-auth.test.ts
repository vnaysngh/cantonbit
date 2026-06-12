import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isBearerAuthorized } from "./htlc-auth-logic";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) old[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("isDaemonAuthorized: production without a secret fails closed", () => {
  withEnv({ NODE_ENV: "production", HTLC_DAEMON_SECRET: undefined, CRON_SECRET: undefined }, () => {
    assert.equal(isBearerAuthorized({ header: null, secret: "", nodeEnv: process.env.NODE_ENV }), false);
  });
});

test("isDaemonAuthorized: accepts exact bearer token", () => {
  withEnv({ NODE_ENV: "production", HTLC_DAEMON_SECRET: "s3cr3t", CRON_SECRET: undefined }, () => {
    assert.equal(isBearerAuthorized({
      header: "Bearer s3cr3t",
      secret: process.env.HTLC_DAEMON_SECRET ?? "",
      nodeEnv: process.env.NODE_ENV,
    }), true);
  });
});

test("isDaemonAuthorized: rejects wrong bearer token", () => {
  withEnv({ NODE_ENV: "production", HTLC_DAEMON_SECRET: "s3cr3t", CRON_SECRET: undefined }, () => {
    assert.equal(isBearerAuthorized({
      header: "Bearer wrong",
      secret: process.env.HTLC_DAEMON_SECRET ?? "",
      nodeEnv: process.env.NODE_ENV,
    }), false);
  });
});
