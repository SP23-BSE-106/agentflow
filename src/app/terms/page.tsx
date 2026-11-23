"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ScrollText } from "lucide-react";
import { PublicLayout } from "@/components/layout/PublicLayout";

export default function TermsPage() {
  return (
    <PublicLayout>
      <div className="mx-auto max-w-3xl px-4 py-12 font-sans text-[var(--text)] sm:px-6">
        <h1 className="mb-2 flex items-center gap-3 text-3xl font-semibold tracking-[-0.015em] sm:text-4xl">
          <ScrollText className="h-8 w-8 shrink-0 text-[var(--accent)]" aria-hidden />
          Terms of Service
        </h1>
        <p className="mb-8 text-sm text-[var(--muted)]">
          Last updated: <span className="font-mono text-[var(--text)]">2026-01-01</span>
        </p>
        <p className="mb-8 text-sm leading-relaxed text-[var(--muted)]">
          Note: signing up for an account is coming later in this version, so there is no account to create yet.
          Everything you can use now works without one.
        </p>

        <section className="space-y-6 text-sm leading-relaxed text-[var(--muted)]">
          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">1. Acceptance</h2>
            <p>
              By accessing and using AgentFlow, you agree to these Terms of Service. If you do not
              agree, do not use the service.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">2. Use of the Service</h2>
            <p>
              You are responsible for how you use the service. Do not misuse it or try to break it.
              (Account rules will apply once accounts arrive — see the note above.)
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">3. Content &amp; Conduct</h2>
            <p>
              You must ensure that any content you upload or generate using AgentFlow complies with
              applicable laws.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">4. Limitation of Liability</h2>
            <p>
              AgentFlow is provided “as is”. To the maximum extent permitted by law, AgentFlow
              will not be liable for any indirect, incidental, or consequential damages.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">5. Billing</h2>
            <p>
              The Pro plan is listed at $19 per month for demonstration, but
              the current app uses mock payments only. No real charge or card
              payment is processed. New verified accounts get a 90-day free
              trial. Mock Pro access runs for 30 days.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">6. Changes</h2>
            <p>
              We may update these Terms from time to time. Continued use after changes means you
              accept the updated Terms.
            </p>
          </div>
        </section>

        <p className="mt-10 border-t border-[var(--border)] pt-6 text-sm">
          <Link href="/privacy" className="inline-flex items-center gap-1 font-semibold text-[var(--accent)] hover:underline">
            Read the Privacy Policy
            <ArrowRight className="icon-sm" aria-hidden />
          </Link>
        </p>
      </div>
    </PublicLayout>
  );
}
