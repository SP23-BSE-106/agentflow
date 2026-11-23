"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { PublicLayout } from "@/components/layout/PublicLayout";

export default function PrivacyPage() {
  return (
    <PublicLayout>
      <div className="mx-auto max-w-3xl px-4 py-12 font-sans text-[var(--text)] sm:px-6">
        <h1 className="mb-2 flex items-center gap-3 text-3xl font-semibold tracking-[-0.015em] sm:text-4xl">
          <ShieldCheck className="h-8 w-8 shrink-0 text-[var(--accent)]" aria-hidden />
          Privacy Policy
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
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">1. Information We Collect</h2>
            <p>
              We may collect information you provide when you use AgentFlow features or send us a message.
              Signing up for an account is coming later, so we do not collect account details yet.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">2. How We Use Information</h2>
            <p>
              We use collected information to operate the service, improve performance, and provide
              customer support.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">3. Data Sharing</h2>
            <p>
              We do not sell your personal information. We may share information with trusted partners
              to deliver the service and support infrastructure.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">4. Security</h2>
            <p>
              We implement reasonable security measures to protect your information. However, no
              method of transmission or storage is 100% secure.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">5. Billing</h2>
            <p>
              Mock payments are used for Pro activation. The app does not
              collect card details or process real billing. Billing terms —
              $19 per month in the demo, 90-day free trial — are stated on
              the Terms page.
            </p>
          </div>

          <div className="border-t border-[var(--border)] pt-6">
            <h2 className="mb-2 text-base font-semibold text-[var(--text)]">6. Contact</h2>
            <p>
              If you have questions about this Privacy Policy, please contact us via the{" "}
              <Link href="/contact" className="font-semibold text-[var(--accent)] hover:underline">
                contact page
              </Link>
              .
            </p>
          </div>
        </section>

        <p className="mt-10 border-t border-[var(--border)] pt-6 text-sm">
          <Link href="/terms" className="inline-flex items-center gap-1 font-semibold text-[var(--accent)] hover:underline">
            Read the Terms of Service
            <ArrowRight className="icon-sm" aria-hidden />
          </Link>
        </p>
      </div>
    </PublicLayout>
  );
}
