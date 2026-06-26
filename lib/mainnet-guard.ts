import "server-only";

import { NextResponse } from "next/server";

import { NETWORK } from "@/lib/constants";

/** Mirrors swap-solver ALLOW_MAINNET gate for server-side fund routes. */
export function isWebMainnetAllowed(): boolean {
  if (NETWORK.name !== "mainnet") return true;
  return process.env.ALLOW_MAINNET === "true";
}

export function mainnetBlockedResponse(): NextResponse | null {
  if (isWebMainnetAllowed()) return null;
  return NextResponse.json(
    {
      error: mainnetBlockedMessage()
    },
    { status: 503 }
  );
}

export function mainnetBlockedMessage(): string {
  return "Mainnet operations are disabled. Set ALLOW_MAINNET=true on the server to enable real-funds mode.";
}

export function assertWebMainnetAllowed(): void {
  if (!isWebMainnetAllowed()) {
    throw new Error(mainnetBlockedMessage());
  }
}
