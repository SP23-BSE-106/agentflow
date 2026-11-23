"use client"

import * as React from "react"
import Link from "next/link"
import { Clock, Zap, ArrowRight } from "lucide-react"

interface UserSubscriptionProfile {
  createdAt?: string
  trialEndsAt?: string
  subscriptionStatus?: string
  subscriptionPlan?: string
  subscriptionEndsAt?: string
}

export function TrialBanner() {
  const [profile, setProfile] = React.useState<UserSubscriptionProfile | null>(null)

  // The clock lives in state (refreshed once a minute) so the render
  // below never calls Date.now() — a render must be pure. All hooks sit
  // above the early returns; hooks after a return break the rules of hooks.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  React.useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await fetch("/api/auth/profile")
        if (res.ok) {
          const data = await res.json()
          setProfile(data.user || null)
        }
      } catch (err) {
        console.error("Failed to fetch user profile for trial banner", err)
      }
    }
    fetchProfile()
  }, [])

  if (!profile) return null

  // Active Pro, or a canceled subscription still paid up through its
  // period end (C1/H19): no trial banner while the paid term is live.
  const isPro =
    profile.subscriptionStatus === "active" ||
    (profile.subscriptionStatus === "canceled" &&
      profile.subscriptionPlan === "pro" &&
      !!profile.subscriptionEndsAt &&
      new Date(profile.subscriptionEndsAt).getTime() > now)
  const isPending = profile.subscriptionStatus === "pending_approval"

  if (isPro) return null

  // Calculate days remaining in 90-day trial. The fallback (no dates at
  // all) uses the state clock, not Date.now(), so the render stays pure.
  const trialEnds = profile.trialEndsAt
    ? new Date(profile.trialEndsAt).getTime()
    : profile.createdAt
    ? new Date(profile.createdAt).getTime() + 90 * 24 * 60 * 60 * 1000
    : now + 90 * 24 * 60 * 60 * 1000

  const diffTime = trialEnds - now
  const daysLeft = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)))
  const isExpired = daysLeft <= 0

  return (
    <div className="w-full bg-[var(--surface)] border-b border-[var(--border)] px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3 flex-wrap text-xs text-[var(--text)]">
      <div className="flex items-center gap-3 min-w-0">
        <span className="status-line shrink-0">
          <span className={`lamp ${isExpired ? "lamp-danger" : isPending ? "lamp-paused" : "lamp-ok"}`} />
          {isPending ? "Pending" : isExpired ? "Expired" : "Trial"}
        </span>

        {isPending ? (
          <div className="min-w-0">
            <span className="font-semibold">Payment being checked: </span>
            <span className="text-[var(--muted)]">Your payment proof is under review. Full access is unlocked.</span>
          </div>
        ) : isExpired ? (
          <div className="min-w-0">
            <span className="font-semibold text-[var(--danger)]">Free trial ended: </span>
            <span className="text-[var(--muted)]">Please upgrade your plan to keep using your agents.</span>
          </div>
        ) : (
          <div className="min-w-0">
            <span className="font-semibold">Free trial: </span>
            <span className="text-[var(--muted)]">
              You have <strong className="text-[var(--text)] font-mono">{daysLeft} days remaining</strong> of full free access.
            </span>
          </div>
        )}
      </div>

      <Link
        href="/dashboard/payment"
        className="btn btn-primary shrink-0"
      >
        {isPending ? <Clock className="icon-xs mr-1.5" /> : <Zap className="icon-xs mr-1.5" />}
        <span>{isPending ? "View status" : "Upgrade plan"}</span>
        <ArrowRight className="icon-xs ml-1.5" />
      </Link>
    </div>
  )
}
