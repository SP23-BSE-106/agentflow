'use client';

import * as React from 'react';
import { CreditCard } from 'lucide-react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { BillingSection } from '@/components/billing/BillingSection';

export default function PaymentPage() {
  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="space-y-1">
          <h2 className="font-h1 font-bold text-[var(--text)] flex items-center gap-2">
            <CreditCard className="icon-lg text-[var(--accent)]" />
            Payment
          </h2>
          <p className="text-xs text-[var(--muted)]">Your free trial, your plan, and how to keep going after the trial ends. Start by picking a plan below.</p>
        </div>
        <BillingSection />
      </div>
    </DashboardLayout>
  );
}
