"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [isSubmitted, setIsSubmitted] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };

      if (!res.ok) {
        setError(data.error || "Unable to process password reset request.");
        setIsLoading(false);
        return;
      }

      setIsSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred while requesting a reset.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-12 font-sans text-[var(--text)]">
      <div className="panel w-full max-w-[420px]">
        <Link
          href="/login"
          className="mb-6 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--muted)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back to login
        </Link>

        <h1 className="mb-1 text-2xl font-semibold tracking-[-0.015em]">Reset password</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Enter your email address and we will send a secure reset link to help you regain access.
        </p>

        {error && (
          <div className="notice notice-danger mb-4" role="alert">
            {error}
          </div>
        )}

        {!isSubmitted ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email Address"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" className="w-full justify-center" isLoading={isLoading}>
              Send Reset Link
            </Button>
          </form>
        ) : (
          <div className="space-y-3 border-t border-[var(--border)] pt-4">
            <p className="status-line">
              <span className="lamp lamp-ok" aria-hidden />
              Secure recovery
            </p>
            <p className="text-xs leading-relaxed text-[var(--muted)]">
              If <strong className="font-mono font-semibold text-[var(--text)]">{email}</strong> belongs to a registered account, a password reset link has been sent to that email address.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
