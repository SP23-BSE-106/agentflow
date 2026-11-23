"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Play, Save, CloudLightning, Terminal, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { cn } from "@/lib/utils";

interface BuilderLayoutProps {
  children: React.ReactNode; // Typically the react-flow canvas
  title: string;
  subtitle?: string;
  leftPanel?: React.ReactNode;
  rightPanel?: React.ReactNode;
  bottomLogs?: React.ReactNode;
  onRun?: () => void;
  onSave?: () => void;
  onDeploy?: () => void;
  /**
   * Label for the save button. It reads "Save" in the builder; the
   * testing sandbox has no draft to save, so it passes its own wording rather
   * than shipping a button whose label promises something it does not do.
   */
  saveLabel?: string;
  /** Label for the run button. The builder runs the flow; the sandbox runs
   *  the last message again, so it passes its own wording. */
  runLabel?: string;
  /** Where "Try it out" goes — the builder carries the agent so the sandbox opens with it. */
  sandboxHref?: string;
  isRunning?: boolean;
  isSaving?: boolean;
  autoSaveStatus?: "idle" | "saving" | "saved" | "error";
  /** True when the last save went to this browser, not the server — a guest's
   *  auto-save. The indicator then says so in plain words. */
  savedInBrowser?: boolean;
  /** Server's reason for the last failed save, shown verbatim when it fails. */
  autoSaveError?: string | null;
  lastSavedTime?: Date | null;
}

export const BuilderLayout: React.FC<BuilderLayoutProps> = ({
  children,
  title,
  subtitle,
  leftPanel,
  rightPanel,
  bottomLogs,
  onRun,
  onSave,
  onDeploy,
  saveLabel = "Save",
  runLabel = "Run",
  sandboxHref = "/testing-sandbox",
  isRunning = false,
  isSaving = false,
  autoSaveStatus = "idle",
  savedInBrowser = false,
  autoSaveError = null,
  lastSavedTime = null,
}) => {
  const [showLogs, setShowLogs] = React.useState(true);
  // On a phone the panels start closed so the canvas is visible; on a
  // desktop they start open as before.
  const [leftOpen, setLeftOpen] = React.useState(() => typeof window === "undefined" || window.innerWidth >= 768);
  const [rightOpen, setRightOpen] = React.useState(() => typeof window === "undefined" || window.innerWidth >= 768);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground select-none">
      {/* Header bar */}
      <header className="min-h-14 border-b border-border bg-background px-4 py-2 flex flex-wrap items-center justify-between gap-2 flex-shrink-0 z-10">
        <div className="flex items-center gap-3">
          <Link href="/dashboard">
            <button aria-label="Back to dashboard" className="h-8 w-8 flex items-center justify-center rounded-sm border border-border bg-surface hover:bg-surface-2 hover:text-accent transition-colors">
              <ArrowLeft className="icon-sm" />
            </button>
          </Link>
          <div className="flex flex-col text-left">
            <h1 className="text-xs font-bold text-foreground leading-none">{title}</h1>
            {subtitle && <p className="text-[10px] text-muted mt-1">{subtitle}</p>}
          </div>
        </div>

        {/* Builder Toolbar Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {onRun && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRun}
              isLoading={isRunning}
              className="border-accent/20 text-accent hover:bg-accent/10"
            >
              <Play className="icon-xs mr-1.5 fill-current" />
              {runLabel}
            </Button>
          )}
          <Link href={sandboxHref}>
            <Button variant="outline" size="sm" className="border-border text-foreground hover:bg-surface-light">
              <Terminal className="icon-xs mr-1.5 text-accent" />
              Try it out
            </Button>
          </Link>
          {onSave && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onSave}
              isLoading={isSaving}
              disabled={isSaving}
            >
              <Save className="icon-xs mr-1.5" />
              {saveLabel}
            </Button>
          )}
          
          {/* Auto-save Status Indicator */}
          {autoSaveStatus !== "idle" && (
            <div
              className="status-line"
              title={autoSaveError ?? undefined}
            >
              {autoSaveStatus === "saving" && (
                <>
                  <span className="lamp lamp-dev" />
                  Saving...
                </>
              )}
              {autoSaveStatus === "saved" && (
                <>
                  <span className="lamp lamp-ok" />
                  {savedInBrowser ? "Saved in this browser" : "Saved"}
                </>
              )}
              {autoSaveStatus === "error" && (
                <>
                  <span className="lamp lamp-danger" />
                  Save Failed
                </>
              )}
            </div>
          )}
          
          {lastSavedTime && (
            <span className="text-[9px] text-muted ml-1">
              Last saved: {lastSavedTime.toLocaleTimeString()}
            </span>
          )}
          {onDeploy && (
            <Button size="sm" onClick={onDeploy}>
              <CloudLightning className="icon-xs mr-1.5" />
              Make live
            </Button>
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* A failed auto-save must say why — "Save Failed" alone sends you to the
          console with no endpoint, no status text and no server message. */}
      {autoSaveStatus === "error" && autoSaveError && (
        <div
          role="alert"
          className="notice-danger flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2 text-[11px]"
        >
          <span className="font-semibold shrink-0">Save failed — your last change was not written.</span>
          <span className="truncate" title={autoSaveError}>
            {autoSaveError}
          </span>
        </div>
      )}

      {/* Main Body Panels */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Left Side Panel */}
        {leftPanel && leftOpen && (
          <aside className="w-72 border-r border-border bg-surface flex flex-col min-w-[280px] z-30 max-md:fixed max-md:left-0 max-md:top-14 max-md:bottom-0 max-md:border-r-2 max-md:border-border-strong">
            {leftPanel}
          </aside>
        )}
        
        {/* Toggle Left Button */}
        {leftPanel && (
          <button
            aria-label={leftOpen ? "Close step list" : "Open step list"}
            onClick={() => setLeftOpen(!leftOpen)}
            className={cn(
              "absolute left-0 top-1/2 -translate-y-1/2 z-20 flex h-8 w-5 items-center justify-center rounded-r border border-l-0 border-border bg-surface text-muted hover:text-foreground",
              leftOpen ? "left-72" : "left-0"
            )}
          >
            {leftOpen ? <ChevronLeft className="icon-xs" /> : <ChevronRight className="icon-xs" />}
          </button>
        )}

        {/* Center Workspace Area */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <div className="flex-1 relative bg-background">
            {children}
          </div>

          {/* Bottom Log Pane */}
          {bottomLogs && (
            <div
              className={cn(
                "border-t border-border bg-surface flex flex-col transition-[height] duration-200 ease-out z-10",
                showLogs ? "h-64" : "h-9"
              )}
            >
              <div
                onClick={() => setShowLogs(!showLogs)}
                className="h-9 px-4 flex items-center justify-between border-b border-border hover:bg-[var(--row-hover)] cursor-pointer text-xs font-semibold text-muted hover:text-foreground select-none"
              >
                <div className="flex items-center gap-2">
                  <Terminal className="icon-sm text-accent" />
                  <span>Step-by-step record</span>
                </div>
                <div>{showLogs ? <ChevronDown className="icon-sm" /> : <ChevronUp className="icon-sm" />}</div>
              </div>
              {showLogs && <div className="flex-1 overflow-auto bg-[var(--surface-2)] font-mono text-xs select-text">{bottomLogs}</div>}
            </div>
          )}
        </div>

        {/* Toggle Right Button */}
        {rightPanel && (
          <button
            aria-label={rightOpen ? "Close settings panel" : "Open settings panel"}
            onClick={() => setRightOpen(!rightOpen)}
            className={cn(
              "absolute right-0 top-1/2 -translate-y-1/2 z-20 flex h-8 w-5 items-center justify-center rounded-l border border-r-0 border-border bg-surface text-muted hover:text-foreground",
              rightOpen ? "right-[320px]" : "right-0"
            )}
          >
            {rightOpen ? <ChevronRight className="icon-xs" /> : <ChevronLeft className="icon-xs" />}
          </button>
        )}

        {/* Right Properties Panel */}
        {rightPanel && rightOpen && (
          <aside className="w-80 border-l border-border bg-surface flex flex-col min-w-[300px] z-30 max-md:fixed max-md:right-0 max-md:top-14 max-md:bottom-0 max-md:border-l-2 max-md:border-border-strong">
            {rightPanel}
          </aside>
        )}
      </div>
    </div>
  );
};
