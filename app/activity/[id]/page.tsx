"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NETWORK } from "@/lib/constants";
import { formatBtc } from "@/lib/format";

type RedeemStatus = "burned" | "broadcasting" | "sent" | "stalled";

interface RedeemDetail {
  id: string;
  destinationBtcAddress: string | null;
  amount: string;
  btcTxId: string | null;
  status: RedeemStatus;
  createdAt: string;
  requestSeenAt: string | null;
  btcConfirmedAt: string | null;
}

function btcExplorerTxUrl(txId: string | null | undefined): string | null {
  if (!txId) return null;
  const id = encodeURIComponent(txId.trim());
  switch (NETWORK.name) {
    case "mainnet":
      return `https://mempool.space/tx/${id}`;
    case "testnet":
      return `https://mempool.space/testnet/tx/${id}`;
    default:
      return null;
  }
}

function btcExplorerAddressUrl(address: string | null | undefined): string | null {
  if (!address) return null;
  const addr = encodeURIComponent(address.trim());
  switch (NETWORK.name) {
    case "mainnet":
      return `https://mempool.space/address/${addr}`;
    case "testnet":
      return `https://mempool.space/testnet/address/${addr}`;
    default:
      return null;
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const TITLE: Record<RedeemStatus, string> = {
  burned: "Redemption in progress",
  broadcasting: "Redemption in progress",
  sent: "Bitcoin sent",
  stalled: "Taking longer than expected",
};

export default function RedeemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [redeem, setRedeem] = useState<RedeemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/redeem/${id}`);
        const data = (await res.json()) as {
          redeem?: RedeemDetail;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.redeem) {
          setError(data.error ?? "Redemption not found.");
        } else {
          setRedeem(data.redeem);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link
        href="/activity"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to activity
      </Link>

      <h1 className="text-2xl font-semibold">Redemption</h1>

      {loading && (
        <div className="h-48 animate-pulse rounded-md border bg-muted/30" />
      )}

      {!loading && error && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      )}

      {!loading && redeem && (
        <Card>
          <CardHeader>
            <CardTitle
              className={redeem.status === "sent" ? "text-green-600" : ""}
            >
              {TITLE[redeem.status]}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Amount</div>
                <div className="font-medium">
                  {formatBtc(redeem.amount)} cBTC
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Destination</div>
                <div className="break-all font-mono text-xs">
                  {redeem.destinationBtcAddress ?? "—"}
                </div>
              </div>
            </div>

            {/* Step timeline with real timestamps. */}
            <ol className="space-y-3">
              <Step
                done
                title={`Burned ${formatBtc(redeem.amount)} cBTC`}
                detail="cBTC destroyed on Canton."
                time={fmtTime(redeem.createdAt)}
              />
              <Step
                done={redeem.status !== "burned"}
                active={redeem.status === "burned"}
                title="Attestor prepared transaction"
                detail={
                  redeem.status === "burned"
                    ? "Waiting for the bridge to pick up your redemption…"
                    : "The bridge assigned a Bitcoin transaction."
                }
                time={fmtTime(redeem.requestSeenAt)}
              />
              <Step
                done={redeem.status === "sent"}
                active={redeem.status === "broadcasting"}
                error={redeem.status === "stalled"}
                title="Bitcoin broadcast"
                detail={
                  redeem.status === "sent"
                    ? "Confirmed on the Bitcoin network."
                    : redeem.status === "stalled"
                      ? "The transaction hasn't appeared on-chain yet."
                      : "Broadcasting to the Bitcoin network…"
                }
                time={fmtTime(redeem.btcConfirmedAt)}
              />
            </ol>

            {redeem.btcTxId && (
              <div className="space-y-1 rounded-lg border bg-muted/40 px-3 py-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Bitcoin transaction
                </p>
                <p className="break-all font-mono text-xs">{redeem.btcTxId}</p>
                {(() => {
                  const url = btcExplorerTxUrl(redeem.btcTxId);
                  return url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block text-sm underline"
                    >
                      View transaction on mempool.space ↗
                    </a>
                  ) : null;
                })()}
              </div>
            )}

            {(() => {
              const url = btcExplorerAddressUrl(redeem.destinationBtcAddress);
              return url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-sm underline"
                >
                  Track the destination address ↗
                </a>
              ) : null;
            })()}

            {redeem.status === "stalled" && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
                The bridge assigned a Bitcoin transaction but it hasn&apos;t been
                broadcast yet. Your cBTC is burned and the redemption is recorded
                on Canton — this is a delay on the bridge&apos;s side. If it
                doesn&apos;t clear soon, contact{" "}
                <a href="mailto:support@bitsafe.finance" className="underline">
                  support@bitsafe.finance
                </a>{" "}
                with the transaction ID above.
              </p>
            )}

            <Link href="/activity" className="block">
              <Button variant="outline" className="w-full">
                Back to activity
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Step({
  done = false,
  active = false,
  error = false,
  title,
  detail,
  time,
}: {
  done?: boolean;
  active?: boolean;
  error?: boolean;
  title: string;
  detail: string;
  time: string;
}) {
  const mark = error ? "!" : done ? "✓" : active ? "…" : "";
  const markClass = error
    ? "border-amber-400 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
    : done
      ? "border-green-500 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
      : active
        ? "border-foreground/40 bg-muted text-foreground"
        : "border-muted-foreground/30 text-muted-foreground/50";

  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${markClass}`}
      >
        {mark}
      </span>
      <span className="flex-1 space-y-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={`text-sm font-medium ${
              done || active || error ? "" : "text-muted-foreground/60"
            }`}
          >
            {title}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {time}
          </span>
        </span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}
