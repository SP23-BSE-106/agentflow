"use client";

import * as React from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ChartTooltip,
  Legend,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

type AnalyticsAgent = {
  _id: string;
  name: string;
  status?: string;
  llmProvider?: string | null;
  workflow?: { nodes?: unknown[]; edges?: unknown[] } | null;
};

type ChartRow = { name: string; nodes: number; edges: number };

type RunRow = {
  id: string;
  kind: "exec" | "session";
  agentName: string | null;
  status: "success" | "failed";
  input: string;
  sourceCount: number;
  durationMs: number;
  provider: string | null;
  model: string | null;
  createdAt: string | null;
};

type RunSummary = {
  total: number;
  sessions: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number | null;
  lastRunAt: string | null;
};

function truncate(value: string, max = 18) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Every number on this page is counted from the caller's own workspace —
 * agents, their saved graphs, the vector index and issued keys. Nothing here
 * is sampled or invented, and the things that genuinely are not tracked yet
 * (execution runs, latency, spend) say so instead of showing a plausible value.
 */
export default function AnalyticsPage() {
  const [agents, setAgents] = React.useState<AnalyticsAgent[]>([]);
  const [knowledge, setKnowledge] = React.useState<{ documents: number; chunks: number } | null>(null);
  const [keyCount, setKeyCount] = React.useState(0);
  const [runs, setRuns] = React.useState<RunRow[]>([]);
  const [runSummary, setRunSummary] = React.useState<RunSummary | null>(null);
  const [sizeMetric, setSizeMetric] = React.useState<"nodes" | "edges">("nodes");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [agentsRes, ragRes, keysRes, runsRes] = await Promise.all([
          fetch("/api/agents", { credentials: "include" }),
          fetch("/api/rag/status", { credentials: "include" }),
          fetch("/api/settings/api-keys", { credentials: "include" }),
          // Best-effort: the execution monitor is the newest surface here and
          // it must not be able to blank out the rest of the page.
          fetch("/api/agents/runs", { credentials: "include" }).catch(() => null),
        ]);

        if ([agentsRes, ragRes, keysRes].some((response) => response.status === 401)) {
          throw new Error("Your session has expired. Please log in again.");
        }
        if ([agentsRes, ragRes, keysRes].some((response) => !response.ok)) {
          throw new Error("Workspace analytics could not be loaded.");
        }

        const [agentsData, ragData, keysData, runsData] = await Promise.all([
          agentsRes.json(),
          ragRes.json(),
          keysRes.json(),
          runsRes && runsRes.ok ? runsRes.json() : Promise.resolve(null),
        ]);

        if (cancelled) return;

        setAgents(Array.isArray(agentsData) ? agentsData : []);
        setKnowledge({
          documents: Number(ragData?.knowledge_base?.documents || 0),
          chunks: Number(ragData?.knowledge_base?.chunks || 0),
        });
        setKeyCount(Array.isArray(keysData?.keys) ? keysData.keys.length : 0);
        if (runsData && Array.isArray(runsData.runs)) {
          setRuns(runsData.runs);
          setRunSummary(runsData.summary ?? null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load analytics.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const sizeRows = React.useMemo<ChartRow[]>(
    () =>
      agents
        .map((agent) => ({
          name: truncate(agent.name),
          nodes: agent.workflow?.nodes?.length ?? 0,
          edges: agent.workflow?.edges?.length ?? 0,
        }))
        .sort((a, b) => b.nodes - a.nodes),
    [agents],
  );

  const providerRows = React.useMemo(() => {
    const tally = new Map<string, number>();
    for (const agent of agents) {
      const label = agent.llmProvider?.trim() || "Not set yet";
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    return [...tally.entries()].map(([name, count]) => ({ name, count }));
  }, [agents]);

  const totalNodes = agents.reduce((sum, agent) => sum + (agent.workflow?.nodes?.length ?? 0), 0);
  const activeAgents = agents.filter((agent) => agent.status === "active").length;

  const toggleAgentStatus = async (agent: AnalyticsAgent) => {
    const nextStatus = agent.status === "active" ? "paused" : "active";
    try {
      const res = await fetch(`/api/agents/${agent._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error("Failed to update agent status");
      setAgents((prev) => prev.map((a) => (a._id === agent._id ? { ...a, status: nextStatus } : a)));
    } catch (err) {
      console.error(err);
    }
  };

  React.useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const runsRes = await fetch('/api/agents/runs', { credentials: 'include' });
        if (runsRes.ok) {
          const runsData = await runsRes.json();
          if (runsData && Array.isArray(runsData.runs)) {
            setRuns(runsData.runs);
            setRunSummary(runsData.summary ?? null);
          }
        }
      } catch {
        /* keep last known monitor data */
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  const stats = [
    { label: "Agents", value: String(agents.length) },
    { label: "Workflow steps", value: String(totalNodes) },
    { label: "File pieces", value: String(knowledge?.chunks ?? 0) },
    { label: "App passwords", value: String(keyCount) },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-8 font-sans text-[var(--text)]">
        {/* Header */}
        <div className="space-y-1 border-b border-[var(--border)] pb-6">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-[-0.015em]">
            <BarChart3 className="icon-lg text-[var(--accent)]" />
            Workspace Analytics
          </h1>
          <p className="max-w-[68ch] text-sm leading-relaxed text-[var(--muted)]">
            Live counts from your workspace: agents, saved workflow steps, your files and app passwords.
          </p>
        </div>

        {error && (
          <p className="notice notice-danger" role="alert">{error}</p>
        )}

        {loading && (
          <p className="text-xs text-[var(--muted)]">Reading workspace totals…</p>
        )}

        {/* Live KPI strip */}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-b border-[var(--border)] pb-6 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt className="mb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">
                {stat.label}
              </dt>
              <dd className="font-mono text-2xl font-semibold tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>

        {/* Charts */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          <section className="lg:col-span-2">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Workflow size by agent</h2>
                <p className="text-xs text-[var(--muted)]">Counted from each saved agent.</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSizeMetric("nodes")}
                  className={sizeMetric === "nodes" ? "btn btn-secondary" : "btn btn-ghost"}
                  aria-pressed={sizeMetric === "nodes"}
                >
                  Steps
                </button>
                <button
                  type="button"
                  onClick={() => setSizeMetric("edges")}
                  className={sizeMetric === "edges" ? "btn btn-secondary" : "btn btn-ghost"}
                  aria-pressed={sizeMetric === "edges"}
                >
                  Connections
                </button>
              </div>
            </div>

            <div className="min-h-[220px] w-full">
              {sizeRows.length === 0 ? (
                <EmptyState
                  title="No workflows to chart yet"
                  hint="Create an agent and draw its flow — its steps will show up here."
                />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={sizeRows} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.7} />
                    <XAxis dataKey="name" stroke="var(--muted)" fontSize={11} tickLine={false} />
                    <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} allowDecimals={false} />
                    <ChartTooltip
                      contentStyle={{
                        backgroundColor: "var(--surface)",
                        borderColor: "var(--border-strong)",
                        borderRadius: "2px",
                        fontSize: "12px",
                        color: "var(--text)",
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: "12px", marginTop: "10px" }} />
                    <Bar
                      dataKey={sizeMetric}
                      fill="var(--accent)"
                      radius={[2, 2, 0, 0]}
                      name={sizeMetric === "nodes" ? "Steps" : "Connections"}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          <section>
            <div className="mb-4">
              <h2 className="text-base font-semibold">Agents by AI service</h2>
              <p className="text-xs text-[var(--muted)]">The AI service picked for each agent.</p>
            </div>

            <div className="min-h-[220px] w-full">
              {providerRows.length === 0 ? (
                <EmptyState
                  title="Nothing configured yet"
                  hint="Pick an AI service while creating an agent."
                />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={providerRows} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.7} />
                    <XAxis dataKey="name" stroke="var(--muted)" fontSize={11} tickLine={false} />
                    <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} allowDecimals={false} />
                    <ChartTooltip
                      contentStyle={{
                        backgroundColor: "var(--surface)",
                        borderColor: "var(--border-strong)",
                        borderRadius: "2px",
                        fontSize: "12px",
                        color: "var(--text)",
                      }}
                    />
                    <Bar dataKey="count" fill="var(--accent)" radius={[2, 2, 0, 0]} name="Agents" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>
        </div>

        {/* Agent controls */}
        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Agent controls</h2>
              <p className="text-xs text-[var(--muted)]">Pause or resume agents without deleting their workflows.</p>
            </div>
            <p className="status-line">
              <span className={agents.some((a) => a.status === "paused") ? "lamp lamp-paused" : "lamp lamp-ok"} aria-hidden />
              {agents.filter((a) => a.status === "active").length} active / {agents.filter((a) => a.status === "paused").length} paused
            </p>
          </div>
          {agents.length === 0 ? (
            <EmptyState title="No agents yet" hint="Create an agent to control it here." />
          ) : (
            <div>
              {agents.map((agent) => (
                <div key={agent._id} className="ruled-row">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{agent.name}</span>
                    <span className="mt-0.5 block font-mono text-xs text-[var(--muted)]">
                      {agent.workflow?.nodes?.length ?? 0} steps · {agent.workflow?.edges?.length ?? 0} connections
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="status-line">
                      <span className={agent.status === "active" ? "lamp lamp-ok" : "lamp lamp-paused"} aria-hidden />
                      {agent.status === "active" ? "Active" : "Paused"}
                    </span>
                    <button type="button" className="btn btn-secondary" onClick={() => toggleAgentStatus(agent)}>
                      {agent.status === "active" ? "Pause" : "Resume"}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Past runs — measured by POST /api/agents/runs */}
        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Past runs</h2>
              <p className="text-xs text-[var(--muted)]">
                Written every time you run a message in Try it out. Nothing here is guessed.
              </p>
            </div>
            <p className="status-line">
              <span className={runSummary && runSummary.failed > 0 ? "lamp lamp-paused" : "lamp lamp-ok"} aria-hidden />
              {runSummary
                ? `${runSummary.succeeded} worked / ${runSummary.failed} didn't work`
                : "No runs yet"}
            </p>
          </div>

          <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-4 border-b border-[var(--border)] pb-6 lg:grid-cols-4">
            <Metric label="Runs" value={String(runSummary?.total ?? 0)} />
            <Metric label="Worked" value={String(runSummary?.succeeded ?? 0)} />
            <Metric label="Didn't work" value={String(runSummary?.failed ?? 0)} />
            <Metric
              label="Average time"
              value={runSummary?.avgDurationMs != null ? `${runSummary.avgDurationMs} ms` : "—"}
            />
          </dl>

          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              hint="Open Try it out from the menu and send a message — every run lands here with how long it took and which model answered."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>Your message</th>
                    <th>Result</th>
                    <th className="text-right">Time taken</th>
                    <th>Model</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="whitespace-nowrap font-mono text-xs text-[var(--muted)]">
                        {run.createdAt ? new Date(run.createdAt).toLocaleString() : "—"}
                      </td>
                      <td className="font-mono text-xs">
                        {run.kind === "session" ? "Saved chat" : "Run"}
                      </td>
                      <td
                        className="max-w-[260px] truncate text-xs"
                        title={run.input}
                      >
                        {run.input || "—"}
                      </td>
                      <td className="text-xs">
                        <span className="status-line">
                          <span className={run.status === "failed" ? "lamp lamp-danger" : "lamp lamp-ok"} aria-hidden />
                          {run.status === "failed" ? "Failed" : "Success"}
                        </span>
                        {run.sourceCount > 0 && (
                          <span className="text-[var(--muted)]"> · {run.sourceCount} passages</span>
                        )}
                      </td>
                      <td className="text-right font-mono text-xs tabular-nums">
                        {run.durationMs ? `${run.durationMs} ms` : "—"}
                      </td>
                      <td
                        className="max-w-[170px] truncate text-xs text-[var(--muted)]"
                        title={[run.provider, run.model].filter(Boolean).join(" — ")}
                      >
                        {run.model || run.provider || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* What is not tracked — stated rather than faked */}
        <section className="border-t border-[var(--border)] pt-6">
          <h2 className="mb-1 text-base font-semibold">
            What is counted, and what still is not
          </h2>
          <p className="max-w-[72ch] text-xs leading-relaxed text-[var(--muted)]">
            Run counts and how long runs took come from Past runs above — real records written when Try it out
            runs a message. Token spend, per-step timings and retry counts are still captured nowhere in
            the platform, so they are left out rather than estimated. The size of your files, workflow structure and
            app passwords are counted directly from your records.
            {agents.length > 0 && (
              <span className="mt-1 block text-[var(--text)]">
                Right now: {agents.length} {agents.length === 1 ? "agent" : "agents"}, {activeAgents} active,{" "}
                {totalNodes} workflow steps, {knowledge?.documents ?? 0}{" "}
                {(knowledge?.documents ?? 0) === 1 ? "document" : "documents"} indexed,{" "}
                {runSummary?.total ?? 0} {(runSummary?.total ?? 0) === 1 ? "run" : "runs"} recorded.
              </span>
            )}
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="mb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">{label}</dt>
      <dd className="font-mono text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="border-t border-b border-[var(--border)] py-6">
      <p className="text-xs font-semibold">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-[var(--muted)]">{hint}</p>
    </div>
  );
}
