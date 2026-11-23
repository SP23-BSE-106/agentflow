"use client"

import * as React from "react"
import { CreditCard, Check, Loader2 } from "lucide-react"

export function BillingSection() {
  // Session return & status check
  const [verifyingSession, setVerifyingSession] = React.useState(false)
  const [sessionSuccessMsg, setSessionSuccessMsg] = React.useState("")
  const [sessionErrorMsg, setSessionErrorMsg] = React.useState("")
  const [checkoutError, setCheckoutError] = React.useState("")
  const [profile, setProfile] = React.useState<{ email?: string; subscriptionStatus?: string } | null>(null)

  const fetchProfile = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/profile")
      if (res.ok) {
        const data = await res.json()
        setProfile(data.user || null)
      }
    } catch (err) {
      console.error("Error fetching profile:", err)
    }
  }, [])

  const verifySession = React.useCallback(async (sessionId: string) => {
    setVerifyingSession(true)
    setSessionErrorMsg("")
    try {
      const res = await fetch("/api/payments/verify-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) {
        setSessionSuccessMsg(data.message)
        fetchProfile()
      } else {
        setSessionErrorMsg(data.error || `Payment verification failed (HTTP ${res.status}). Your payment may still have gone through — try again, or contact support.`)
      }
    } catch (err) {
      setSessionErrorMsg(err instanceof Error ? err.message : "Could not reach the payment verification service.")
    } finally {
      setVerifyingSession(false)
    }
  }, [fetchProfile])

  React.useEffect(() => {
    void (async () => {
      await fetchProfile()

      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search)
        const sessionId = params.get("session_id")
        const success = params.get("success")

        if (sessionId && success === "true") {
          await verifySession(sessionId)
        }
      }
    })()
  }, [fetchProfile, verifySession])

  const [isRedirectingPayment, setIsRedirectingPayment] = React.useState(false)

  const handleMockCheckout = async () => {
    setIsRedirectingPayment(true)
    setCheckoutError("")
    try {
      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "subscription" }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setCheckoutError(data.error || "Could not open the payment page")
      }
    } catch (err: unknown) {
      setCheckoutError("Could not reach the payment page: " + (err instanceof Error ? err.message : "Unknown error"))
    } finally {
      setIsRedirectingPayment(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">Your plan and payment</h3>
        <p className="text-xs text-[var(--muted)]">Your free trial, your plan, and how to pay.</p>
      </div>

      {sessionErrorMsg && (
        <div className="notice notice-danger" role="alert">
          <p className="font-semibold">Payment verification failed</p>
          <p>{sessionErrorMsg}</p>
          <button
            type="button"
            className="btn btn-secondary mt-2"
            onClick={() => {
              const params = new URLSearchParams(window.location.search)
              const sessionId = params.get("session_id")
              if (sessionId) void verifySession(sessionId)
            }}
            disabled={verifyingSession}
          >
            {verifyingSession ? "Verifying…" : "Try verifying again"}
          </button>
        </div>
      )}

      {checkoutError && (
        <div className="notice notice-danger" role="alert">
          {checkoutError}
        </div>
      )}

      {sessionSuccessMsg && (
        <div className="notice">
          <span className="flex items-center gap-3">
            <Check className="icon-sm text-[var(--accent)] shrink-0" />
            <span>
              <span className="block font-semibold">Payment verified</span>
              <span className="block text-[var(--muted)] mt-0.5">{sessionSuccessMsg}</span>
            </span>
          </span>
        </div>
      )}

      {profile?.subscriptionStatus === "active" && (
        <div className="panel">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <Check className="icon-sm text-[var(--accent)] shrink-0 mt-0.5" />
              <div>
                <h5 className="font-semibold text-[var(--text)] text-sm">Pro plan is active</h5>
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  You have full access for 30 days. Your plan is linked to <strong className="text-[var(--text)] font-mono text-[11px] break-all">{profile.email}</strong>.
                </p>
              </div>
            </div>
            <span className="status-line shrink-0">
              <span className="lamp lamp-ok" />
              Active
            </span>
          </div>
        </div>
      )}

      {/* Pricing Tiers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Free Trial Tier */}
        <div className="panel relative">
          <div className="flex justify-between items-start gap-3 mb-4 flex-wrap">
            <div>
              <span className="text-[11px] uppercase font-semibold text-[var(--accent)] tracking-wider">Current Plan</span>
              <h4 className="text-lg font-semibold text-[var(--text)] mt-1">90-Day Free Trial</h4>
            </div>
            <div className="text-right">
              <span className="text-2xl font-semibold text-[var(--text)] font-mono">$0</span>
              <span className="text-xs text-[var(--muted)]"> / 90 Days</span>
            </div>
          </div>
          <p className="text-xs text-[var(--muted)] mb-4">Make as many agents as you like, use the step-by-step builder, and start from ready-made templates — free for 90 days.</p>
          <ul className="space-y-2 text-xs text-[var(--muted)] mb-6">
            <li className="flex items-center gap-2"><Check className="icon-sm text-[var(--accent)]" /> Create unlimited AI agents</li>
            <li className="flex items-center gap-2"><Check className="icon-sm text-[var(--accent)]" /> Step-by-step builder</li>
            <li className="flex items-center gap-2"><Check className="icon-sm text-[var(--accent)]" /> Agents that read your files</li>
          </ul>
        </div>

        {/* Pro Tier */}
        <div className="panel relative border-[var(--accent)]">
          <span className="absolute -top-3 right-6 bg-[var(--surface)] border border-[var(--accent)] text-[var(--accent)] font-semibold text-[11px] uppercase tracking-wider px-2.5 py-0.5 rounded-[2px]">
            Recommended
          </span>
          <div className="flex justify-between items-start gap-3 mb-4 flex-wrap">
            <div>
              <span className="text-[11px] uppercase font-semibold text-[var(--muted)] tracking-wider">Unlimited Access</span>
              <h4 className="text-lg font-semibold text-[var(--text)] mt-1">AgentFlow Pro</h4>
            </div>
            <div className="text-right">
              {/* This is a demo price; mock mode never charges the user. */}
              <span className="text-2xl font-semibold text-[var(--text)] font-mono">$19</span>
              <span className="text-xs text-[var(--muted)]"> / month</span>
            </div>
          </div>
          <p className="text-xs text-[var(--muted)] mb-4">Keep full access after 90 days, with faster running and access for other apps.</p>
          <ul className="space-y-2 text-xs text-[var(--muted)] mb-6">
            <li className="flex items-center gap-2"><Check className="icon-sm text-[var(--accent)]" /> Everything in the free trial</li>
            <li className="flex items-center gap-2"><Check className="icon-sm text-[var(--accent)]" /> Faster running</li>
            <li className="flex items-center gap-2"><Check className="icon-sm text-[var(--accent)]" /> New features every month</li>
          </ul>
        </div>
      </div>

      {/* Payment Selection Box */}
      <div className="panel">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)] mb-4">How to pay</h4>

        {/* Mock payment section */}
        <div className="space-y-4 text-xs">
          <p className="text-[var(--muted)]">
            Simulate a successful Pro payment. No card or real payment provider is used.
          </p>
          <div className="notice notice-warn">
            <span className="font-semibold">Mock mode:</span> activating Pro here does not process or store payment details.
          </div>

          <button type="button" onClick={handleMockCheckout} disabled={isRedirectingPayment} className="btn btn-primary">
            {isRedirectingPayment && <Loader2 className="icon-sm mr-2 animate-spin" />}
            <CreditCard className="icon-sm mr-2" />
            Activate mock Pro for 30 days
          </button>
        </div>
      </div>
    </div>
  )
}
