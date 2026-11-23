"use client";

import * as React from "react";
import Link from "next/link";
import { Navbar } from "@/components/ui/Navbar";

export const PublicLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      {/* Navigation Header */}
      <Navbar />

      {/* Main Content Area */}
      <main className="flex-grow">{children}</main>

      {/* Public Footer */}
      <footer className="relative w-full border-t border-border bg-background py-12 overflow-hidden">

        <div className="relative w-full px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="relative flex h-10 w-10 items-center justify-center rounded-sm overflow-hidden border-0 bg-transparent">
                <img
              src="/logo1.png"
              alt="AgentFlow"
              style={{ objectFit: "contain", background: "transparent" }}
              className="h-10 w-10 rounded-sm overflow-hidden"
            />

                </div>
                <span className="text-base font-bold text-foreground">AgentFlow</span>
              </div>
              <p className="text-xs text-muted max-w-xs leading-relaxed">
                Build, test, and run AI helpers — no coding needed.
              </p>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-foreground mb-4 relative pl-3">
                <span className="absolute left-0 top-1 h-3 w-0.5 bg-accent" />
                Product
              </h4>
              <ul className="space-y-2 text-xs">
                <li>
                  <Link
                    href="/workflow-builder"
                    className="text-muted hover:text-accent transition-colors"
                  >
                    Workflow Builder
                  </Link>
                </li>
                <li>
                  <Link
                    href="/testing-sandbox"
                    className="text-muted hover:text-accent transition-colors"
                  >
                    Testing Sandbox
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/templates"
                    className="text-muted hover:text-accent transition-colors"
                  >
                    Templates
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-foreground mb-4 relative pl-3">
                <span className="absolute left-0 top-1 h-3 w-0.5 bg-accent" />
                Resources
              </h4>
              <ul className="space-y-2 text-xs">
                <li>
                  <Link
                    href="/docs"
                    className="text-muted hover:text-accent transition-colors"
                  >
                    Docs
                  </Link>
                </li>
                <li>
                  <Link
                    href="/about"
                    className="text-muted hover:text-accent transition-colors"
                  >
                    About Us
                  </Link>
                </li>
                <li>
                  <Link
                    href="/contact"
                    className="text-muted hover:text-accent transition-colors"
                  >
                    Contact Support
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-foreground mb-4 relative pl-3">
                <span className="absolute left-0 top-1 h-3 w-0.5 bg-accent" />
                Legal
              </h4>
              <ul className="space-y-2 text-xs">
                <li>
                  <Link href="/privacy" className="text-muted hover:text-foreground transition-colors">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-muted hover:text-foreground transition-colors">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="border-t border-border mt-10 pt-6 flex flex-col md:flex-row items-center justify-between text-xs text-muted gap-4">
            <span className="tracking-wide">&copy; {new Date().getFullYear()} AgentFlow Inc. All rights reserved.</span>

            <div className="flex gap-3 items-center">
              {/* Only GitHub has a real destination in the codebase; the
                  old Twitter / Discord items were dead text that looked
                  like navigation, so they are gone rather than linked
                  to invented addresses. */}
              <a
                href="https://github.com/SP23-BSE-106/FYPAGENTFLOW"
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 text-muted hover:text-foreground transition-colors"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};
