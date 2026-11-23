"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

export const THEME_STORAGE_KEY = "agentflow-theme";

export type Theme = "light" | "dark";

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — the attribute still applies for this visit */
  }
}

/**
 * KFS-style theme toggle: a 36px square hairline button. The sun/moon
 * icon swap is driven by [data-theme] in globals.css (.theme-toggle).
 * Persists "agentflow-theme" in localStorage; the pre-paint script in
 * app/layout.tsx applies it before first paint.
 */
export const ThemeToggle: React.FC<{ className?: string }> = ({ className }) => {
  const toggle = () => {
    const current =
      document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    applyTheme(current === "dark" ? "light" : "dark");
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn("theme-toggle", className)}
      aria-label="Toggle light and dark theme"
      title="Toggle light and dark theme"
      suppressHydrationWarning
    >
      {/* Both icons always render; [data-theme] in globals.css shows the right one. */}
      <Sun className="icon-sun" aria-hidden="true" />
      <Moon className="icon-moon" aria-hidden="true" />
    </button>
  );
};
