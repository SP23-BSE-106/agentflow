import type { Metadata } from "next";
import "./globals.css";
import FirstVisitRedirect from "@/components/welcome/FirstVisitRedirect";

export const metadata: Metadata = {
  title: "AgentFlow — build, test and run AI helpers",
  description:
    "Draw the steps, add your own files, and test the result live. No coding needed.",
};

/**
 * Runs before first paint: resolves the theme from localStorage
 * ("agentflow-theme") or, on first visit, from prefers-color-scheme,
 * and sets data-theme on <html> so there is no light/dark flash.
 * Default is LIGHT. Mirrors the KrawFreeShell pre-paint script.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("agentflow-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="light";}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* The Plex stacks in globals.css stand alone if this stylesheet
            never arrives. Keep the attribute state static to avoid
            mutating the SSR markup before React hydration. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* App Router root layout, not pages/_document; the Plex stacks in globals.css stand alone if this never loads. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          id="plex-fonts"
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
          media="all"
        />
      </head>
      <body className="min-h-full flex flex-col">
        <FirstVisitRedirect />
        {children}
      </body>
    </html>
  );
}
