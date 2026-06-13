"use client";

import { useEffect, useState } from "react";

import { useWallet } from "@/hooks/useWallet";

export interface CantonIdentity {
  party: string | null;
  ready: boolean;
  isLoop: boolean;
  isManaged: boolean;
}

/**
 * The user's Canton identity. Reads from /api/parties/me (cookie-reliable on first
 * load). Falls back to the Loop party when no managed mapping exists.
 */
export function useCantonIdentity(): CantonIdentity {
  const { partyId: loopParty } = useWallet();
  const [state, setState] = useState<CantonIdentity>({
    party: null,
    ready: false,
    isLoop: false,
    isManaged: false
  });

  useEffect(() => {
    let alive = true;
    fetch("/api/parties/me")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.partyId) {
          setState({
            party: d.partyId,
            ready: true,
            isLoop: d.mode === "loop",
            isManaged: d.mode === "participant-managed"
          });
        } else {
          setState({ party: null, ready: true, isLoop: false, isManaged: false });
        }
      })
      .catch(() => {
        if (alive) {
          setState({ party: null, ready: true, isLoop: false, isManaged: false });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!state.party && loopParty) {
    return { party: loopParty, ready: true, isLoop: true, isManaged: false };
  }
  return state;
}
