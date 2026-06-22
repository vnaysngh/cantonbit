import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyNetworkFeeBuffer,
  assertNetworkFeeNotionalGuard,
  capNetworkFeeAtOrder,
  isNetworkFeeEnabled,
  minCcRequiredForNetworkFee,
  networkFeeBufferBps,
  shouldQuoteNetworkFee,
  trafficBytesToCcRaw,
  trafficBytesToFeeCc
} from "./canton-network-fee-math";

test("trafficBytesToCcRaw converts bytes via USD/MB and amulet price", () => {
  // 1 MB at $60/MB = $60; at $0.05/CC = 1200 CC
  const cc = trafficBytesToCcRaw({
    trafficBytes: 1_000_000,
    extraTrafficPriceUsdPerMb: 60,
    amuletPriceUsd: 0.05
  });
  assert.ok(Math.abs(cc - 1200) < 0.001);
});

test("applyNetworkFeeBuffer adds 15% by default bps", () => {
  assert.equal(applyNetworkFeeBuffer(1, 1500), "1.15");
});

test("trafficBytesToFeeCc returns feeUsd", () => {
  const { feeCc, feeUsd } = trafficBytesToFeeCc({
    trafficBytes: 500_000,
    extraTrafficPriceUsdPerMb: 60,
    amuletPriceUsd: 0.05,
    bufferBps: 0
  });
  assert.ok(Number.parseFloat(feeCc) > 0);
  assert.equal(feeUsd, 30);
});

test("minCcRequiredForNetworkFee adds reserve", () => {
  const prevEnabled = process.env.NETWORK_FEE_ENABLED;
  const prevReserve = process.env.NETWORK_FEE_RESERVE_CC;
  process.env.NETWORK_FEE_ENABLED = "1";
  process.env.NETWORK_FEE_RESERVE_CC = "5";
  assert.equal(minCcRequiredForNetworkFee("1.5"), "6.5");
  if (prevEnabled == null) delete process.env.NETWORK_FEE_ENABLED;
  else process.env.NETWORK_FEE_ENABLED = prevEnabled;
  if (prevReserve == null) delete process.env.NETWORK_FEE_RESERVE_CC;
  else process.env.NETWORK_FEE_RESERVE_CC = prevReserve;
});

test("assertNetworkFeeNotionalGuard rejects fees above the configured ratio", () => {
  assert.throws(() =>
    assertNetworkFeeNotionalGuard({
      feeUsd: 5,
      notionalUsd: 10,
      maxBps: 200
    })
  );
  assert.doesNotThrow(() =>
    assertNetworkFeeNotionalGuard({
      feeUsd: 0.1,
      notionalUsd: 10,
      maxBps: 200
    })
  );
});

test("capNetworkFeeAtOrder never charges above stored bound", () => {
  assert.equal(capNetworkFeeAtOrder("1.5", "2.0"), "1.5");
  assert.equal(capNetworkFeeAtOrder("2.0", "1.5"), "1.5");
});

test("capNetworkFeeAtOrder treats stored zero as explicit free-tier cap", () => {
  assert.equal(capNetworkFeeAtOrder("0", "1.5"), "0");
  assert.equal(capNetworkFeeAtOrder(undefined, "1.5"), "1.5");
});

test("shouldQuoteNetworkFee is true when preview enabled without collection", () => {
  const prevEnabled = process.env.NETWORK_FEE_ENABLED;
  const prevPreview = process.env.NETWORK_FEE_QUOTE_PREVIEW;
  process.env.NETWORK_FEE_ENABLED = "0";
  process.env.NETWORK_FEE_QUOTE_PREVIEW = "1";
  assert.equal(shouldQuoteNetworkFee(), true);
  if (prevEnabled == null) delete process.env.NETWORK_FEE_ENABLED;
  else process.env.NETWORK_FEE_ENABLED = prevEnabled;
  if (prevPreview == null) delete process.env.NETWORK_FEE_QUOTE_PREVIEW;
  else process.env.NETWORK_FEE_QUOTE_PREVIEW = prevPreview;
});

test("networkFeeBufferBps parses inline comments from dotenv files", () => {
  const prev = process.env.NETWORK_FEE_BUFFER_BPS;
  process.env.NETWORK_FEE_BUFFER_BPS = "1000  # +10%";
  assert.equal(networkFeeBufferBps(), 1000);
  if (prev == null) delete process.env.NETWORK_FEE_BUFFER_BPS;
  else process.env.NETWORK_FEE_BUFFER_BPS = prev;
});

test("network fee flags parse inline comments from dotenv files", () => {
  const prev = process.env.NETWORK_FEE_ENABLED;
  process.env.NETWORK_FEE_ENABLED = "1  # collect fees";
  assert.equal(isNetworkFeeEnabled(), true);
  process.env.NETWORK_FEE_ENABLED = "0  # disabled";
  assert.equal(isNetworkFeeEnabled(), false);
  if (prev == null) delete process.env.NETWORK_FEE_ENABLED;
  else process.env.NETWORK_FEE_ENABLED = prev;
});

test("minCcRequiredForNetworkFee returns 0 when feature disabled", () => {
  const prevEnabled = process.env.NETWORK_FEE_ENABLED;
  const prevPreview = process.env.NETWORK_FEE_QUOTE_PREVIEW;
  process.env.NETWORK_FEE_ENABLED = "0";
  process.env.NETWORK_FEE_QUOTE_PREVIEW = "0";
  assert.equal(minCcRequiredForNetworkFee("5"), "0");
  assert.equal(shouldQuoteNetworkFee(), false);
  if (prevEnabled == null) delete process.env.NETWORK_FEE_ENABLED;
  else process.env.NETWORK_FEE_ENABLED = prevEnabled;
  if (prevPreview == null) delete process.env.NETWORK_FEE_QUOTE_PREVIEW;
  else process.env.NETWORK_FEE_QUOTE_PREVIEW = prevPreview;
});
