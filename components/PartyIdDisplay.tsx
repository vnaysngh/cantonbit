"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { truncatePartyId } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  partyId: string;
  className?: string;
  showCopy?: boolean;
}

export function PartyIdDisplay({ partyId, className, showCopy = true }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(partyId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore silently
    }
  };

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="font-mono text-xs" title={partyId}>
        {truncatePartyId(partyId)}
      </span>
      {showCopy && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      )}
    </span>
  );
}
