"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useLoopWallet } from "@/hooks/useLoopWallet";
import { swapSessionActive } from "@/lib/swap-accept";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type EmailStage =
  | { kind: "email" }
  | { kind: "otp"; email: string; canResendAt: number };

type EmailBusy = "sending" | "verifying" | null;

const RESEND_COOLDOWN_SEC = 120;

const inputClass =
  "h-[76px] w-full rounded-xl border border-[#dfc7be] bg-white px-5 pb-3 pt-8 text-[22px] font-bold leading-none text-[#191919] outline-none transition-all placeholder:text-transparent autofill:shadow-[inset_0_0_0_1000px_white] focus:border-[#a84e32] focus:ring-4 focus:ring-[#a84e32]/10";

const primaryBtnClass =
  "inline-flex h-14 w-full items-center justify-center gap-sm rounded-xl bg-[#b65335] px-md text-[18px] font-bold text-white transition-all hover:bg-[#9f462d] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

const secondaryBtnClass =
  "inline-flex h-14 w-full items-center justify-center gap-sm rounded-xl border border-[#dfc7be] bg-white px-md text-[18px] font-bold text-[#1d1d1f] transition-all hover:border-[#b65335]/45 hover:bg-[#fff8f5] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

const otpInputClass =
  "h-[76px] w-full rounded-xl border border-[#dfc7be] bg-white px-5 pb-3 pt-8 text-[26px] font-bold leading-none tracking-[0.32em] text-[#191919] outline-none transition-all placeholder:text-transparent focus:border-[#a84e32] focus:ring-4 focus:ring-[#a84e32]/10";

function deferState(fn: () => void) {
  void Promise.resolve().then(fn);
}

function cleanError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!err) return fallback;
  const maybe = err as {
    shortMessage?: unknown;
    message?: unknown;
    reason?: unknown;
    data?: { message?: unknown };
    error?: { message?: unknown };
  };
  const direct = maybe.shortMessage ?? maybe.message ?? maybe.reason ?? maybe.data?.message ?? maybe.error?.message;
  if (typeof direct === "string" && direct.trim() && direct !== "[object Object]") return direct.trim();
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

function emailAuthErrorMessage(err: unknown): string {
  const maybe = err as { code?: unknown; status?: unknown };
  const raw = cleanError(err, "Could not send the sign-in code.");
  const normalized = raw.toLowerCase();
  if (
    maybe.code === "unexpected_failure" ||
    normalized.includes("magic link email") ||
    normalized.includes("sending")
  ) {
    return "We could not send the email code. The email service failed to deliver it, so try again in a minute or use Loop Wallet.";
  }
  if (normalized.includes("rate limit")) {
    return "Too many email code requests. Wait a minute, then try again.";
  }
  return raw;
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

export default function LoginPage() {
  const [emailStage, setEmailStage] = useState<EmailStage>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [resendCountdown, setResendCountdown] = useState(0);
  const [emailBusy, setEmailBusy] = useState<EmailBusy>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [loopLoginError, setLoopLoginError] = useState<string | null>(null);
  const [loopLoginPending, setLoopLoginPending] = useState(false);
  const [loopLoginInFlight, setLoopLoginInFlight] = useState(false);
  const [loopSessionChecking, setLoopSessionChecking] = useState(false);
  const [loopSessionProbe, setLoopSessionProbe] = useState<{ party: string; active: boolean } | null>(null);

  const loop = useLoopWallet();
  const router = useRouter();

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

  // If the Loop SDK silently restored a wallet session, first check whether our
  // server-side Loop API-key cookie is still active. This is a no-signature
  // probe; if it succeeds, the user should not see the Exchange API Key prompt.
  useEffect(() => {
    if (!loop.connected || !loop.party || !loop.provider) {
      deferState(() => {
        setLoopSessionProbe(null);
        setLoopSessionChecking(false);
      });
      return;
    }
    let cancelled = false;
    deferState(() => {
      setLoopSessionChecking(true);
      setLoopSessionProbe(null);
    });
    void swapSessionActive(loop.party)
      .then((active) => {
        if (cancelled) return;
        setLoopSessionProbe({ party: loop.party, active });
        if (active) router.replace("/swap");
      })
      .finally(() => {
        if (!cancelled) setLoopSessionChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loop.connected, loop.party, loop.provider, router]);

  // Loop login: the Loop wallet IS the user's identity (it carries their email +
  // Canton party). On connect, register the party (loop-wallet mode) -> go to swap.
  // Use client-side nav so the in-memory Loop provider survives.
  useEffect(() => {
    if (!loopLoginPending || loopLoginInFlight || !loop.connected || !loop.party || !loop.provider) return;
    if (loopSessionChecking) return;
    if (loopSessionProbe?.party !== loop.party) return;
    if (loopSessionProbe.active) {
      deferState(() => setLoopLoginPending(false));
      router.replace("/swap");
      return;
    }
    deferState(() => setLoopLoginInFlight(true));
    void (async () => {
      setLoopLoginError(null);
      const { signExchange } = await import("@/lib/swap-accept");
      const exchange = await signExchange(loop.provider!);
      if (!exchange) throw new Error("Loop wallet signature rejected");
      const res = await fetch("/api/parties/register-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyId: loop.party, ...exchange }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Loop wallet registration failed");
      }
      setLoopLoginPending(false);
      router.replace("/swap");
    })()
      .catch((err) => {
        setLoopLoginError(cleanError(err, "Loop wallet sign-in failed."));
        setLoopLoginPending(false);
      })
      .finally(() => {
        setLoopLoginInFlight(false);
      });
  }, [
    loop.connected,
    loop.party,
    loop.provider,
    loopLoginInFlight,
    loopLoginPending,
    loopSessionChecking,
    loopSessionProbe,
    router,
  ]);

  useEffect(() => {
    if (loopLoginPending && loop.error && (!loop.connected || !loop.provider)) {
      deferState(() => {
        setLoopLoginError(cleanError(loop.error, "Loop wallet connection failed."));
        setLoopLoginPending(false);
        setLoopLoginInFlight(false);
      });
    }
  }, [loop.connected, loop.error, loop.provider, loopLoginPending]);

  useEffect(() => {
    if (emailStage.kind !== "otp") return;
    const t = setInterval(() => {
      const r = Math.max(0, Math.ceil((emailStage.canResendAt - Date.now()) / 1000));
      setResendCountdown(r);
      if (r === 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [emailStage]);

  const sendOtp = async (emailOverride?: string) => {
    const target = (emailOverride ?? email).trim().toLowerCase();
    if (!target || emailBusy) return;
    setEmailBusy("sending");
    setEmailError(null);

    const { error } = await createSupabaseBrowserClient().auth.signInWithOtp({
      email: target,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setEmailError(emailAuthErrorMessage(error));
      setEmailBusy(null);
      return;
    }

    setEmail(target);
    setOtp("");
    setEmailStage({
      kind: "otp",
      email: target,
      canResendAt: Date.now() + RESEND_COOLDOWN_SEC * 1000,
    });
    setResendCountdown(RESEND_COOLDOWN_SEC);
    setEmailBusy(null);
  };

  const verifyOtp = async () => {
    if (emailStage.kind !== "otp" || otp.length < 6 || emailBusy) return;
    setEmailBusy("verifying");
    setEmailError(null);

    const { error } = await createSupabaseBrowserClient().auth.verifyOtp({
      email: emailStage.email,
      token: otp.trim(),
      type: "email",
    });

    if (error) {
      setEmailError(cleanError(error, "Could not verify the code."));
      setEmailBusy(null);
      return;
    }

    for (let i = 0; i < 20; i++) {
      const { data } = await createSupabaseBrowserClient().auth.getSession();
      if (data.session) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await fetch("/api/parties/provision", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = "/swap";
  };

  const startLoopLogin = () => {
    if (!loop.ready || loop.restoring || loop.connecting || loopSessionChecking || loopLoginInFlight) return;
    const shouldRefreshLoop = !!loopLoginError || !loop.connected || !loop.provider;
    setLoopLoginError(null);
    setLoopLoginPending(true);
    if (shouldRefreshLoop) {
      void loop.connect();
    }
  };

  const emailDisabled = emailBusy !== null;
  const loopDisabled = !loop.ready || loop.restoring || loop.connecting || loopSessionChecking || loopLoginInFlight;
  const loopButtonLabel =
    loop.restoring || loopSessionChecking
      ? "Checking Loop session..."
      : loop.connecting
        ? "Connecting..."
        : loopLoginInFlight
          ? "Signing..."
          : loop.connected
            ? "Sign with Loop Wallet"
            : "Continue with Loop Wallet";
  const loopBusy = loop.restoring || loopSessionChecking || loop.connecting || loopLoginInFlight;

  return (
    <main className="min-h-screen bg-[#f7f5f2] px-4 py-4 text-[#191919] sm:px-6 sm:py-6">
      <div className="flex min-h-[calc(100vh-32px)] items-center justify-center overflow-hidden rounded-[28px] border border-[#ead9d2] bg-[#fffdfb] shadow-[0_24px_80px_rgba(79,48,37,0.10)]">
        <section className="flex w-full items-center justify-center px-5 py-10 sm:px-8 lg:px-16">
          <div className="w-full max-w-[500px]">
            <div className="mb-12 flex items-center justify-center">
              <Link
                href="/swap"
                aria-label="OranjSwap home"
                className="text-[38px] font-semibold leading-none transition-opacity hover:opacity-80"
              >
                <span className="text-primary">Oranj</span>
                <span className="text-foreground">Swap</span>
              </Link>
            </div>

            <div className="mb-9">
              <h1 className="text-[38px] font-extrabold leading-none tracking-normal text-[#161616]">
                Sign in
              </h1>
              <p className="mt-3 text-[18px] font-semibold leading-7 text-[#756b66]">
                Continue with an email code or your Loop Wallet.
              </p>
            </div>

            <div className="space-y-6">
              {emailStage.kind === "email" ? (
                <>
                  <div className="relative">
                    <label
                      htmlFor="email"
                      className="pointer-events-none absolute left-4 top-2.5 text-[13px] font-bold text-[#8d7a72]"
                    >
                      Email
                    </label>
                    <input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setEmailError(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && sendOtp()}
                      autoComplete="email"
                      className={inputClass}
                    />
                  </div>

                  <button
                    type="button"
                    className={primaryBtnClass}
                    onClick={() => sendOtp()}
                    disabled={emailDisabled || !email.trim()}
                  >
                    {emailBusy === "sending" && <Spinner />}
                    {emailBusy === "sending" ? "Sending code..." : "Send code"}
                  </button>
                </>
              ) : (
                <>
                  <p className="rounded-xl border border-[#dfc7be] bg-[#fff8f5] px-4 py-4 text-[15px] font-semibold leading-6 text-[#756b66]">
                    We sent a 6-digit code to{" "}
                    <span className="font-bold text-[#191919]">{emailStage.email}</span>.
                  </p>
                  <div className="relative">
                    <label
                      htmlFor="otp"
                      className="pointer-events-none absolute left-4 top-2.5 text-[13px] font-bold text-[#8d7a72]"
                    >
                      One-time code
                    </label>
                    <input
                      id="otp"
                      type="text"
                      inputMode="numeric"
                      placeholder="00000000"
                      maxLength={6}
                      value={otp}
                      onChange={(e) => {
                        setOtp(e.target.value.replace(/\D/g, ""));
                        setEmailError(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && verifyOtp()}
                      autoComplete="one-time-code"
                      className={otpInputClass}
                    />
                  </div>

                  <button
                    type="button"
                    className={primaryBtnClass}
                    onClick={verifyOtp}
                    disabled={emailDisabled || otp.length < 6}
                  >
                    {emailBusy === "verifying" && <Spinner />}
                    {emailBusy === "verifying" ? "Verifying..." : "Verify and sign in"}
                  </button>

                  <div className="flex items-center justify-between gap-5">
                    <button
                      type="button"
                      className="text-[15px] font-bold text-[#8a4d3a] underline underline-offset-2 transition-colors hover:text-[#5f2e1f] disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={emailDisabled}
                      onClick={() => {
                        setOtp("");
                        setEmail(emailStage.email);
                        setEmailStage({ kind: "email" });
                        setEmailError(null);
                      }}
                    >
                      Wrong email?
                    </button>
                    <button
                      type="button"
                      disabled={emailDisabled || resendCountdown > 0}
                      className="text-[15px] font-bold text-[#8a4d3a] underline underline-offset-2 transition-colors hover:text-[#5f2e1f] disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => sendOtp(emailStage.email)}
                    >
                      {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : "Resend code"}
                    </button>
                  </div>
                </>
              )}

              {emailError && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-[15px] font-semibold leading-6 text-red-700">
                  {emailError}
                </p>
              )}

              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-5 py-1">
                <div className="h-px bg-[#e3d3cc]" />
                <span className="text-[16px] font-semibold text-[#8d7a72]">or</span>
                <div className="h-px bg-[#e3d3cc]" />
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
                  <span
                    aria-hidden
                    className="flex size-6 items-center justify-center rounded-full bg-[#f2eee9]"
                  >
                    <span className="block size-3 rotate-45 rounded-[3px] bg-[#dfff70]" />
                  </span>
                )}
                {loopButtonLabel}
              </button>

              {loopLoginError && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-[15px] font-semibold leading-6 text-red-700">
                  {loopLoginError}
                </p>
              )}
            </div>

            <div className="mt-9 flex items-center justify-between gap-4 text-[14px] font-semibold text-[#8d7a72]">
              <span>
                {loop.restoring || loopSessionChecking
                  ? "Checking Loop session"
                  : loop.connected
                    ? "Loop wallet connected"
                    : "No wallet connected"}
              </span>
              <Link href="/how-it-works" className="underline underline-offset-2 hover:text-[#5f2e1f]">
                How it works
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
