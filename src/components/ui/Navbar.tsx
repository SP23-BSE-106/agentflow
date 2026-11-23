"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./Button";
import { ThemeToggle } from "./ThemeToggle";

/**
 * KFS public header: flat background, one hairline at the bottom,
 * plain wordmark, theme toggle in the desktop actions.
 */
export const Navbar: React.FC = () => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [user, setUser] = React.useState<{ fullName?: string; email?: string } | null>(null);
  const [userLoading, setUserLoading] = React.useState(true);
  const pathname = usePathname();

  // Signed-in state, as the dashboard does: /api/auth/me answers
  // { user: null } immediately for a guest, so a null user is a settled
  // guest state, not a loading one. While the session is still loading
  // neither the guest nor the signed-in control renders, so "Log in"
  // never flashes for a signed-in user.
  React.useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = (await res.json().catch(() => ({}))) as {
          user?: { fullName?: string; email?: string };
        };
        setUser(data.user ?? null);
      } catch {
        setUser(null);
      } finally {
        setUserLoading(false);
      }
    };
    fetchUser();
  }, []);

  const getUserInitials = () => {
    if (!user) return "??";
    const name = user.fullName || user.email || "";
    if (!name) return "??";
    return name
      .split(" ")
      .map((p) => p[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const getUserDisplayName = () => {
    if (!user) return "Guest";
    return user.fullName || user.email?.split("@")[0] || "User";
  };

  const publicLinks = [
    { name: "Docs", href: "/docs" },
    { name: "Marketplace", href: "/dashboard/templates" },
    { name: "About", href: "/about" },
    { name: "Contact", href: "/contact" },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background">
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3">
            <img
              src="/logo1.png"
              alt="AgentFlow"
              style={{ objectFit: "contain", background: "transparent" }}
              className="h-10 w-10 rounded-sm overflow-hidden"
            />

            <span className="text-lg font-semibold tracking-tight text-foreground">

              AgentFlow
            </span>
          </Link>

          {/* Desktop Nav Links */}
          <nav className="hidden md:flex items-center gap-8">
            {publicLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className={cn(
                  "text-xs font-semibold tracking-wide uppercase transition-colors",
                  pathname === link.href
                    ? "text-accent"
                    : "text-muted hover:text-foreground"
                )}
              >
                {link.name}
              </Link>
            ))}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-3.5">
            <ThemeToggle />
            {!userLoading &&
              (user ? (
                <Link
                  href="/dashboard/profile"
                  className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-1.5 transition-colors hover:border-accent/40"
                  title={user.email || getUserDisplayName()}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-accent/20 bg-accent-muted text-[10px] font-bold text-accent">
                    {getUserInitials()}
                  </span>
                  <span className="max-w-32 truncate text-sm font-semibold text-foreground">
                    {getUserDisplayName()}
                  </span>
                </Link>
              ) : (
                <Link href="/login">
                  <Button variant="ghost" size="sm">
                    Log in
                  </Button>
                </Link>
              ))}
            {/* Signup is deferred (accounts come later): the header goes
                straight to the product instead of a signup page. */}
            <Link href="/dashboard">
              <Button size="sm">
                Open the Builder
              </Button>
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            aria-label={isOpen ? "Close menu" : "Open menu"}
            aria-expanded={isOpen}
            className="md:hidden flex h-10 w-10 items-center justify-center rounded-sm border border-border text-muted hover:text-foreground transition-colors"
          >
            {isOpen ? <X className="icon-lg" /> : <Menu className="icon-lg" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer menu */}
      {isOpen && (
        <div className="md:hidden border-b border-border bg-surface px-4 py-4 space-y-3.5">
          <nav className="flex flex-col gap-3">
            {publicLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                onClick={() => setIsOpen(false)}
                className={cn(
                  "text-sm font-semibold tracking-wide uppercase py-2 transition-colors",
                  pathname === link.href ? "text-accent" : "text-muted"
                )}
              >
                {link.name}
              </Link>
            ))}
          </nav>
          <div className="h-[1px] bg-border" />
          <div className="flex items-center justify-between pt-1.5">
            <span className="text-xs text-muted font-medium">Theme</span>
            <ThemeToggle />
          </div>
          <div className="flex flex-col gap-2 pt-1.5">
            {!userLoading &&
              (user ? (
                <Link
                  href="/dashboard/profile"
                  onClick={() => setIsOpen(false)}
                  className="flex w-full items-center gap-2.5 rounded-sm border border-border bg-surface px-3 py-2.5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-accent/20 bg-accent-muted text-xs font-bold text-accent">
                    {getUserInitials()}
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {getUserDisplayName()}
                    </span>
                    {user.email && (
                      <span className="block truncate text-xs text-muted">{user.email}</span>
                    )}
                  </span>
                </Link>
              ) : (
                <Link href="/login" onClick={() => setIsOpen(false)} className="w-full">
                  <Button variant="secondary" className="w-full" size="sm">
                    Log in
                  </Button>
                </Link>
              ))}
            <Link href="/dashboard" onClick={() => setIsOpen(false)} className="w-full">
              <Button className="w-full" size="sm">
                Open the Builder
              </Button>
            </Link>
          </div>
        </div>
      )}
    </header>
  );
};
