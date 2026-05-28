"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Stage =
  | { kind: "email" }
  | { kind: "otp"; email: string }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export default function LoginPage() {
  const [stage, setStage] = useState<Stage>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");

  const supabase = createSupabaseBrowserClient();

  const sendOtp = async () => {
    if (!email.trim()) return;
    setStage({ kind: "loading" });

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        shouldCreateUser: true,
      },
    });

    if (error) {
      setStage({ kind: "error", message: error.message });
      return;
    }

    setStage({ kind: "otp", email: email.trim().toLowerCase() });
  };

  const verifyOtp = async () => {
    if (stage.kind !== "otp") return;
    setStage({ kind: "loading" });

    const { error } = await supabase.auth.verifyOtp({
      email: stage.email,
      token: otp.trim(),
      type: "email",
    });

    if (error) {
      setStage({ kind: "otp", email: stage.email });
      setTimeout(() => {
        setStage({ kind: "error", message: error.message });
      }, 0);
      return;
    }

    window.location.href = "/";
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">
            Oranj
          </h1>
          <p className="text-sm text-muted-foreground">
            Mint, hold, and transfer cBTC on Canton Network.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {stage.kind === "otp" ? "Check your email" : "Sign in"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">

            {(stage.kind === "email" || stage.kind === "error") && (
              <>
                {stage.kind === "error" && (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {stage.message}
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor="email">Email address</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendOtp()}
                    autoFocus
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={sendOtp}
                  disabled={!email.trim()}
                >
                  Send code
                </Button>
              </>
            )}

            {stage.kind === "otp" && (
              <>
                <p className="text-sm text-muted-foreground">
                  We sent a code to{" "}
                  <span className="font-medium text-foreground">
                    {stage.email}
                  </span>
                  . Enter it below.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="otp">One-time code</Label>
                  <Input
                    id="otp"
                    type="text"
                    inputMode="numeric"
                    placeholder="123456"
                    maxLength={8}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => e.key === "Enter" && verifyOtp()}
                    className="font-mono text-lg tracking-widest"
                    autoFocus
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={verifyOtp}
                  disabled={otp.length < 6}
                >
                  Verify
                </Button>
                <Button
                  variant="ghost"
                  className="w-full text-xs"
                  onClick={() => setStage({ kind: "email" })}
                >
                  Use a different email
                </Button>
              </>
            )}

            {stage.kind === "loading" && (
              <div className="py-4 text-center text-sm text-muted-foreground">
                Please wait…
              </div>
            )}

          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          No password needed. We&apos;ll email you a one-time code.
        </p>
      </div>
    </div>
  );
}
