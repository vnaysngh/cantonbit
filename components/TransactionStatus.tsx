"use client";

import { cn } from "@/lib/utils";

export type TxStatus = "idle" | "submitting" | "pending" | "success" | "error";

interface Props {
  status: TxStatus;
  message?: string;
  className?: string;
}

const STATUS_LABEL: Record<TxStatus, string> = {
  idle: "",
  submitting: "Submitting…",
  pending: "Pending confirmation…",
  success: "Complete",
  error: "Failed",
};

const STATUS_CLASS: Record<TxStatus, string> = {
  idle: "hidden",
  submitting: "bg-muted text-foreground",
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  success:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  error: "bg-destructive/15 text-destructive",
};

export function TransactionStatus({ status, message, className }: Props) {
  if (status === "idle") return null;
  return (
    <div
      role="status"
      className={cn(
        "rounded-md px-3 py-2 text-sm",
        STATUS_CLASS[status],
        className,
      )}
    >
      <div className="font-medium">{STATUS_LABEL[status]}</div>
      {message && <div className="mt-1 text-xs opacity-90">{message}</div>}
    </div>
  );
}
