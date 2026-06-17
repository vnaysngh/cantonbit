"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { useLoopWallet } from "@/hooks/useLoopWallet";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { WarpXWordmark } from "@/components/WarpXWordmark";

function cleanError(
  err: unknown,
  fallback = "Something went wrong. Please try again."
): string {
  if (!err) return fallback;
  const maybe = err as {
    shortMessage?: unknown;
    message?: unknown;
    reason?: unknown;
    data?: { message?: unknown };
    error?: { message?: unknown };
  };
  const direct =
    maybe.shortMessage ??
    maybe.message ??
    maybe.reason ??
    maybe.data?.message ??
    maybe.error?.message;
  if (typeof direct === "string" && direct.trim() && direct !== "[object Object]") {
    return direct.trim();
  }
  if (err instanceof Error && err.cause) return cleanError(err.cause, fallback);
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    // fall through
  }
  const text = String(err);
  return text && text !== "[object Object]" ? text : fallback;
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="material-symbols-outlined animate-spin text-[20px]"
    >
      progress_activity
    </span>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5 shrink-0">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

const secondaryBtnClass =
  "inline-flex h-14 w-full items-center justify-center gap-sm rounded-xl border border-outline-variant bg-surface-container-lowest px-md text-body-lg font-semibold text-on-surface transition-all hover:border-primary/35 hover:bg-primary/5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

const googleBtnClass =
  "inline-flex h-14 w-full items-center justify-center gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-md text-body-lg font-semibold text-on-surface transition-all hover:border-primary/25 hover:bg-surface-container-low active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

function LoginPageContent() {
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [loopLoginError, setLoopLoginError] = useState<string | null>(null);

  const loop = useLoopWallet();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("error") === "auth_failed") {
      setGoogleError("Google sign-in failed or was cancelled. Please try again.");
    }
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/parties/me")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.partyId) router.replace("/swap");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!loop.connected || !loop.party || !loop.provider) return;
    router.replace("/swap");
  }, [loop.connected, loop.party, loop.provider, router]);

  useEffect(() => {
    if (loop.error && !loop.connected) {
      setLoopLoginError(cleanError(loop.error, "Loop wallet connection failed."));
    }
  }, [loop.error, loop.connected]);

  const signInWithGoogle = async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    setGoogleError(null);

    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/swap")}`;
    const { error } = await createSupabaseBrowserClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo }
    });

    if (error) {
      setGoogleError(cleanError(error, "Could not start Google sign-in."));
      setGoogleBusy(false);
    }
  };

  const startLoopLogin = () => {
    if (!loop.ready || loop.restoring || loop.connecting) return;
    setLoopLoginError(null);
    if (loop.connected && loop.provider) {
      router.replace("/swap");
      return;
    }
    void loop.connect();
  };

  const loopDisabled = !loop.ready || loop.restoring || loop.connecting;
  const loopButtonLabel = loop.restoring
    ? "Checking Loop session..."
    : loop.connecting
      ? "Connecting..."
      : loop.connected
        ? "Opening swap..."
        : "Continue with Loop Wallet";
  const loopBusy = loop.restoring || loop.connecting;

  return (
    <main className="min-h-screen bg-surface px-4 py-4 text-on-surface sm:px-6 sm:py-6">
      <div className="flex min-h-[calc(100vh-32px)] items-center justify-center overflow-hidden rounded-[28px] border border-outline-variant/60 bg-surface-container-lowest shadow-[0_24px_80px_rgba(155,68,40,0.08)]">
        <section className="flex w-full items-center justify-center px-5 py-10 sm:px-8 lg:px-16">
          <div className="w-full max-w-[500px]">
            <div className="mb-10 flex justify-center">
              <WarpXWordmark href="/swap" size="lg" />
            </div>

            <div className="mb-8">
              <h1 className="font-display text-[1.75rem] font-bold tracking-[-0.02em] text-on-surface sm:text-[1.875rem]">
                Sign in
              </h1>
              <p className="mt-2.5 text-body-lg text-on-surface-variant">
                Continue with Google or your Loop Wallet.
              </p>
            </div>

            <div className="space-y-6">
              <button
                type="button"
                className={googleBtnClass}
                onClick={() => void signInWithGoogle()}
                disabled={googleBusy}
              >
                {googleBusy ? <Spinner /> : <GoogleIcon />}
                {googleBusy ? "Redirecting to Google…" : "Continue with Google"}
              </button>

              {googleError && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-[15px] font-semibold leading-6 text-red-700">
                  {googleError}
                </p>
              )}

              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-5 py-1">
                <div className="h-px bg-outline-variant/50" />
                <span className="text-label-md font-medium text-on-surface-variant">or</span>
                <div className="h-px bg-outline-variant/50" />
              </div>

              <button
                type="button"
                onClick={startLoopLogin}
                disabled={loopDisabled}
                className={secondaryBtnClass}
              >
                {loopBusy ? (
                  <Spinner />
                ) : (
                  <Image
                    src="/loop.svg"
                    alt=""
                    width={24}
                    height={24}
                    className="size-6 shrink-0"
                    aria-hidden
                  />
                )}
                {loopButtonLabel}
              </button>

              {loopLoginError && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-[15px] font-semibold leading-6 text-red-700">
                  {loopLoginError}
                </p>
              )}
            </div>

            <div className="mt-9 flex items-center justify-between gap-4 text-label-md font-medium text-on-surface-variant">
              <span>
                {loop.restoring
                  ? "Checking Loop session"
                  : loop.connected
                    ? "Loop wallet connected"
                    : "No wallet connected"}
              </span>
              <Link
                href="/how-it-works"
                className="underline underline-offset-2 hover:text-primary"
              >
                How it works
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-surface">
          <Spinner />
        </main>
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}
