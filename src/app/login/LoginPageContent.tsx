"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export default function LoginPageContent() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const router = useRouter();


  const searchParams = useSearchParams();
  const isVerified = searchParams.get("verified") === "1";
  const isReset = searchParams.get("reset") === "1";
  // Where the user was going before the login wall. Only a same-origin
  // relative path is accepted — anything else falls back to /dashboard, so
  // a crafted ?redirect= can never send the user to another site.
  const redirectParam = searchParams.get("redirect") || "";
  const redirectTarget =
    redirectParam.startsWith("/") && !redirectParam.startsWith("//") && redirectParam !== "/login"
      ? redirectParam
      : "/dashboard";

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };

      if (!res.ok) {
        setError(data.error || "Login failed");
        setIsLoading(false);
        return;
      }

      router.push(redirectTarget);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-12 font-sans text-[var(--text)]">
      <div className="w-full max-w-[420px]">
        <div className="panel">
          <Link href="/" className="mb-8 flex items-center gap-3 text-[var(--text)] hover:no-underline">
            <Image
              src="/logo1.png"
              alt="AgentFlow"
              width={36}
              height={36}
              className="h-9 w-9 rounded-[4px]"
            />
            <span className="text-lg font-semibold tracking-[-0.01em]">AgentFlow</span>
          </Link>

          <h1 className="mb-1 text-2xl font-semibold tracking-[-0.015em]">Welcome back</h1>
          <p className="mb-6 text-sm text-[var(--muted)]">
            Log in to your workspace.
          </p>

          {error && (
            <div className="notice notice-danger mb-4" role="alert">
              {error}
            </div>
          )}

          {(isVerified || isReset) && (
            <div className="notice mb-4" style={{ borderLeftColor: "var(--accent)" }}>
              {isReset
                ? "Password reset successfully. Please sign in with your new password."
                : "Email verified successfully. Please sign in."}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              label="Email Address"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <Input
              label="Password"
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              showPasswordToggle
              helperText="For best security, use a strong password."
            />

            <div className="flex justify-end -mt-3">
              <Link href="/forgot-password" className="text-xs font-semibold">
                Forgot Password?
              </Link>
            </div>
            <Button type="submit" className="w-full justify-center" isLoading={isLoading}>
              Sign In
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-[var(--muted)]">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-semibold text-[var(--text)]">
              Sign up
            </Link>
          </p>
        </div>

        <blockquote className="mt-8 border-t border-[var(--border)] pt-4 text-sm leading-relaxed text-[var(--muted)]">
          <p>“AgentFlow transformed our workflow structures.”</p>
          <footer className="mt-2 text-xs">
            <span className="font-semibold text-[var(--text)]">Marcus Vance</span> — Lead AI
            Integration at Vercel
          </footer>
        </blockquote>
      </div>
    </div>
  );
}
