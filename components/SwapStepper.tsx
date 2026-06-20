"use client";

import { cn } from "@/lib/utils";

export type SwapStepStatus = "pending" | "active" | "done" | "error";

export type SwapStep = {
  id: string;
  label: string;
  status: SwapStepStatus;
};

const STATUS_STYLE: Record<SwapStepStatus, string> = {
  pending: "text-muted-foreground",
  active: "text-foreground font-medium",
  done: "text-foreground/70",
  error: "text-destructive"
};

const DOT_STYLE: Record<SwapStepStatus, string> = {
  pending: "border-foreground/20 bg-transparent",
  active: "border-primary bg-primary/15 ring-2 ring-primary/30",
  done: "border-green-600/40 bg-green-500/15",
  error: "border-destructive/40 bg-destructive/10"
};

export function SwapStepper({ steps }: { steps: SwapStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="mb-4 space-y-2 rounded-xl border border-foreground/10 bg-foreground/[0.03] px-4 py-3 text-left text-sm">
      {steps.map((step, i) => (
        <li key={step.id} className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
              DOT_STYLE[step.status]
            )}
            aria-hidden
          >
            {step.status === "done" ? "✓" : i + 1}
          </span>
          <span className={cn("leading-snug", STATUS_STYLE[step.status])}>
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
