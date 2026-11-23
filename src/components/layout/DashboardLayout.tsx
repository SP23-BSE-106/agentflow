"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, Menu, Search, HelpCircle } from "lucide-react";

import { Sidebar } from "@/components/ui/Sidebar";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { TrialBanner } from "@/components/billing/TrialBanner";
import { ExpirationLockModal } from "@/components/billing/ExpirationLockModal";

interface UserProfile {
  fullName?: string;
  email?: string;
}

const GithubIcon = (props: React.SVGProps<SVGSVGElement>) => (

  <svg
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth="2"
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props.className}
    {...props}
  >
    <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
  </svg>
);

/** Pages the header search can reach. Client-side only, so it is instant and works offline. */
const SEARCHABLE_PAGES = [
  { title: "Dashboard", href: "/dashboard", keywords: "home overview workspace" },
  { title: "My Agents", href: "/dashboard/agents", keywords: "agents list saved" },
  { title: "Create Agent", href: "/dashboard/agents/create", keywords: "new build generate" },
  { title: "Workflow Builder", href: "/workflow-builder", keywords: "canvas nodes graph editor" },
  { title: "Testing Sandbox", href: "/testing-sandbox", keywords: "test run trace execute" },
  { title: "Your Files", href: "/dashboard/rag", keywords: "files documents upload search knowledge" },
  { title: "Deployments", href: "/dashboard/deployment", keywords: "api keys endpoint deploy" },
  { title: "Execution Monitor", href: "/dashboard/analytics", keywords: "analytics monitoring runs latency metrics" },
  { title: "Ready-made agents", href: "/dashboard/templates", keywords: "templates marketplace presets" },
  { title: "Billing", href: "/dashboard/payment", keywords: "payment mock subscription price plan" },
  { title: "Profile", href: "/dashboard/profile", keywords: "account avatar email password" },
  { title: "Settings", href: "/dashboard/settings", keywords: "preferences configuration" },
  { title: "Documentation", href: "/docs", keywords: "docs api reference help guide" },
];

export const DashboardLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = React.useState<UserProfile | null>(null)
  const [userLoading, setUserLoading] = React.useState(true)
  // The header search box used to be an input with no handler at all — typing
  // into it did nothing anywhere in the app. It now navigates to a match.
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  // The bell used to pulse a decorative dot forever. It now reflects real
  // failures out of the execution monitor, and only once that has loaded.
  const [failedRuns, setFailedRuns] = React.useState(0);
  const [runsLoaded, setRunsLoaded] = React.useState(false);
  const [density, setDensity] = React.useState<'comfortable' | 'compact'>('comfortable');
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  React.useEffect(() => {
    fetch('/api/settings/workspace')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.settings?.appearance?.density === 'compact') setDensity('compact');
      })
      .catch(() => undefined);
  }, []);


  React.useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch('/api/auth/me')
        const data = (await res.json().catch(() => ({}))) as { user?: UserProfile }
        setUser(data.user ?? null)
      } catch {
        setUser(null)
      } finally {
        setUserLoading(false)
      }
    }
    fetchUser()
  }, []);

  // Guest mode (2026-11-18): a visitor with no session is a guest, not a
  // redirect — the dashboard renders with empty state and a Log in link.
  // `user` stays null for guests; nothing here forces a login.

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/agents/runs', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && data.summary) {
          setFailedRuns(Number(data.summary.failed) || 0);
        }
      })
      .catch(() => {
        /* the header must still render if monitoring is unreachable */
      })
      .finally(() => {
        if (!cancelled) setRunsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);




  const getUserInitials = () => {
    if (!user) return "??";
    const name = user.fullName || user.email || "";
    if (name) return name.split(" ").map((p: string) => p[0]).join("").toUpperCase().slice(0, 2);
    return "??";
  };


  const getPageTitle = () => {
    if (pathname === "/dashboard") return "Overview";
    if (pathname.includes("/agents/create")) return "Agent Creator";
    if (pathname.includes("/rag")) return "Your Files";
    if (pathname.includes("/deployment")) return "Make it live";
    if (pathname.includes("/analytics")) return "System Analytics";
    if (pathname.includes("/settings")) return "Settings";
    if (pathname.includes("/templates")) return "Ready-made agents";
    return "Dashboard";
  };

  if (userLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted">Loading…</span>
      </div>
    );
  }

  const goToPage = (href: string) => {
    setSearchOpen(false);
    setSearchQuery("");
    router.push(href);
  };

  const trimmedSearch = searchQuery.trim().toLowerCase();
  const searchMatches = trimmedSearch
    ? SEARCHABLE_PAGES.filter((page) =>
        `${page.title} ${page.keywords}`.toLowerCase().includes(trimmedSearch),
      ).slice(0, 6)
    : [];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <div className="hidden md:block">
        <Sidebar />
      </div>
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button aria-label="Close navigation" className="absolute inset-0 bg-black/60" onClick={() => setMobileNavOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw]">
            {/* The drawer has exactly one close control: the arrow in the
                Sidebar header below (onCloseDrawer). There is deliberately
                no separate cross button — the arrow does the same job. */}
            <Sidebar onCloseDrawer={() => setMobileNavOpen(false)} />
          </div>
        </div>
      )}
      <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden">

        <header className="relative h-16 flex items-center justify-between px-4 sm:px-6 border-b border-border bg-background flex-shrink-0">
          <div className="relative flex items-center justify-between flex-1 min-w-0">
            <div className="flex items-center gap-4 flex-1 min-w-0">
              <button aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)} className="md:hidden rounded-sm border border-border bg-surface p-2 text-foreground">
                <Menu className="icon-sm" />
              </button>
              {/* text-sm! (not text-sm): the unlayered `h1 { font-size:
                  var(--fs-3xl) }` rule in globals.css beats Tailwind v4
                  utilities, because unlayered author CSS outranks layered
                  utilities regardless of specificity — so without the
                  important marker this title rendered at 28px, 124px wide,
                  and pushed "Log in" off the right edge at 390px.
                  truncate + min-w-0 keep long titles (e.g. "Deployment
                  Center") from doing the same. */}
              <h1 className="text-sm! font-bold text-foreground tracking-tight select-none truncate min-w-0">
                {getPageTitle()}
              </h1>
              <div className="hidden sm:flex max-w-xs w-full relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 icon-xs text-muted" />
                <input
                  type="text"
                  placeholder="Search pages… (Enter to open)"
                  aria-label="Search pages"
                  className="input pl-9 pr-3 py-1.5 text-xs"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setSearchOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchMatches.length > 0) {
                      e.preventDefault();
                      goToPage(searchMatches[0].href);
                    } else if (e.key === "Escape") {
                      setSearchOpen(false);
                    }
                  }}
                />
                {searchOpen && searchMatches.length > 0 && (
                  <ul className="absolute left-0 top-full mt-1 w-full z-50 rounded-sm border border-border-strong bg-surface overflow-hidden">
                    {searchMatches.map((page) => (
                      <li key={page.href}>
                        <button
                          type="button"
                          // mousedown fires before blur, so navigation wins the race.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            goToPage(page.href);
                          }}
                          className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-[var(--row-hover)] transition-colors"
                        >
                          {page.title}
                          <span className="ml-2 text-[10px] text-muted">{page.href}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 relative shrink-0">
              <a
                href="https://github.com/SP23-BSE-106/FYPAGENTFLOW"
                target="_blank"
                rel="noreferrer"
                aria-label="Open the project repository"
                className="text-muted hover:text-foreground transition-colors p-1.5 hover:bg-[var(--row-hover)] rounded-sm"
              >
                <GithubIcon className="icon-sm" />
              </a>
              <Link
                href="/dashboard/analytics"
                aria-label={
                  failedRuns > 0
                    ? `Monitoring: ${failedRuns} failed run${failedRuns === 1 ? "" : "s"}`
                    : "Open the execution monitor"
                }
                title={
                  failedRuns > 0
                    ? `${failedRuns} failed run${failedRuns === 1 ? "" : "s"} — open monitoring`
                    : "Open monitoring"
                }
                className="relative text-muted hover:text-foreground transition-colors p-1.5 hover:bg-[var(--row-hover)] rounded-sm"
              >
                <Bell className="icon-sm" />
                {runsLoaded && failedRuns > 0 && (
                  <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[var(--danger)]" />
                )}
              </Link>
              <Link href="/docs">
                <button className="text-muted hover:text-foreground transition-colors p-1.5 hover:bg-[var(--row-hover)] rounded-sm">
                  <HelpCircle className="icon-sm" />
                </button>
              </Link>
              <ThemeToggle />
              <div className="h-4 w-px bg-border mx-1" />
              <div className="flex items-center gap-2">
                {user ? (
                  <div className="h-7 w-7 rounded-sm bg-accent-muted flex items-center justify-center text-[10px] font-bold text-accent border border-accent/20">
                    {getUserInitials()}
                  </div>
                ) : (
                  // Guest mode: login stays available as a small link.
                  <Link href="/login" className="text-xs font-semibold text-muted hover:text-foreground transition-colors">
                    Log in
                  </Link>
                )}
              </div>
            </div>
          </div>
        </header>
        <TrialBanner />
        <ExpirationLockModal />
        <main className={`flex-1 overflow-y-auto ${density === 'compact' ? 'p-4' : 'p-6'}`}>
          <div className="mx-auto max-w-[var(--container)] h-full relative">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};