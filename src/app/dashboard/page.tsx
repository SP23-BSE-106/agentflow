"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, ArrowUpRight, Bot, History, KeyRound, FolderOpen, Headphones, BookOpen, TrendingUp, ChevronRight } from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

const TEMPLATE_ICONS = [Headphones, BookOpen, TrendingUp];

export default function DashboardPage() {
  type DashboardAgent = {
    _id: string;
    name: string;
    status?: string;
    llmProvider?: string | null;
    workflow?: { nodes?: unknown[] } | null;
    updatedAt?: string;
  };

  const [agents, setAgents] = React.useState<DashboardAgent[]>([]);
  const [activeKeys, setActiveKeys] = React.useState(0);
  const [rag, setRag] = React.useState<{ chunks: number; dimension: number } | null>(null);
  const [runs, setRuns] = React.useState<{ total: number; succeeded: number; failed: number } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const loadDashboard = async () => {
      try {
        const [agentsRes, keysRes, ragRes] = await Promise.all([
          fetch("/api/agents", { credentials: "include" }),
          fetch("/api/settings/api-keys", { credentials: "include" }),
          fetch("/api/rag/status", { credentials: "include" }),
        ]);
        // Past runs are best-effort: a failed read must not blank the page.
        const runsRes = await fetch("/api/agents/runs", { credentials: "include" }).catch(() => null);
        if ([agentsRes, keysRes, ragRes].some((response) => response.status === 401)) {
          throw new Error("Your session has expired. Please log in again.");
        }
        if ([agentsRes, keysRes, ragRes].some((response) => !response.ok)) {
          throw new Error("Some workspace data could not be loaded.");
        }
        const [agentsData, keysData, ragData] = await Promise.all([
          agentsRes.json(),
          keysRes.json(),
          ragRes.json(),
        ]);
        const runsData = runsRes && runsRes.ok ? await runsRes.json().catch(() => null) : null;
        if (cancelled) return;
        setAgents(Array.isArray(agentsData) ? agentsData : []);
        setActiveKeys(Array.isArray(keysData.keys) ? keysData.keys.length : 0);
        setRag({
          chunks: Number(ragData.knowledge_base?.chunks || 0),
          dimension: Number(ragData.knowledge_base?.embedding_dimension || 0),
        });
        if (runsData?.summary) {
          setRuns({
            total: Number(runsData.summary.total || 0),
            succeeded: Number(runsData.summary.succeeded || 0),
            failed: Number(runsData.summary.failed || 0),
          });
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadDashboard();
    return () => { cancelled = true; };
  }, []);

  const embeddingBytes = (rag?.chunks || 0) * (rag?.dimension || 0) * 4;
  const formatBytes = (bytes: number) => {
    if (!bytes) return "Empty";
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const stats = [
    { icon: Bot, title: "Your agents", value: loading ? "—" : String(agents.length), detail: `${agents.filter((agent) => agent.status === "active").length} running` },
    { icon: History, title: "Runs", value: loading ? "—" : String(runs?.total ?? 0), detail: runs ? `${runs.succeeded} worked · ${runs.failed} didn't work` : "No runs yet" },
    { icon: KeyRound, title: "App passwords", value: loading ? "—" : String(activeKeys), detail: "Passwords for other apps" },
    { icon: FolderOpen, title: "Your files", value: loading ? "—" : formatBytes(embeddingBytes), detail: `${rag?.chunks || 0} pieces your agents can read` },
  ];

  const recentFlows = [...agents]
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, 2);

  return (
    <DashboardLayout>
      <div className="space-y-8 font-sans text-[var(--text)]">
        {error && (
          <p className="notice notice-danger" role="alert">{error}</p>
        )}

        <div className="flex flex-col gap-4 border-b border-[var(--border)] pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">
              Workspace overview
            </p>
            <h1 className="text-2xl font-semibold tracking-[-0.015em]">Welcome back</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
              This is your home page. See your agents at a glance, then make a new one.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/dashboard/agents/create" className="btn btn-primary">
              <Plus className="icon-xs mr-1.5" />
              Make an agent
            </Link>
            <Link href="/workflow-builder" className="btn btn-secondary">
              Open builder
              <ArrowUpRight className="icon-xs ml-1.5" />
            </Link>
            <Link href="/welcome" className="btn btn-secondary">
              Welcome guide
            </Link>
          </div>
        </div>

        {/* Ruled stat strip */}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-b border-[var(--border)] pb-6 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => {
            const StatIcon = stat.icon;
            return (
              <div key={stat.title}>
                <dt className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">
                  <StatIcon className="icon-xs" aria-hidden />
                  {stat.title}
                </dt>
                <dd className="font-mono text-2xl font-semibold tabular-nums">{stat.value}</dd>
                <dd className="mt-1 text-xs text-[var(--muted)]">{stat.detail}</dd>
              </div>
            );
          })}
        </dl>

        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Start with a template</h2>
              <Link href="/dashboard/templates" className="text-xs font-semibold">
                View all
              </Link>
            </div>
            <div>
              {[
                { title: "Support Agent", desc: "Answer common questions and help with support tickets, using your own files." },
                { title: "Knowledge Assistant", desc: "Answer questions from your guides and documents." },
                { title: "Sales Agent", desc: "Learn about new leads and write a first message to them." },
              ].map((template, i) => {
                const TemplateIcon = TEMPLATE_ICONS[i] ?? Bot;
                return (
                  <Link key={template.title} href="/dashboard/templates" className="ruled-row flex items-center gap-3 hover:no-underline">
                    <TemplateIcon className="icon-sm shrink-0 text-[var(--accent)]" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[var(--text)]">{template.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-[var(--muted)]">{template.desc}</span>
                    </span>
                    <ChevronRight className="icon-xs shrink-0 text-[var(--muted)]" aria-hidden />
                  </Link>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Recent work</h2>
              <Link href="/workflow-builder" className="text-xs font-semibold">
                Open builder
              </Link>
            </div>
            <div>
              {loading && (
                <p className="border-t border-[var(--border)] py-4 text-xs text-[var(--muted)]">
                  Loading your recent work…
                </p>
              )}
              {recentFlows.length === 0 && !loading && (
                <p className="border-t border-[var(--border)] py-4 text-xs text-[var(--muted)]">
                  You have no agents yet.{" "}
                  <Link href="/dashboard/agents/create" className="font-semibold">
                    Make your first one
                  </Link>{" "}
                  — just describe what you want it to do.
                </p>
              )}
              {recentFlows.map((flow) => (
                <div key={flow._id} className="ruled-row">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{flow.name}</span>
                    <span className="mt-0.5 block font-mono text-xs text-[var(--muted)]">
                      {flow.llmProvider || "No AI service picked yet"} · {flow.workflow?.nodes?.length || 0} steps
                    </span>
                  </span>
                  <span className="status-line shrink-0">
                    <span
                      className={flow.status === "active" ? "lamp lamp-ok" : flow.status === "paused" ? "lamp lamp-paused" : "lamp lamp-soon"}
                      aria-hidden
                    />
                    {flow.status === "active" ? "Running" : flow.status === "paused" ? "Paused" : "Draft"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-4 border-t border-[var(--border)] pt-4 text-xs leading-relaxed text-[var(--muted)]">
              Your recent runs will appear here once agents have run.
            </p>
          </section>
        </div>
      </div>
    </DashboardLayout>
  );
}
