"use client"

import * as React from "react"
import Link from "next/link"
import { Lock, ArrowRight, ShieldAlert } from "lucide-react"

export function ExpirationLockModal() {
  const [isExpired, setIsExpired] = React.useState(false)

  React.useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch("/api/auth/profile")
        if (res.ok) {
          const data = await res.json()
          const profile = data.user
          if (!profile) return

          if (profile.subscriptionStatus === "active" || profile.subscriptionStatus === "pending_approval") {
            setIsExpired(false)
            return
          }

          // A canceled subscription that is still paid up through its
          // period end keeps access until that date (C1/H19).
          if (
            profile.subscriptionPlan === "pro" &&
            profile.subscriptionEndsAt &&
            new Date(profile.subscriptionEndsAt).getTime() > Date.now()
          ) {
            setIsExpired(false)
            return
          }

          // An expired / canceled / past-due paid term is over even when
          // the trial window has not run out (or never applied).
          if (
            profile.subscriptionStatus === "expired" ||
            profile.subscriptionStatus === "canceled" ||
            profile.subscriptionStatus === "past_due"
          ) {
            setIsExpired(true)
            return
          }

          const trialEnds = profile.trialEndsAt
            ? new Date(profile.trialEndsAt).getTime()
            : profile.createdAt
            ? new Date(profile.createdAt).getTime() + 90 * 24 * 60 * 60 * 1000
            : Date.now() + 90 * 24 * 60 * 60 * 1000

          if (Date.now() > trialEnds) {
            setIsExpired(true)
          }
        }
      } catch (err) {
        console.error("Failed to check subscription status:", err)
      }
    }
    checkStatus()
  }, [])

  if (!isExpired) return null

  return (
    <div className="fixed inset-0 z-[100] bg-black/55 flex items-center justify-center p-4">
      <div className="modal-panel max-w-md w-full p-6 space-y-5 text-center" role="dialog" aria-modal="true" aria-label="Your free trial has ended">
        <div className="h-14 w-14 rounded-[4px] border border-[var(--danger)] flex items-center justify-center text-[var(--danger)] mx-auto">
          <Lock className="w-7 h-7" />
        </div>

        <div className="space-y-2">
          <p className="status-line justify-center">
            <span className="lamp lamp-danger" />
            Trial ended
          </p>
          <h3 className="text-xl font-semibold text-[var(--text)]">Your free trial has ended</h3>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Your 90-day free trial of AgentFlow has ended. To keep using your agents, please upgrade to a paid plan.
          </p>
        </div>

        <div className="notice text-left">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="icon-sm" />
            <span>Upgrade available:</span>
          </div>
          <p className="text-[var(--muted)] text-[11px] mt-1">
            Activate <strong>mock Pro access</strong> ($19 a month in the demo)
          </p>
        </div>

        <Link href="/dashboard/payment" className="btn btn-primary block w-full">
          <span>Upgrade now</span>
          <ArrowRight className="icon-sm ml-2" />
        </Link>
      </div>
    </div>
  )
}
