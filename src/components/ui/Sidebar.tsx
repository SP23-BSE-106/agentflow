'use client';
import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, GitBranch, Terminal, CloudLightning, BarChart3, Sliders, ChevronLeft, ChevronRight, BookOpen, Boxes, LogOut, LogIn, CreditCard, ListChecks, Plus, User, Database, Shield, Zap, Key, Server } from "lucide-react";

import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

/**
 * KFS rail: 248px, paper ground, one hairline at the right edge.
 * Nav is a ruled list; the current page gets a 2px teal left border
 * (.nav-item / .nav-item-active in globals.css). No shadows, no
 * gradients, no motion. Theme toggle lives in the footer.
 */
interface SidebarProps {
  className?: string;
  /**
   * Set only for the Sidebar rendered inside the mobile drawer
   * (DashboardLayout): the header arrow then closes the drawer instead
   * of collapsing the rail, so the drawer has exactly one close control.
   */
  onCloseDrawer?: () => void;
}
export const Sidebar: React.FC<SidebarProps> = ({ className, onCloseDrawer }) => {
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [user, setUser] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const pathname = usePathname();
  const router = useRouter();
  React.useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch('/api/auth/me')
        const data = (await res.json().catch(() => ({}))) as { user?: { fullName?: string; email?: string } }
        setUser(data.user ?? null)
      } catch {
        setUser(null)
      } finally {
        setLoading(false)
      }
    }
    fetchUser()
  }, [])

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      router.push('/login')
    } catch {
      router.push('/login')
    }
  }
  const navItems = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "My Agents", href: "/dashboard/agents", icon: ListChecks },
    { name: "Create Agent", href: "/dashboard/agents/create", icon: Plus },
    { name: "Workflow Builder", href: "/workflow-builder", icon: GitBranch },
    { name: "Testing Sandbox", href: "/testing-sandbox", icon: Terminal },
    // The RAG console is a full page but had no entry point anywhere — it could
    // only be reached by typing the URL.
    { name: "Your Files", href: "/dashboard/rag", icon: Database },
    { name: "Deployments", href: "/dashboard/deployment", icon: CloudLightning },
    { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
    { name: "Templates", href: "/dashboard/templates", icon: Boxes },
    { name: "Run helpers together", href: "/dashboard/orchestrate", icon: Zap },
    { name: "Human Approvals", href: "/dashboard/approvals", icon: Shield },
    { name: "Documentation", href: "/docs", icon: BookOpen },
    { name: "Profile", href: "/dashboard/profile", icon: User },
    { name: "Settings", href: "/dashboard/settings", icon: Sliders },
    { name: "Billing", href: "/dashboard/payment", icon: CreditCard },
  ];
  // Developer surfaces, grouped out of the everyday path: app passwords
  // (API keys) and the technical system status. They still work exactly as
  // before — they just live under Advanced now.
  const advancedItems = [
    { name: "App passwords", href: "/dashboard/settings#api-keys", icon: Key },
    { name: "System status", href: "/dashboard/settings#system", icon: Server },
  ];
  const getUserInitials = () => {
    // A guest has no user record — that is a settled state, not a loading
    // one. "??" is only the fallback for a signed-in user with no name or
    // email on record.
    if (!user) return "G";
    const u = user as { fullName?: string; email?: string };
    const name = u.fullName || u.email || "";
    if (!name) return "??";
    return name.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2);
  };
  const getUserDisplayName = () => {
    // Same split as the initials: a null user means "guest", never
    // "Loading..." — /api/auth/me answers { user: null } immediately for a
    // guest, so the old text sat there permanently. Real loading is shown
    // by the `loading` flag, not by this helper.
    if (!user) return "Guest";
    const u = user as { fullName?: string; email?: string };
    return u.fullName || u.email?.split("@")[0] || "User";
  };
  return (
    <aside
      style={isCollapsed ? { width: 70, flexBasis: 70 } : undefined}
      className={cn("sidebar h-screen shrink-0 text-foreground", className)}
    >
      <div className={cn("flex items-center h-16 border-b border-border", isCollapsed ? "justify-center px-2" : "justify-between px-4")}>
        {!isCollapsed && (
          <Link href="/dashboard" className="flex items-center gap-3 select-none overflow-hidden min-w-0">
            <Image src="/logo1.png" alt="AgentFlow" width={40} height={40} className="h-10 w-10 shrink-0 rounded-sm overflow-hidden" />
            <span className="text-base font-semibold tracking-tight whitespace-nowrap">AgentFlow</span>
          </Link>
        )}
        {/* The arrow lives inside the drawer header, at the right end of
            this row — never straddling the sidebar's right edge. On
            desktop it collapses/expands the rail; inside the mobile
            drawer (onCloseDrawer set) it closes the drawer instead, so
            the drawer needs no separate cross button. */}
        <button
          type="button"
          onClick={() => {
            if (onCloseDrawer) {
              onCloseDrawer();
            } else {
              setIsCollapsed(!isCollapsed);
            }
          }}
          aria-label={onCloseDrawer ? "Close navigation" : isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-surface text-muted hover:text-foreground transition-colors"
        >
          {onCloseDrawer || !isCollapsed ? <ChevronLeft className="icon-sm" /> : <ChevronRight className="icon-sm" />}
        </button>
      </div>
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        <ul className="m-0 p-0 list-none flex flex-col gap-px">
          {navItems.map((item) => {
            const isActive =
              item.href === "/dashboard"
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);

            // Avoid accidental redirects: keep nav active logic purely UI.
            // (This component relies on DashboardLayout for auth redirect.)
            const Icon = item.icon;
            return (
              <li key={item.name} className="m-0">
                <Link
                  href={item.href}
                  title={isCollapsed ? item.name : undefined}
                  className={cn("nav-item group", isActive && "nav-item-active")}
                >
                  <Icon className={cn("icon-sm shrink-0", isActive ? "text-accent" : "text-muted group-hover:text-foreground")} />
                  {!isCollapsed && <span className="whitespace-nowrap truncate min-w-0" title={item.name}>{item.name}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        {/* Advanced — developer surfaces, kept out of the everyday path. */}
        {!isCollapsed && (
          <p className="mt-4 mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted">
            Advanced
          </p>
        )}
        <ul className="m-0 p-0 list-none flex flex-col gap-px">
          {advancedItems.map((item) => {
            // Anchor links (#api-keys / #system) point at sections of the
            // settings page; the base path is what the router can match.
            const baseHref = item.href.split("#")[0];
            const isActive = pathname === baseHref;
            const Icon = item.icon;
            return (
              <li key={item.name} className="m-0">
                <Link
                  href={item.href}
                  title={isCollapsed ? `${item.name} (Advanced)` : item.name}
                  className={cn("nav-item group", isActive && "nav-item-active")}
                >
                  <Icon className={cn("icon-sm shrink-0", isActive ? "text-accent" : "text-muted group-hover:text-foreground")} />
                  {!isCollapsed && <span className="whitespace-nowrap truncate min-w-0" title={item.name}>{item.name}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="h-8 w-8 rounded-sm bg-accent-muted border border-accent/20 flex items-center justify-center text-xs font-bold text-accent shrink-0">{loading ? "..." : getUserInitials()}</div>
          {!isCollapsed && !loading && <div className="flex flex-col text-left overflow-hidden flex-1"><span className="text-xs font-bold text-foreground leading-none truncate">{getUserDisplayName()}</span><span className="text-[10px] text-muted truncate mt-1">{(user as { email?: string })?.email || ""}</span></div>}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          {/* The auth control matches the session, never both at once: a
              guest gets "Log in" (the header shows the same), a signed-in
              user gets "Sign Out". While the session is still loading
              neither renders, so the two never flash side by side. */}
          {!loading && !isCollapsed && (
            user ? (
              <button onClick={handleSignOut} className="flex items-center gap-2 px-3 py-2 rounded-sm text-xs font-semibold text-muted hover:text-danger transition-colors"><LogOut className="icon-sm" />Sign Out</button>
            ) : (
              <Link href="/login" className="flex items-center gap-2 px-3 py-2 rounded-sm text-xs font-semibold text-muted hover:text-foreground transition-colors"><LogIn className="icon-sm" />Log in</Link>
            )
          )}
          {!loading && isCollapsed && (
            user ? (
              <button onClick={handleSignOut} className="mx-auto flex items-center justify-center p-2 rounded-sm text-muted hover:text-danger transition-colors" title="Sign Out"><LogOut className="icon-sm" /></button>
            ) : (
              <Link href="/login" className="mx-auto flex items-center justify-center p-2 rounded-sm text-muted hover:text-foreground transition-colors" title="Log in"><LogIn className="icon-sm" /></Link>
            )
          )}
          {!isCollapsed && <ThemeToggle />}
        </div>
        {isCollapsed && (
          <div className="mt-2 flex justify-center">
            <ThemeToggle />
          </div>
        )}
      </div>
    </aside>
  );
};
