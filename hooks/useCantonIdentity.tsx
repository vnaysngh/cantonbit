"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

import { useWallet } from "@/hooks/useWallet";

export interface CantonIdentity {
  party: string | null;
  ready: boolean;
  isLoop: boolean;
  isManaged: boolean;
  /** Supabase session present (email / linked account). */
  authed: boolean;
}

const DEFAULT: CantonIdentity = {
  party: null,
  ready: false,
  isLoop: false,
  isManaged: false,
  authed: false
};

const CantonIdentityContext = createContext<CantonIdentity>(DEFAULT);

/**
 * Single /api/parties/me fetch for the whole app. Loop party is used as fallback
 * when there is no managed session mapping.
 */
export function CantonIdentityProvider({ children }: { children: ReactNode }) {
  const { partyId: loopParty } = useWallet();
  const [session, setSession] = useState<CantonIdentity>(DEFAULT);

  useEffect(() => {
    let alive = true;
    fetch("/api/parties/me")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.partyId) {
          setSession({
            party: d.partyId,
            ready: true,
            isLoop: d.mode === "loop",
            isManaged: d.mode === "participant-managed",
            authed: !!d.authed
          });
        } else {
          setSession({
            party: null,
            ready: true,
            isLoop: false,
            isManaged: false,
            authed: !!d?.authed
          });
        }
      })
      .catch(() => {
        if (alive) {
          setSession({
            party: null,
            ready: true,
            isLoop: false,
            isManaged: false,
            authed: false
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo((): CantonIdentity => {
    // A live Loop wallet connection is an explicit user choice and must win over
    // any stale Supabase/participant-managed session from the same browser. If
    // the session party wins here, /swap thinks the user is managed/email and
    // suppresses the Loop one-time signature gate until a reload or remap.
    if (loopParty) {
      return {
        party: loopParty,
        ready: true,
        isLoop: true,
        isManaged: false,
        authed: session.authed
      };
    }
    return session;
  }, [session, loopParty]);

  return (
    <CantonIdentityContext.Provider value={value}>
      {children}
    </CantonIdentityContext.Provider>
  );
}

export function useCantonIdentity(): CantonIdentity {
  return useContext(CantonIdentityContext);
}
