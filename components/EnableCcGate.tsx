"use client";

import { cn } from "@/lib/utils";

export function EnableCcGate({
  ccTotal,
  ccMin,
  ccEnabled,
  cbtcEnabled,
  ccReadyForEnable,
  ccSubsidizedOnDevnet,
  swapIssues,
  enabling,
  enablingCbtc,
  error,
  onEnable,
  onEnableCbtc,
  onClose,
  compact
}: {
  ccTotal: string;
  ccMin: number;
  ccEnabled: boolean;
  cbtcEnabled?: boolean;
  ccReadyForEnable: boolean;
  ccSubsidizedOnDevnet: boolean;
  swapIssues?: string[];
  enabling: boolean;
  enablingCbtc?: boolean;
  error?: string | null;
  onEnable: () => void;
  onEnableCbtc?: () => void;
  onClose?: () => void;
  compact?: boolean;
}) {
  const needsDeposit = !ccReadyForEnable && !ccSubsidizedOnDevnet;

  const body = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-amber-500/10">
          <span className="material-symbols-outlined text-[24px] text-amber-500">
            account_balance_wallet
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-on-surface-variant transition-all hover:bg-muted hover:text-foreground"
          >
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        )}
      </div>
      <h2 className="text-lg font-semibold text-foreground">
        Set up Canton swap auto-accept
      </h2>
      <p className="mt-2 text-sm text-on-surface-variant">
        Same-chain atomic swaps need one-time auto-accept on your account for
        incoming CC and CBTC. Enabling this opts your party into automatically
        accepting all incoming CC and CBTC transfers (not just this swap).
        CBTC preapproval on the solver party is not enough — your party must
        opt in separately.
      </p>
      <div className="mt-4 rounded-xl bg-muted/50 px-4 py-3 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Your CC balance</span>
          <span className="font-medium tabular-nums">{ccTotal} CC</span>
        </div>
        <div className="mt-1 flex justify-between gap-3">
          <span className="text-muted-foreground">CC preapproval</span>
          <span className={cn("font-medium", ccEnabled ? "text-emerald-600" : "text-amber-700")}>
            {ccEnabled ? "Enabled" : "Not enabled"}
          </span>
        </div>
        {onEnableCbtc && (
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-muted-foreground">CBTC preapproval</span>
            <span
              className={cn(
                "font-medium",
                cbtcEnabled ? "text-emerald-600" : "text-amber-700"
              )}
            >
              {cbtcEnabled ? "Enabled" : "Not enabled"}
            </span>
          </div>
        )}
      </div>
      {needsDeposit && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
          Deposit at least {ccMin} CC on your Canton party first (receive CC from
          another party or faucet), then tap Enable CC.
        </div>
      )}
      {ccSubsidizedOnDevnet && !ccEnabled && (
        <div className="mt-4 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-xs text-muted-foreground">
          Devnet: synchronizer fees may be subsidized even with low CC balance.
          You can still try Enable CC.
        </div>
      )}
      {swapIssues && swapIssues.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-900">
          {swapIssues.map((issue) => (
            <li key={issue}>• {issue}</li>
          ))}
        </ul>
      )}
      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <button
        onClick={onEnable}
        disabled={enabling || needsDeposit || ccEnabled}
        className="mt-5 w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 disabled:opacity-50 active:scale-[0.99]"
      >
        {ccEnabled
          ? "CC enabled"
          : enabling
            ? "Enabling CC…"
            : needsDeposit
              ? `Need ${ccMin} CC first`
              : "Enable CC"}
      </button>
      {onEnableCbtc && (
        <button
          onClick={onEnableCbtc}
          disabled={enablingCbtc || cbtcEnabled}
          className="mt-3 w-full rounded-2xl border border-foreground/15 bg-card py-4 text-base font-semibold text-foreground transition-all hover:bg-muted/50 disabled:opacity-50 active:scale-[0.99]"
        >
          {cbtcEnabled
            ? "CBTC enabled"
            : enablingCbtc
              ? "Enabling CBTC…"
              : "Enable CBTC"}
        </button>
      )}
    </>
  );

  if (compact) {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4">
        {body}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-[440px] rounded-3xl border border-foreground/10 bg-card p-6 shadow-xl">
        {body}
      </div>
    </div>
  );
}
