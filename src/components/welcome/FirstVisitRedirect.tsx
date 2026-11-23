"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * First-visit redirect: on a user's first visit, send them to the
 * welcome guide (/welcome) so they can bring their own AI key and
 * learn how the site works.
 *
 * Scope (deliberate, contract requirement 4):
 * - Reads ONLY the flag `agentflow.welcome-seen.v1` from
 *   localStorage. The welcome page itself (Skip / Continue) sets
 *   that flag; this component never writes it.
 * - Redirects ONLY from `/` and `/dashboard`, and ONLY when the
 *   flag is absent. It never redirects from /welcome (no loop)
 *   and never from any other path, so deep links such as
 *   /form/[id] or /workflow-builder are never hijacked.
 * - Runs in useEffect, after hydration, guarded by
 *   `typeof window` — never during SSR, never before first paint.
 *   It renders nothing, adds no blocking script and no layout
 *   shift, so the app works exactly as today with no key and no
 *   flag. Client-side only: no server change, no proxy.ts change,
 *   no route change.
 */
export const WELCOME_SEEN_FLAG = "agentflow.welcome-seen.v1";

const REDIRECT_FROM = new Set(["/", "/dashboard"]);

export default function FirstVisitRedirect() {
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!pathname || !REDIRECT_FROM.has(pathname)) return;
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(WELCOME_SEEN_FLAG);
    } catch {
      // localStorage unavailable (private mode, blocked storage):
      // fail closed — never block the app, never redirect.
      return;
    }
    if (seen === null) {
      router.replace("/welcome");
    }
  }, [pathname, router]);

  return null;
}
