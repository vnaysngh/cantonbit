"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  label?: string;
  size?: number;
  className?: string;
}

export function AddressQR({ value, label, size = 240, className }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className={cn("flex flex-col items-center gap-8", className)}>
      {/* QR */}
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <QRCodeSVG value={value} size={size} level="M" />
      </div>
      {/* Address + copy — kept directly under the QR they belong to.
          On larger screens the address stays on one line (smaller mono +
          horizontal scroll if ever needed); on small screens it wraps. */}
      <div className="w-full max-w-xl space-y-3">
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-center font-mono text-xs break-all sm:break-normal sm:overflow-x-auto sm:whitespace-nowrap sm:text-[11px]">
          {value}
        </div>
        <Button
          variant="outline"
          className="w-full"
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* Timing/help text last */}
      {label && (
        <div className="max-w-md text-center text-xs leading-relaxed text-muted-foreground">
          {label}
        </div>
      )}
    </div>
  );
}
