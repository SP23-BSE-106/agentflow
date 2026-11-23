"use client";

import * as React from "react";
import Link from "next/link";
import {
  Plus, Cpu, ArrowUpRight, Trash2, Play, Calendar,
  Layers, ChevronRight, Loader2, AlertTriangle, Shield,
  History, Clock, RotateCcw, Save
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import type { Agent } from "@/lib/mongo/agent";

type AgentRow = Omit<Agent, "_id"> & { _id: string };

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Gemini",
  cohere: "Cohere",
};

function formatDate(d: Date | string) {
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function EmptyState() {
  return (
    <div className="border-t border-b border-[var(--border)] py-12 text-center">
      <h3 className="font-semibold text-[var(--text)] text-sm">No agents yet</h3>
      <p className="text-xs text-[var(--muted)] mt-1 max-w-xs mx-auto">
        An agent is a helper that does a job for you. Describe what you want in
        plain words and we will build it for you.
      </p>
      <Link href="/dashboard/agents/create" className="btn btn-primary mt-5 inline-flex">
        <Plus className="icon-xs mr-1.5" />
        Make your first agent
      </Link>
    </div>
  );
}

type VersionRow = {
  _id: string;
  version: number | string;
  createdAt: string;
  notes?: string;
};

/**
 * Versions & schedule panel (H22 + H23).
 *
 * Per agent: lists the saved versions with a Restore button (POST
 * /api/agents/:id/versions/:version/restore) and a schedule form (PATCH
 * /api/agents/:id {schedule:{cron, timezone}} — null clears it). The
 * schedule is the cron `POST /api/triggers/check` fires on.
 */
function AgentDetails({
  agent,
  onAgentUpdated,
}: {
  agent: AgentRow;
  onAgentUpdated: (updated: AgentRow) => void;
}) {
  const [versions, setVersions] = React.useState<VersionRow[] | null>(null);
  const [versionsError, setVersionsError] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [cron, setCron] = React.useState(agent.schedule?.cron ?? "");
  const [timezone, setTimezone] = React.useState(agent.schedule?.timezone ?? "");
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  // Versions are loaded when the panel mounts (it only renders when the
  // agent is expanded). The fetch lives in an async continuation so no
  // setState runs synchronously in the effect body (react-hooks rule).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/agents/${agent._id}/versions`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to load versions.");
        const data = (await res.json()) as VersionRow[];
        if (!cancelled) setVersions(data);
      } catch (err) {
        if (!cancelled) {
          setVersionsError(err instanceof Error ? err.message : "Failed to load versions.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent._id]);

  const loadVersions = async () => {
    setVersionsError(null);
    try {
      const res = await fetch(`/api/agents/${agent._id}/versions`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load versions.");
      setVersions((await res.json()) as VersionRow[]);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : "Failed to load versions.");
    }
  };

  const handleRestore = async (version: number | string) => {
    if (!confirm(`Restore version ${version}? The current draft becomes a new version, so nothing is lost.`)) return;
    setRestoring(String(version));
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/${agent._id}/versions/${version}/restore`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restore failed.");
      onAgentUpdated(data as AgentRow);
      setMessage(`Restored version ${version}. The agent now runs that workflow.`);
      await loadVersions();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Restore failed.");
    } finally {
      setRestoring(null);
    }
  };

  const handleSaveSchedule = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/${agent._id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule: cron.trim()
            ? { cron: cron.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) }
            : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save the schedule.");
      onAgentUpdated(data as AgentRow);
      setMessage(cron.trim() ? `Schedule saved: ${cron.trim()}.` : "Schedule cleared.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save the schedule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 border-t border-[var(--border)] pt-4 space-y-5">
      {message && (
        <p className="text-xs text-[var(--text)]" role="status">{message}</p>
      )}

      {/* Schedule (H23) */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-[var(--accent)]" />
          Schedule
          {agent.schedule?.cron && (
            <span className="font-normal text-[var(--muted)]">
              — currently <span className="font-mono">{agent.schedule.cron}</span>
              {agent.schedule.timezone ? ` (${agent.schedule.timezone})` : ""}
            </span>
          )}
        </h4>
        <p className="text-[11px] text-[var(--muted)]">
          A cron timetable for this agent — the scheduled checker runs it when
          the time comes. Leave the cron empty to clear the schedule.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-[var(--muted)]" htmlFor={`cron-${agent._id}`}>
            Cron
          </label>
          <input
            id={`cron-${agent._id}`}
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="* * * * *"
            className="input font-mono text-xs w-40"
            aria-label="Schedule cron expression"
          />
          <label className="text-[11px] text-[var(--muted)]" htmlFor={`tz-${agent._id}`}>
            Timezone
          </label>
          <input
            id={`tz-${agent._id}`}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Asia/Karachi"
            className="input text-xs w-36"
            aria-label="Schedule timezone"
          />
          <button onClick={handleSaveSchedule} disabled={saving} className="btn btn-secondary">
            {saving ? <Loader2 className="icon-xs animate-spin" /> : <Save className="icon-xs mr-1" />}
            Save schedule
          </button>
        </div>
      </div>

      {/* Versions (H22) */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
          <History className="h-3.5 w-3.5 text-[var(--accent)]" />
          Versions
        </h4>
        {versionsError && (
          <p className="text-xs text-[var(--danger)]" role="alert">{versionsError}</p>
        )}
        {!versions && !versionsError && (
          <p className="text-xs text-[var(--muted)] flex items-center gap-2">
            <Loader2 className="icon-xs animate-spin" /> Loading versions…
          </p>
        )}
        {versions && versions.length === 0 && (
          <p className="text-xs text-[var(--muted)]">No versions saved yet.</p>
        )}
        {versions && versions.length > 0 && (
          <ul className="space-y-1">
            {versions.map((v) => (
              <li key={v._id} className="flex items-center gap-3 flex-wrap text-xs">
                <span className="font-mono font-semibold text-[var(--text)]">v{v.version}</span>
                <span className="text-[var(--muted)]">{formatDate(v.createdAt)}</span>
                {v.notes && <span className="text-[var(--muted)]">{v.notes}</span>}
                <button
                  onClick={() => handleRestore(v.version)}
                  disabled={restoring === String(v.version)}
                  className="btn btn-ghost"
                  title={`Restore version ${v.version}`}
                >
                  {restoring === String(v.version) ? (
                    <Loader2 className="icon-xs animate-spin" />
                  ) : (
                    <RotateCcw className="icon-xs mr-1" />
                  )}
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = React.useState<AgentRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  // H22/H23: which agent's Versions & schedule panel is open.
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const handleAgentUpdated = React.useCallback((updated: AgentRow) => {
    setAgents((prev) => prev.map((a) => (a._id === updated._id ? { ...a, ...updated } : a)));
  }, []);

  // ── Fetch agents ────────────────────────────────────────────────────────
  React.useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/agents", {
          credentials: 'include',
        });
        if (!res.ok) throw new Error("Failed to load agents.");
        const data = await res.json();
        setAgents(data as AgentRow[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // ── Delete agent ────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm("Delete this agent? This cannot be undone.")) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: "DELETE",
        credentials: 'include',
      });
      if (!res.ok) throw new Error("Delete failed.");
      setAgents((prev) => prev.filter((a) => a._id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete.");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left">
        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-h1 font-bold text-[var(--text)] flex items-center gap-2">
              <Cpu className="icon-lg text-[var(--accent)]" />
              My Agents
            </h2>
            <p className="text-xs text-[var(--muted)]">
              These are your helpers. Pick one to open it and change how it works,
              or make a new one.
            </p>
          </div>
          <Link href="/dashboard/agents/create" className="btn btn-primary shrink-0">
            <Plus className="icon-xs mr-1.5" />
            Make an agent
          </Link>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20 gap-3">
            <Loader2 className="icon-lg text-[var(--accent)] animate-spin" />
            <span className="text-xs text-[var(--muted)]">Loading agents…</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="notice notice-danger" role="alert">
            <span className="flex items-center gap-2">
              <AlertTriangle className="icon-sm shrink-0" />
              {error}
            </span>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && agents.length === 0 && <EmptyState />}

        {/* Agents list — ruled rows, not cards */}
        {!loading && !error && agents.length > 0 && (
          <>
            {/* Summary line */}
            <p className="text-xs text-[var(--muted)]">
              {agents.length} agent{agents.length !== 1 ? "s" : ""}
              {" · "}
              {agents.filter((a) => a.status === "active").length} Running
              {" · "}
              {agents.filter((a) => a.status !== "active").length} Draft
            </p>

            <div>
              {agents.map((agent) => {
                const nodeCount = agent.workflow?.nodes?.length ?? 0;
                const providerLabel = PROVIDER_LABELS[agent.llmProvider ?? ""] ?? agent.llmProvider ?? "—";

                return (
                  <article key={agent._id} className="ruled-row">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1 flex-1 min-w-0">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-sm font-semibold text-[var(--text)] truncate">
                            {agent.name}
                          </span>
                          <span className="status-line">
                            <span className={`lamp ${agent.status === "active" ? "lamp-ok" : "lamp-soon"}`} />
                            {agent.status === "active" ? "Running" : "Draft"}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--muted)] line-clamp-2">
                          {agent.description || agent.prompt?.slice(0, 80) || "No description"}
                        </p>
                        <div className="flex items-center gap-4 flex-wrap text-[11px] text-[var(--muted)]">
                          <span className="flex items-center gap-1">
                            <Layers className="h-3 w-3" />
                            {nodeCount} step{nodeCount !== 1 ? "s" : ""}
                          </span>
                          {agent.role && (
                            <span className="flex items-center gap-1">
                              <Shield className="h-3 w-3 text-[var(--accent)]" />
                              {agent.role}
                            </span>
                          )}
                          {agent.llmProvider && (
                            <span className="flex items-center gap-1">
                              <Cpu className="h-3 w-3" />
                              {providerLabel}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDate(agent.createdAt)}
                          </span>
                        </div>

                        {/* Capabilities */}
                        {agent.capabilities && agent.capabilities.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {agent.capabilities.map((cap: { name: string; description?: string }) => (
                              <span
                                key={cap.name}
                                className="text-[11px] border border-[var(--border)] rounded-[2px] px-1.5 py-0.5 text-[var(--muted)]"
                              >
                                {cap.name}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Tags */}
                        {agent.tags && agent.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {agent.tags.map((tag) => (
                              <span
                                key={tag}
                                className="text-[11px] font-mono border border-[var(--border)] rounded-[2px] px-1.5 py-0.5 text-[var(--muted)]"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 shrink-0 flex-wrap">
                        <button
                          onClick={() => setExpanded(expanded === agent._id ? null : agent._id)}
                          className="btn btn-secondary"
                          aria-expanded={expanded === agent._id}
                          title="Versions and schedule"
                        >
                          <History className="icon-xs mr-1" />
                          Versions & schedule
                        </button>
                        <Link
                          href={`/workflow-builder?agentId=${agent._id}&agentName=${encodeURIComponent(agent.name)}`}
                          className="btn btn-secondary"
                        >
                          <ArrowUpRight className="icon-xs mr-1" />
                          Open and edit
                        </Link>
                        <Link
                          href={`/testing-sandbox?agentId=${agent._id}&name=${encodeURIComponent(agent.name)}`}
                          className="btn btn-ghost"
                          title="Try it out"
                          aria-label="Try it out"
                        >
                          <Play className="icon-xs" />
                        </Link>
                        <button
                          onClick={() => handleDelete(agent._id)}
                          disabled={deleting === agent._id}
                          className="btn btn-ghost text-[var(--danger)]"
                          title="Delete agent"
                          aria-label="Delete agent"
                        >
                          {deleting === agent._id ? (
                            <Loader2 className="icon-xs animate-spin" />
                          ) : (
                            <Trash2 className="icon-xs" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Versions & schedule panel (H22 + H23) */}
                    {expanded === agent._id && (
                      <AgentDetails agent={agent} onAgentUpdated={handleAgentUpdated} />
                    )}
                  </article>
                );
              })}

              {/* Quick-create row */}
              <Link href="/dashboard/agents/create" className="ruled-row flex items-center gap-3 hover:bg-[var(--row-hover)]">
                <Plus className="icon-sm text-[var(--accent)] shrink-0" />
                <span className="text-sm font-semibold text-[var(--text)]">New Agent</span>
                <span className="text-xs text-[var(--muted)]">Describe what you want in plain words</span>
                <ChevronRight className="icon-xs text-[var(--muted)] ml-auto shrink-0" />
              </Link>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
