"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export default function SignupPage() {
  const [fullName, setFullName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [isSubmitted, setIsSubmitted] = React.useState(false);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName, email, password }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };

      if (!res.ok) {
        setError(data.error || "Sign up failed");
        setIsLoading(false);
        return;
      }

      setIsSubmitted(true);
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

          <h1 className="mb-1 text-2xl font-semibold tracking-[-0.015em]">Create your account</h1>
          <p className="mb-6 text-sm text-[var(--muted)]">
            Set up your workspace in under a minute.
          </p>

          {error && (
            <div className="notice notice-danger mb-4" role="alert">
              {error}
            </div>
          )}

          {!isSubmitted ? (
            <form onSubmit={handleSignup} className="space-y-4">
              <Input
                label="Full Name"
                type="text"
                placeholder="Your full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />

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
                placeholder="Create a password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                showPasswordToggle
                helperText="Use at least 8 characters, one uppercase letter, one number, and one special character."
              />

              <Button type="submit" className="w-full justify-center" isLoading={isLoading}>
                Create Account
              </Button>
            </form>
          ) : (
            <div className="space-y-3 border-t border-[var(--border)] pt-4">
              <p className="status-line">
                <span className="lamp lamp-ok" aria-hidden />
                Check your email
              </p>
              <p className="text-xs leading-relaxed text-[var(--muted)]">
                We sent a confirmation link to{" "}
                <strong className="font-mono font-semibold text-[var(--text)]">{email}</strong>.
                Open it to confirm your account, then log in to get started.
              </p>
            </div>
          )}

          <p className="mt-6 text-center text-xs text-[var(--muted)]">
            Already have an account?{" "}
            <Link href="/login" className="font-semibold text-[var(--text)]">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
