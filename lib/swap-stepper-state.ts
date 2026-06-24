import type { SwapStep } from "@/components/SwapStepper";

function step(
  id: string,
  label: string,
  status: SwapStep["status"]
): SwapStep {
  return { id, label, status };
}

/** Reverse HTLC (CBTC → WBTC) progress steps. */
export function reverseLoopHtlcSteps(opts: {
  phase: "lock" | "solver" | "claim" | "finalize" | "done";
  chainName: string;
  /** Email / participant-managed: backend locks CBTC — no Loop signature. */
  managed?: boolean;
}): SwapStep[] {
  const lockDone = opts.phase !== "lock";
  const solverDone =
    opts.phase === "claim" || opts.phase === "finalize" || opts.phase === "done";
  const claimDone = opts.phase === "finalize" || opts.phase === "done";
  const lockLabel = opts.managed
    ? "Lock CBTC on Canton"
    : "Sign CBTC transfer in Loop";
  const steps: SwapStep[] = [
    step("review", "Review quote", "done"),
    step(
      "lock",
      lockLabel,
      opts.phase === "lock" ? "active" : lockDone ? "done" : "pending"
    ),
    step(
      "solver",
      `Solver locks WBTC on ${opts.chainName}`,
      opts.phase === "solver"
        ? "active"
        : solverDone
          ? "done"
          : lockDone
            ? "pending"
            : "pending"
    ),
    step(
      "claim",
      "Claim WBTC in your wallet",
      opts.phase === "claim" ? "active" : claimDone ? "done" : "pending"
    )
  ];
  if (!opts.managed) {
    steps.push(
      step(
        "solver-canton",
        "Solver settles CBTC on Canton",
        opts.phase === "finalize"
          ? "active"
          : opts.phase === "done"
            ? "done"
            : "pending"
      )
    );
  }
  return steps;
}

/** Loop forward HTLC (WBTC → CBTC) progress steps. */
export function forwardLoopHtlcSteps(opts: {
  phase: "lock" | "solver" | "claim" | "finalize" | "done";
  /** Legacy argument kept for call-site compatibility; Loop HTLC fees are no longer separately charged. */
  networkFeeEnabled: boolean;
  /** Email / participant-managed: backend claim path, no Loop accept screen. */
  managed?: boolean;
  /** EVM chain name for the solver WBTC claim step (Loop forward only). */
  chainName?: string;
}): SwapStep[] {
  const lockDone = opts.phase !== "lock";
  const solverDone =
    opts.phase === "claim" || opts.phase === "finalize" || opts.phase === "done";
  const claimDone = opts.phase === "finalize" || opts.phase === "done";
  const steps: SwapStep[] = [
    step("review", "Review quote", "done"),
    step(
      "evm-lock",
      "Lock WBTC on chain",
      opts.phase === "lock" ? "active" : lockDone ? "done" : "pending"
    ),
    step(
      "solver",
      "Solver delivers CBTC",
      opts.phase === "solver"
        ? "active"
        : solverDone
          ? "done"
          : lockDone
            ? "pending"
            : "pending"
    )
  ];
  void opts.networkFeeEnabled;
  const claimLabel = opts.managed ? "Claim CBTC" : "Claim CBTC in Loop";
  steps.push(
    step(
      "accept",
      claimLabel,
      opts.phase === "claim" ? "active" : claimDone ? "done" : "pending"
    )
  );
  if (!opts.managed) {
    const chain = opts.chainName ?? "EVM";
    steps.push(
      step(
        "solver-evm",
        `Solver settles WBTC on ${chain}`,
        opts.phase === "finalize"
          ? "active"
          : opts.phase === "done"
            ? "done"
            : "pending"
      )
    );
  }
  return steps;
}

/** C2C swap progress steps. */
export function loopC2cSteps(opts: {
  phase: "sign" | "fill" | "accept" | "done";
  /** Email / participant-managed: backend submits the user leg; no Loop signature. */
  managed?: boolean;
  /** Counter asset arrived via preapproval — no Loop accept step. */
  directCounterDelivery?: boolean;
}): SwapStep[] {
  const signDone = opts.phase !== "sign";
  const fillDone = opts.phase === "accept" || opts.phase === "done";
  const acceptDone = opts.phase === "done";
  const signLabel = opts.managed ? "Submit swap" : "Sign transfer offer in Loop";
  const acceptLabel = opts.managed
    ? "Receive tokens"
    : opts.directCounterDelivery && acceptDone
      ? "Counter asset credited (auto-accept)"
      : "Accept incoming tokens in Loop (if prompted)";
  return [
    step("review", "Review swap", "done"),
    step(
      "sign",
      signLabel,
      opts.phase === "sign" ? "active" : signDone ? "done" : "pending"
    ),
    step(
      "fill",
      "Solver settles both legs",
      opts.phase === "fill"
        ? "active"
        : fillDone
          ? "done"
          : signDone
            ? "pending"
            : "pending"
    ),
    step(
      "accept",
      acceptLabel,
      opts.phase === "accept" ? "active" : acceptDone ? "done" : "pending"
    )
  ];
}
