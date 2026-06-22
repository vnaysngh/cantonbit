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
  phase: "lock" | "solver" | "claim" | "done";
  chainName: string;
  /** Email / participant-managed: backend locks CBTC — no Loop signature. */
  managed?: boolean;
}): SwapStep[] {
  const lockDone = opts.phase !== "lock";
  const solverDone = opts.phase === "claim" || opts.phase === "done";
  const claimDone = opts.phase === "done";
  const lockLabel = opts.managed
    ? "Lock CBTC on Canton"
    : "Sign CBTC transfer in Loop";
  return [
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
}

/** Loop forward HTLC (WBTC → CBTC) progress steps. */
export function forwardLoopHtlcSteps(opts: {
  phase: "lock" | "solver" | "claim" | "done";
  /** Legacy argument kept for call-site compatibility; Loop HTLC fees are no longer separately charged. */
  networkFeeEnabled: boolean;
}): SwapStep[] {
  const lockDone = opts.phase !== "lock";
  const solverDone = opts.phase === "claim" || opts.phase === "done";
  const claimDone = opts.phase === "done";
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
  steps.push(
    step(
      "accept",
      "Claim CBTC in Loop",
      opts.phase === "claim" ? "active" : claimDone ? "done" : "pending"
    )
  );
  return steps;
}

/** Loop C2C swap progress steps. */
export function loopC2cSteps(opts: {
  phase: "sign" | "fill" | "accept" | "done";
}): SwapStep[] {
  const signDone = opts.phase !== "sign";
  const fillDone = opts.phase === "accept" || opts.phase === "done";
  const acceptDone = opts.phase === "done";
  return [
    step("review", "Review swap", "done"),
    step(
      "sign",
      "Sign transfer offer in Loop",
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
      "Accept incoming tokens in Loop (if prompted)",
      opts.phase === "accept" ? "active" : acceptDone ? "done" : "pending"
    )
  ];
}
