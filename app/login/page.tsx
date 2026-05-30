"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Stage =
  | { kind: "email" }
  | { kind: "otp"; email: string; canResendAt: number }
  | { kind: "loading" }
  | { kind: "error"; message: string; prevEmail: string };

const RESEND_COOLDOWN_SEC = 120;

export default function LoginPage() {
  const [stage, setStage] = useState<Stage>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [resendCountdown, setResendCountdown] = useState(0);

  const supabase = createSupabaseBrowserClient();

  // Count down the resend timer
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

  return (
    <div className="w-full max-w-sm space-y-8">
      {/* Logo + tagline */}
      <div className="flex flex-col items-center gap-3">
        <Image
          src="/logo.png"
          alt="Oranj"
          width={174}
          height={42}
          className="block dark:hidden"
          priority
        />
        <Image
          src="/logo-white.png"
          alt="Oranj"
          width={174}
          height={42}
          className="hidden dark:block"
          priority
        />
        <p className="text-sm text-muted-foreground">
          Mint, hold, and transfer CBTC on Canton Network.
        </p>
      </div>

      {/* Auth card */}
      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">
            {isOtp ? "Check your email" : "Sign in"}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* ── Email entry ── */}
          {(isEmail || isError) && (
            <>
              {isError && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {stage.message}
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={isError ? stage.prevEmail : email}
                  onChange={(e) => {
                    if (isError) {
                      setEmail(e.target.value);
                      setStage({ kind: "email" });
                    } else {
                      setEmail(e.target.value);
                    }
                  }}
                  onKeyDown={(e) => e.key === "Enter" && sendOtp()}
                  autoFocus
                  autoComplete="email"
                />
              </div>
              <Button
                className="w-full"
                onClick={() => sendOtp()}
                disabled={!(isError ? stage.prevEmail : email).trim()}
              >
                Send code
              </Button>
            </>
          )}

          {/* ── OTP entry ── */}
          {isOtp && (
            <>
              <p className="text-sm text-muted-foreground">
                We sent an 8-digit code to{" "}
                <span className="font-medium text-foreground">
                  {stage.email}
                </span>
                .
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="otp">One-time code</Label>
                <Input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  placeholder="00000000"
                  maxLength={8}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) =>
                    e.key === "Enter" && otp.length === 8 && verifyOtp()
                  }
                  className="font-mono text-xl tracking-[0.4em] text-center"
                  autoFocus
                  autoComplete="one-time-code"
                />
              </div>
              <Button
                className="w-full"
                onClick={verifyOtp}
                disabled={otp.length < 8}
              >
                Verify & sign in
              </Button>
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
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
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => sendOtp(stage.email)}
                >
                  {resendCountdown > 0
                    ? `Resend in ${resendCountdown}s`
                    : "Resend code"}
                </button>
              </div>
            </>
          )}

          {/* ── Loading ── */}
          {isLoading && (
            <div className="flex flex-col items-center gap-3 py-6">
              <svg
                className="h-6 w-6 animate-spin text-muted-foreground"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
              <p className="text-sm text-muted-foreground">Please wait…</p>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        No password needed — we&apos;ll email you a one-time code.
      </p>
    </div>
  );
}
