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

export function AddressQR({ value, label, size = 200, className }: Props) {
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
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="rounded-md bg-white p-3">
        <QRCodeSVG value={value} size={size} level="M" />
      </div>
      {label && (
        <div className="text-center text-xs text-muted-foreground">{label}</div>
      )}
      <div className="w-full max-w-md">
        <div className="break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
          {value}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
