"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useWallet } from "@/hooks/useWallet";
import { truncatePartyId } from "@/lib/format";
import {
  getQuote, submitOrder, getOrder, isTerminal, STATUS_LABEL,
  type QuoteResponse, type OrderView, type SwapStatus,
} from "@/lib/swap-api";
import {
  PERMIT2_ADDRESS, BASE_SEPOLIA_CHAIN_ID,
  encodeApprove, encodeAllowance, encodeBalanceOf, decodeUint,
  formatWbtc, parseWbtc,
} from "@/lib/swap-evm";

type Stage =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: QuoteResponse }
  | { kind: "approving"; quote: QuoteResponse }
  | { kind: "signing"; quote: QuoteResponse }
  | { kind: "submitting"; quote: QuoteResponse }
  | { kind: "tracking"; orderId: string; order: OrderView | null }
  | { kind: "error"; message: string };

/** The ordered set of statuses for the progress display. */
const FLOW: SwapStatus[] = ["seen", "delivering", "delivered", "attested", "finalised"];

export default function SwapPage() {
  const evm = useEvmWallet();
  const wallet = useWallet();

  // DESTINATION party for the delivered cBTC = the user's CONNECTED LOOP WALLET
  // party. Both the Loop wallet and the swap solver run on devnet, so the solver
  // can deliver to it (and the user accepts the incoming cBTC in their own Loop
  // wallet). NEXT_PUBLIC_SWAP_DEST_PARTY remains an optional override for testing
  // against a fixed party.
  const destinationParty = process.env.NEXT_PUBLIC_SWAP_DEST_PARTY ?? wallet.partyId;
  const loopConnected = wallet.isConnected && !!wallet.partyId;

  const [amount, setAmount] = useState("0.0001");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [wbtcBalance, setWbtcBalance] = useState<bigint | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const wrongChain = evm.chainId != null && evm.chainId !== BASE_SEPOLIA_CHAIN_ID;

  // --- read WBTC balance once connected + quoted (so we know the token addr) ---
  const refreshBalance = useCallback(async (wbtc: string) => {
    if (!evm.account) return;
    try {
      const bal = decodeUint(await evm.call(wbtc, encodeBalanceOf(evm.account)));
      setWbtcBalance(bal);
    } catch { /* non-fatal */ }
  }, [evm]);

  // --- cleanup polling on unmount ---
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const fail = (message: string) => setStage({ kind: "error", message });

  // --- switch wallet to Base Sepolia (adds the network if unknown) ---
  const handleSwitchChain = useCallback(async () => {
    try {
      await evm.switchChain(BASE_SEPOLIA_CHAIN_ID, {
        chainName: "Base Sepolia",
        rpcUrls: ["https://sepolia.base.org"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: ["https://sepolia.basescan.org"],
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Failed to switch network.");
    }
  }, [evm]);

  // --- 1. quote ---
  const handleQuote = useCallback(async () => {
    if (!evm.account) { fail("Connect your EVM wallet first."); return; }
    if (!destinationParty) { fail("Connect your Loop wallet to set the destination."); return; }
    let wbtcAmount: bigint;
    try { wbtcAmount = parseWbtc(amount); } catch { fail("Enter a valid amount."); return; }
    if (wbtcAmount <= 0n) { fail("Amount must be greater than zero."); return; }

    setStage({ kind: "quoting" });
    try {
      const quote = await getQuote({ user: evm.account, wbtcAmount: wbtcAmount.toString(), cantonParty: destinationParty });
      void refreshBalance(quote.wbtc);
      setStage({ kind: "quoted", quote });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Quote failed.");
    }
  }, [evm.account, destinationParty, amount, refreshBalance]);

  // --- 2. approve (if needed) + 3. sign + 4. submit ---
  const handleConfirm = useCallback(async (quote: QuoteResponse) => {
    if (!evm.account) { fail("Wallet disconnected."); return; }
    const needed = BigInt(quote.order.inputs[0][1]);

    // 2. ensure Permit2 allowance
    try {
      const allowance = decodeUint(await evm.call(quote.wbtc, encodeAllowance(evm.account, PERMIT2_ADDRESS)));
      if (allowance < needed) {
        setStage({ kind: "approving", quote });
        const txHash = await evm.sendTransaction({ to: quote.wbtc, data: encodeApprove(PERMIT2_ADDRESS) });
        // Best-effort wait: poll the allowance until it reflects (or timeout).
        for (let i = 0; i < 30; i++) {
          await sleep(2000);
          const a = decodeUint(await evm.call(quote.wbtc, encodeAllowance(evm.account, PERMIT2_ADDRESS)));
          if (a >= needed) break;
          if (i === 29) throw new Error(`approve tx ${txHash} not yet reflected`);
        }
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : "Approve failed."); return;
    }

    // 3. sign the Permit2 witness.
    // eth_signTypedData_v4 requires EIP712Domain to be declared in `types`
    // (viem's signer auto-injects it, but raw wallet RPC does not). Declare it
    // to match the domain fields the API sent (name, chainId, verifyingContract),
    // or the wallet signs a different digest → Permit2 reverts InvalidSigner.
    let signature: string;
    try {
      setStage({ kind: "signing", quote });
      const typesWithDomain = {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...quote.permit2.types,
      };
      signature = await evm.signTypedData({
        domain: quote.permit2.domain,
        types: typesWithDomain,
        primaryType: quote.permit2.primaryType,
        message: quote.permit2.message,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Signature rejected."); return;
    }

    // 4. submit to the solver (it submits openFor on Base)
    try {
      setStage({ kind: "submitting", quote });
      const { orderId } = await submitOrder({ order: quote.order, signature, cantonParty: quote.cantonParty });
      startTracking(orderId);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Submit failed.");
    }
  }, [evm]);

  // --- 5. poll status until terminal ---
  const startTracking = useCallback((orderId: string) => {
    setStage({ kind: "tracking", orderId, order: null });
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const order = await getOrder(orderId);
        setStage({ kind: "tracking", orderId, order });
        if (isTerminal(order.status) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch { /* keep polling */ }
    };
    void tick();
    pollRef.current = setInterval(tick, 4000);
  }, []);

  const reset = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setStage({ kind: "idle" });
  };

  return (
    <div className="mx-auto w-full max-w-[480px] px-4 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Swap</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Swap WBTC on Base for cBTC on Canton. One solver fronts the cBTC; your
          WBTC is locked in an audited escrow and refundable if delivery fails.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>WBTC → cBTC</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* Connection row */}
          <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3 text-sm">
            <ConnectionRow
              label="Canton (destination)"
              value={destinationParty ? truncatePartyId(destinationParty) : "Connect Loop wallet"}
              ok={loopConnected}
              action={
                !loopConnected ? (
                  <Button
                    size="sm" variant="outline"
                    onClick={wallet.connectLoop}
                    disabled={wallet.loopConnecting || !wallet.loopReady}
                  >
                    {wallet.loopConnecting ? "Connecting…" : wallet.loopReady ? "Connect Loop" : "Loading…"}
                  </Button>
                ) : undefined
              }
            />
            <p className="text-[11px] text-muted-foreground -mt-1">
              cBTC is delivered to your connected Loop wallet — accept the incoming
              transfer there once it arrives.
            </p>
            {wallet.loopError && (
              <p className="text-[11px] text-destructive -mt-1">{wallet.loopError}</p>
            )}
            <ConnectionRow
              label="EVM (source)"
              value={evm.account ? `${evm.account.slice(0, 6)}…${evm.account.slice(-4)}` : "Not connected"}
              ok={!!evm.account && !wrongChain}
              action={
                !evm.account ? (
                  <Button size="sm" variant="outline" onClick={evm.connect} disabled={evm.connecting || !evm.available}>
                    {evm.connecting ? "Connecting…" : evm.available ? "Connect" : "No wallet"}
                  </Button>
                ) : undefined
              }
            />
            {wrongChain && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-destructive">
                  Wrong network — your wallet reports chain {evm.chainId}, but this swap needs
                  Base Sepolia (chain {BASE_SEPOLIA_CHAIN_ID}).
                </p>
                <Button size="sm" variant="outline" onClick={handleSwitchChain}>
                  Switch to Base Sepolia
                </Button>
              </div>
            )}
          </div>

          {/* Amount */}
          {(stage.kind === "idle" || stage.kind === "quoting" || stage.kind === "error") && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="amount">Amount (WBTC)</Label>
              <Input
                id="amount" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0001"
              />
              {wbtcBalance != null && (
                <p className="text-xs text-muted-foreground">Balance: {formatWbtc(wbtcBalance)} WBTC</p>
              )}
              <p className="text-xs text-muted-foreground">You receive ≈ {amount || "0"} cBTC — exact amount shown in the quote</p>
            </div>
          )}

          {/* Stage-driven body */}
          {stage.kind === "error" && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {stage.message}
            </div>
          )}

          {(stage.kind === "idle" || stage.kind === "error" || stage.kind === "quoting") && (
            <Button
              onClick={handleQuote}
              disabled={stage.kind === "quoting" || !evm.account || !destinationParty || wrongChain}
            >
              {stage.kind === "quoting" ? "Getting quote…" : "Get quote"}
            </Button>
          )}

          {stage.kind === "quoted" && (
            <QuoteSummary
              quote={stage.quote}
              onConfirm={() => handleConfirm(stage.quote)}
              onCancel={reset}
            />
          )}

          {(stage.kind === "approving" || stage.kind === "signing" || stage.kind === "submitting") && (
            <BusyStep
              label={
                stage.kind === "approving" ? "Approve WBTC in your wallet…" :
                stage.kind === "signing" ? "Sign the swap in your wallet…" :
                "Locking WBTC on Base…"
              }
            />
          )}

          {stage.kind === "tracking" && (
            <TrackingView orderId={stage.orderId} order={stage.order} onReset={reset} />
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Two-legged settlement — not atomic. If the solver never delivers, your
        WBTC is refundable after the order expires.
      </p>
    </div>
  );
}

function ConnectionRow({ label, value, ok, action }: { label: string; value: string; ok: boolean; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className={ok ? "text-foreground" : "text-muted-foreground"}>{value}</span>
        <span className={`inline-block size-2 rounded-full ${ok ? "bg-green-500" : "bg-muted-foreground/40"}`} />
        {action}
      </div>
    </div>
  );
}

function QuoteSummary({ quote, onConfirm, onCancel }: { quote: QuoteResponse; onConfirm: () => void; onCancel: () => void }) {
  const wbtc = formatWbtc(BigInt(quote.order.inputs[0][1]));
  const cbtc = formatWbtc(BigInt(quote.cbtcAmount));
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-foreground/10 p-3 text-sm">
        <Row label="You send" value={`${wbtc} WBTC`} />
        <Row label="You receive" value={`${cbtc} cBTC`} />
        <Row
          label="Rate"
          value={quote.feeBps > 0 ? `1:1 − ${quote.feeBps / 100}% fee` : "1:1 (no fee)"}
        />
        <Row label="To party" value={truncatePartyId(quote.cantonParty)} />
        <Row label="Refund after" value={new Date(quote.expires * 1000).toLocaleString()} />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onCancel}>Back</Button>
        <Button className="flex-1" onClick={onConfirm}>Confirm swap</Button>
      </div>
    </div>
  );
}

function BusyStep({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-4 text-sm">
      <span className="inline-block size-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
      {label}
    </div>
  );
}

function TrackingView({ orderId, order, onReset }: { orderId: string; order: OrderView | null; onReset: () => void }) {
  const status = order?.status;
  const done = status === "finalised";
  const failedOrRefunded = status === "failed" || status === "refunded";
  const currentIdx = status ? FLOW.indexOf(status) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {FLOW.map((s, i) => {
          const reached = currentIdx >= i && !failedOrRefunded;
          const active = currentIdx === i && !done && !failedOrRefunded;
          return (
            <div key={s} className="flex items-center gap-3 text-sm">
              <span className={`inline-flex size-5 items-center justify-center rounded-full text-xs ${reached ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {reached && currentIdx > i ? "✓" : i + 1}
              </span>
              <span className={active ? "font-medium text-foreground" : reached ? "text-foreground" : "text-muted-foreground"}>
                {STATUS_LABEL[s]}
                {active && <span className="ml-1 animate-pulse">…</span>}
              </span>
            </div>
          );
        })}
      </div>

      {failedOrRefunded && (
        <div className={`rounded-lg p-3 text-sm ${status === "refunded" ? "bg-muted/50 text-foreground" : "border border-destructive/30 bg-destructive/10 text-destructive"}`}>
          {status === "refunded" ? "Your WBTC was refunded." : `Swap failed${order?.note ? `: ${order.note}` : "."}`}
        </div>
      )}

      {done && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-foreground">
          ✓ Swap complete — cBTC delivered to your Canton party.
          {order?.finaliseTxHash && (
            <div className="mt-1 break-all text-xs text-muted-foreground">finalise: {order.finaliseTxHash}</div>
          )}
        </div>
      )}

      <div className="break-all text-xs text-muted-foreground">order: {orderId}</div>

      {(done || failedOrRefunded) && (
        <Button variant="outline" onClick={onReset}>New swap</Button>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
