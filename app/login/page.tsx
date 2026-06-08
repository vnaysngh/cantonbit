"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Stage =
  | { kind: "email" }
  | { kind: "otp"; email: string; canResendAt: number }
  | { kind: "loading" }
  | { kind: "error"; message: string; prevEmail: string };

const RESEND_COOLDOWN_SEC = 120;

const inputClass =
  "w-full h-12 rounded-lg border border-outline-variant bg-surface-container-low px-md font-body-md text-body-md text-on-surface transition-all placeholder:text-on-secondary-container/50 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary md:bg-surface-container-low";

const otpInputClass =
  "w-full h-12 rounded-lg border border-outline-variant bg-surface-container-low px-md text-center font-body-md text-body-md tracking-[0.4em] text-on-surface transition-all placeholder:text-on-secondary-container/50 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary";

const primaryBtnClass =
  "flex h-14 w-full items-center justify-center gap-sm rounded-lg bg-primary font-headline-md text-headline-md text-on-primary transition-all duration-200 hover:bg-primary-container hover:text-on-primary-container active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60";

export default function LoginPage() {
  const [stage, setStage] = useState<Stage>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [resendCountdown, setResendCountdown] = useState(0);
  const [emailFocused, setEmailFocused] = useState(false);

  const supabase = createSupabaseBrowserClient();

  useEffect(() => {
    if (stage.kind !== "otp") return;
    const remaining = Math.max(
      0,
      Math.ceil((stage.canResendAt - Date.now()) / 1000)
    );
    setResendCountdown(remaining);
    if (remaining === 0) return;
    const t = setInterval(() => {
      const r = Math.max(0, Math.ceil((stage.canResendAt - Date.now()) / 1000));
      setResendCountdown(r);
      if (r === 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [stage]);

  const sendOtp = async (emailOverride?: string) => {
    const target = (emailOverride ?? email).trim().toLowerCase();
    if (!target) return;
    setStage({ kind: "loading" });

    const { error } = await supabase.auth.signInWithOtp({
      email: target,
      options: { shouldCreateUser: true }
    });

    if (error) {
      setStage({ kind: "error", message: error.message, prevEmail: target });
      return;
    }

    setOtp("");
    setStage({
      kind: "otp",
      email: target,
      canResendAt: Date.now() + RESEND_COOLDOWN_SEC * 1000
    });
  };

  const verifyOtp = async () => {
    if (stage.kind !== "otp") return;
    setStage({ kind: "loading" });

    const { error } = await supabase.auth.verifyOtp({
      email: stage.email,
      token: otp.trim(),
      type: "email"
    });

    if (error) {
      setStage({
        kind: "error",
        message: error.message,
        prevEmail: stage.email
      });
      return;
    }

    window.location.href = "/";
  };

  const isEmail = stage.kind === "email";
  const isOtp = stage.kind === "otp";
  const isLoading = stage.kind === "loading";
  const isError = stage.kind === "error";

  const emailValue = isError ? stage.prevEmail : email;

  return (
    <div className="flex w-full max-w-bridge-widget-width flex-col items-center">
      {/* Brand */}
      <div className="mb-lg text-center">
        <div className="mb-sm flex items-center justify-center">
          <Image
            src="/logo.png"
            alt="OranjSwap"
            width={174}
            height={42}
            className="block dark:hidden"
            priority
          />
          <Image
            src="/logo-white.png"
            alt="OranjSwap"
            width={174}
            height={42}
            className="hidden dark:block"
            priority
          />
        </div>
        <p className="mx-auto max-w-[320px] font-body-md text-body-md text-on-secondary-container">
          Mint, hold, and transfer CBTC on Canton Network.
        </p>
      </div>

      {/* Auth card */}
      <div className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest p-md shadow-sm transition-all hover:border-primary/20 md:rounded-xl md:p-lg">
        <div className="mb-lg">
          <h2 className="font-headline-md text-headline-md text-on-surface">
            {isOtp ? "Check your email" : "Sign in"}
          </h2>
        </div>

        <div className="space-y-md">
          {(isEmail || isError) && (
            <>
              {isError && (
                <p className="rounded-lg bg-error-container px-md py-sm font-label-sm text-label-sm text-on-error-container">
                  {stage.message}
                </p>
              )}
              <div className="space-y-xs">
                <label
                  htmlFor="email"
                  className={cn(
                    "block font-label-sm text-label-sm uppercase text-on-surface-variant transition-colors md:text-on-secondary-container md:tracking-wider",
                    emailFocused && "text-primary"
                  )}
                >
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={emailValue}
                  onChange={(e) => {
                    if (isError) {
                      setEmail(e.target.value);
                      setStage({ kind: "email" });
                    } else {
                      setEmail(e.target.value);
                    }
                  }}
                  onFocus={() => setEmailFocused(true)}
                  onBlur={() => setEmailFocused(false)}
                  onKeyDown={(e) => e.key === "Enter" && sendOtp()}
                  autoFocus
                  autoComplete="email"
                  className={inputClass}
                />
              </div>
              <button
                type="button"
                className={primaryBtnClass}
                onClick={() => sendOtp()}
                disabled={!emailValue.trim()}
              >
                Send code
              </button>
            </>
          )}

          {isOtp && (
            <>
              <p className="font-body-md text-body-md text-on-secondary-container">
                We sent an 8-digit code to{" "}
                <span className="font-semibold text-on-surface">
                  {stage.email}
                </span>
                .
              </p>
              <div className="space-y-xs">
                <label
                  htmlFor="otp"
                  className="block font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant"
                >
                  One-time code
                </label>
                <input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  placeholder="00000000"
                  maxLength={8}
                  value={otp}
                  onChange={(e) =>
                    setOtp(e.target.value.replace(/\D/g, ""))
                  }
                  onKeyDown={(e) =>
                    e.key === "Enter" && otp.length === 8 && verifyOtp()
                  }
                  autoFocus
                  autoComplete="one-time-code"
                  className={otpInputClass}
                />
              </div>
              <button
                type="button"
                className={primaryBtnClass}
                onClick={verifyOtp}
                disabled={otp.length < 8}
              >
                Verify & sign in
              </button>
              <div className="flex items-center justify-between pt-xs">
                <button
                  type="button"
                  className="font-label-sm text-label-sm text-on-secondary-container transition-colors hover:text-primary"
                  onClick={() => {
                    setOtp("");
                    setEmail(stage.email);
                    setStage({ kind: "email" });
                  }}
                >
                  Wrong email?
                </button>
                <button
                  type="button"
                  disabled={resendCountdown > 0}
                  className="font-label-sm text-label-sm text-on-secondary-container transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => sendOtp(stage.email)}
                >
                  {resendCountdown > 0
                    ? `Resend in ${resendCountdown}s`
                    : "Resend code"}
                </button>
              </div>
            </>
          )}

          {isLoading && (
            <div className="flex flex-col items-center gap-sm py-lg">
              <span className="material-symbols-outlined animate-spin text-[28px] text-primary">
                progress_activity
              </span>
              <p className="font-body-md text-body-md text-on-secondary-container">
                Please wait…
              </p>
            </div>
          )}
        </div>
      </div>

      <p className="mt-md text-center font-label-sm text-label-sm text-on-secondary-container md:font-body-md md:text-body-md">
        No password needed — we&apos;ll email you a one-time code.
      </p>
    </div>
  );
}
