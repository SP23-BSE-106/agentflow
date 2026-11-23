"use client";

import * as React from "react";
import Link from "next/link";
import {
  Play, Loader2, ListOrdered, BrainCircuit, Zap, RefreshCw, Square,
  Users, Check, X, Pencil,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardTitle, CardDescription } from "@/components/ui/Card";
import { TeamConversation } from "@/components/runs/TeamConversation";
import { distinctAgentIds } from "@/lib/teamConversation";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/Table";
import { Modal } from "@/components/ui/Modal";

type Agent = {
  _id: string;
  name: string;
  role?: string;
  status?: string;
  capabilities?: Array<{ name: string; description?: string }>;
};

type OrchestrationTask = {
  _id?: string;
  id?: string;
  title: string;
  agentId?: string;
  status: string;
  durationMs?: number;
  error?: string;
};

type OrchestrationMessage = {
  _id?: string;
  id?: string;
  type: string;
  fromAgentId?: string;
  toAgentId?: string;
  text?: string;
  payload?: unknown;
  createdAt: string | Date;
};

type OrchestrationEvent = {
  _id?: string;
  type: string;
  agentId?: string;
  payload?: unknown;
  createdAt: string | Date;
};

type OrchestrationResult = {
  runId: string;
  status: string;
  output?: unknown;
  tasksCompleted: number;
  tasksFailed: number;
  messagesCreated: number;
  durationMs: number;
  tasks?: OrchestrationTask[];
  messages?: OrchestrationMessage[];
  events?: OrchestrationEvent[];
};

type Mode = "sequential" | "parallel" | "supervisor";

const MODES: Array<{ id: Mode; label: string; description: string; icon: React.FC<{ className?: string }> }> = [
  { id: "sequential", label: "One after another", description: "Helpers take turns, in order.", icon: ListOrdered },
  { id: "parallel", label: "At the same time", description: "Helpers work side by side.", icon: Zap },
  { id: "supervisor", label: "Let AI plan it", description: "AI splits your request into jobs and hands them out.", icon: BrainCircuit },
];

/** Lamp for a run/task status. Completed is good standing (teal),
 *  failed is denied (red), running is work in progress (dev blue),
 *  waiting/retrying/paused await action (amber), pending is queued (grey). */
function statusLamp(status: string): string {
  switch (status) {
    case "completed": return "lamp-ok";
    case "failed": return "lamp-danger";
    case "running": return "lamp-dev";
    case "pending": return "lamp-soon";
    case "waiting": return "lamp-paused";
    case "retrying": return "lamp-paused";
    case "paused": return "lamp-paused";
    default: return "lamp-soon";
  }
}

function statusWord(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function OrchestratePage() {
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = React.useState(true);

  const [input, setInput] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("sequential");
  const [isRunning, setIsRunning] = React.useState(false);
  const [runResult, setRunResult] = React.useState<OrchestrationResult | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [approvalModal, setApprovalModal] = React.useState<{ approvalId: string; runId: string; title: string; description: string; payload?: unknown } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/agents", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!cancelled) setAgents(Array.isArray(data) ? data : []);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoadingAgents(false); });
    return () => { cancelled = true; };
  }, []);

  const handleRun = async () => {
    if (!input.trim()) return;
    const agentId = agents[0]?._id || "";
    if (!agentId) {
      setRunError("No agents available. Create one first.");
      return;
    }
    setIsRunning(true);
    setRunError(null);
    setRunResult(null);

    try {
      const res = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ agentId, input, mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunError(data.error || "Running them together failed.");
        return;
      }
      setRunResult(data);
      setPolling(true);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to run workflow.");
    } finally {
      setIsRunning(false);
    }
  };

  React.useEffect(() => {
    if (!polling || !runResult?.runId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${runResult.runId}/events`, {
          credentials: "include",
        });
        if (res.ok) {
          const events = await res.json();
          setRunResult((prev: OrchestrationResult | null) => (prev ? { ...prev, events } : prev));
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [polling, runResult?.runId]);

  // Deep link: /dashboard/orchestrate?runId=<id> opens an existing run
  // (a past or seeded run) instead of only showing the run just started
  // on this page. The conversation panel below then polls its messages
  // live. Read in an effect so no Suspense boundary is needed.
  React.useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("runId");
    if (!runId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { credentials: "include" });
        if (!res.ok || cancelled) return;
        const run = await res.json();
        const tasks: OrchestrationTask[] = Array.isArray(run.tasks) ? run.tasks : [];
        const messages: OrchestrationMessage[] = Array.isArray(run.messages) ? run.messages : [];
        const started = run.startedAt ? new Date(run.startedAt).getTime() : 0;
        const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : 0;
        setRunResult({
          runId: run.id,
          status: run.status,
          output: run.output,
          tasksCompleted: tasks.filter((t) => t.status === "completed").length,
          tasksFailed: tasks.filter((t) => t.status === "failed").length,
          messagesCreated: messages.length,
          durationMs: finished && started ? finished - started : 0,
          tasks,
          messages,
          events: [],
        });
        if (["running", "paused", "queued"].includes(run.status)) setPolling(true);
      } catch {
        /* unknown run id — the page stays on its empty state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleApproval = async (action: "approve" | "reject" | "edit", editedPayload?: unknown) => {
    if (!approvalModal) return;
    const { approvalId } = approvalModal;
    const endpoint = action === "edit"
      ? `/api/approvals/${approvalId}/edit`
      : `/api/approvals/${approvalId}/${action}`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          response: action === "edit" ? "Edited by user" : "",
          respondedBy: "user",
          ...(action === "edit" ? { editedPayload } : {}),
        }),
      });
      if (res.ok) {
        setApprovalModal(null);
        if (runResult?.runId) {
          const runRes = await fetch(`/api/runs/${runResult.runId}`, { credentials: "include" });
          if (runRes.ok) {
            const runData = await runRes.json();
            setRunResult((prev: OrchestrationResult | null) => (prev ? { ...prev, ...runData } : prev));
          }
        }
      } else {
        alert("Failed to process approval.");
      }
    } catch {
      alert("Approval failed.");
    }
  };

  if (loadingAgents) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20 gap-3">
          <Loader2 className="icon-lg animate-spin text-[var(--accent)]" />
          <span className="text-xs text-[var(--muted)]">Loading your helpers…</span>
        </div>
      </DashboardLayout>
    );
  }

  // Show a helper's name wherever the run record only kept its id.
  const agentNameById = (id?: string) =>
    !id ? "System" : agents.find((a) => a._id === id)?.name ?? "Another helper";

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-h1 font-bold text-[var(--text)] flex items-center gap-2">
              <Users className="icon-lg text-[var(--accent)]" />
              Run helpers together
            </h2>
            <p className="text-xs text-muted">
              Ask several helpers to work on one request together. Pick how they share the work below.
            </p>
          </div>
          <Link href="/dashboard/agents">
            <Button variant="secondary" size="sm">
              Manage agents
            </Button>
          </Link>
        </div>

        {runError && <div className="notice notice-danger" role="alert">{runError}</div>}

        <Card className="p-6">
          <div className="space-y-5">
            <div className="space-y-1">
              <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                Run them together
              </CardTitle>
              <CardDescription className="text-[10px]">
                Pick a helper, say what you want done, and choose how they work together.
              </CardDescription>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Agent
                </label>
                <select
                  className="select w-full text-xs"
                  value={agents[0]?._id || ""}
                  disabled
                >
                  {agents.map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.name} ({a.role || "general"})
                    </option>
                  ))}
                </select>
                {agents.length === 0 && (
                  <p className="text-[10px] text-[var(--danger)]">No agents found. Create one first.</p>
                )}
              </div>

              <div className="space-y-2 lg:col-span-2">
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Your Request
                </label>
                <Textarea
                  placeholder="e.g., Review this company policy and identify compliance risks."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  rows={3}
                  className="text-xs"
                  disabled={isRunning}
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  How they work together
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMode(m.id)}
                      className={
                        mode === m.id
                          ? "flex flex-col items-center gap-1.5 p-2.5 rounded-[2px] border border-[var(--accent)] bg-[var(--surface)] text-[var(--accent)] text-xs transition-colors"
                          : "flex flex-col items-center gap-1.5 p-2.5 rounded-[2px] border border-[var(--border)] text-muted text-xs hover:border-[var(--border-strong)] transition-colors"
                      }
                    >
                      <m.icon className="h-4 w-4" />
                      <span className="font-semibold">{m.label}</span>
                      <span className="text-[9px] opacity-70">{m.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-end">
                <Button
                  onClick={handleRun}
                  isLoading={isRunning}
                  disabled={isRunning || !agents.length || !input.trim()}
                  className="w-full"
                >
                  {isRunning ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="icon-sm animate-spin" />
                      Running…
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Play className="icon-sm mr-2" />
                      Run them together
                    </span>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {runResult && (
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 border-y border-[var(--border)]">
              <div className="px-4 py-3 first:pl-0">
                <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Status</div>
                <span className="status-line">
                  <span className={`lamp ${statusLamp(runResult.status)}`} />
                  {statusWord(runResult.status)}
                </span>
              </div>
              {[
                { label: "Jobs done", value: runResult.tasksCompleted },
                { label: "Jobs failed", value: runResult.tasksFailed },
                { label: "Messages", value: runResult.messagesCreated },
                { label: "Time taken", value: `${runResult.durationMs} ms` },
              ].map((stat) => (
                <div key={stat.label} className="px-4 py-3 first:pl-0">
                  <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1">
                    {stat.label}
                  </div>
                  <div className="font-mono text-lg font-semibold tabular-nums text-[var(--text)]">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>

            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <CardTitle className="text-xs font-bold text-[var(--text)] uppercase tracking-wider">
                  Final answer
                </CardTitle>
                <span className="status-line">
                  <span className={`lamp ${statusLamp(runResult.status)}`} />
                  {statusWord(runResult.status)}
                </span>
              </div>
              <div className="rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] p-4 text-[11px] font-mono text-[var(--text)] overflow-x-auto">
                {typeof runResult.output === "string"
                  ? runResult.output
                  : JSON.stringify(runResult.output, null, 2)}
              </div>
            </Card>

            {(runResult.tasks?.length ?? 0) > 0 && (
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <CardTitle className="text-xs font-bold text-[var(--text)] uppercase tracking-wider">
                    Jobs
                  </CardTitle>
                  <span className="font-mono text-xs text-muted">{runResult.tasks?.length ?? 0}</span>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job</TableHead>
                        <TableHead>Helper</TableHead>
                        <TableHead className="text-center">Status</TableHead>
                        <TableHead className="text-right">Time taken</TableHead>
                        <TableHead>What went wrong</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(runResult.tasks || []).map((task: OrchestrationTask) => (
                        <TableRow key={task._id || task.id}>
                          <TableCell className="text-[11px] font-medium text-foreground">
                            {task.title}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted">{agentNameById(task.agentId)}</TableCell>
                          <TableCell className="text-center text-[11px]">
                            <span className="status-line">
                              <span className={`lamp ${statusLamp(task.status)}`} />
                              {statusWord(task.status)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted">
                            {task.durationMs ? `${task.durationMs}ms` : "—"}
                          </TableCell>
                          <TableCell className="text-[11px] text-[var(--danger)] max-w-[200px] truncate">
                            {task.error || "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            )}

            {/* Team conversation, live: polls /api/runs/:runId/messages
                every 2s while the run is live. Shown only when the run is
                a team run (more than one helper involved) or already has
                messages — a single-agent run with no messages shows no
                team UI at all. */}
            {distinctAgentIds(
              runResult.messages ?? [],
              (runResult.tasks ?? []).map((t) => t.agentId),
            ).length > 1 || (runResult.messages?.length ?? 0) > 0 ? (
              <TeamConversation
                runId={runResult.runId}
                runStatus={runResult.status}
                agents={agents}
                initialMessages={runResult.messages ?? []}
              />
            ) : null}

            {(runResult.events?.length ?? 0) > 0 && (
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Timeline
                  </CardTitle>
                  <Button size="sm" onClick={() => setPolling(!polling)}>
                    {polling ? (
                      <span className="flex items-center gap-2">
                        <Square className="icon-xs mr-1.5" />
                        Stop watching
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <RefreshCw className="icon-xs mr-1.5" />
                        Watch live
                      </span>
                    )}
                  </Button>
                </div>
                <div className="border-t border-[var(--border)] max-h-[400px] overflow-y-auto">
                  {(runResult.events || []).map((evt: OrchestrationEvent) => (
                    <div
                      key={evt._id || evt.type + evt.createdAt}
                      className="ruled-row flex items-start gap-3 py-2"
                    >
                      <span className="font-mono text-[10px] text-muted mt-0.5 shrink-0">
                        {new Date(evt.createdAt).toLocaleTimeString()}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-semibold text-[var(--text)] truncate">{evt.type}</span>
                          {evt.agentId && (
                            <span className="font-mono text-[10px] text-muted">
                              {agentNameById(evt.agentId)}
                            </span>
                          )}
                        </div>
                        {!!evt.payload && (
                          <div className="text-[10px] text-muted mt-1 leading-relaxed">
                            {typeof evt.payload === "string"
                              ? (evt.payload as string)
                              : JSON.stringify(evt.payload as Record<string, unknown>)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(runResult.status === "paused") && (
              <div className="mt-4">
                <Button onClick={() => {
                  setApprovalModal({
                    approvalId: runResult.runId,
                    runId: runResult.runId,
                    title: "Waiting for approval",
                    description: "The run is waiting for your approval to continue.",
                    payload: runResult.output,
                  });
                }}
                className="flex-1"
              >
                Review what&apos;s waiting
                </Button>
              </div>
            )}
          </div>
        )}

        {!runResult && (
          <div className="border-y border-[var(--border)] py-8 text-center">
            <h3 className="font-bold text-[var(--text)] text-sm">No runs yet</h3>
            <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
              Make an agent, then run your helpers together here. You&apos;ll see each job, the messages between them, and the final answer.
            </p>
          </div>
        )}

        <Modal
          isOpen={!!approvalModal}
          onClose={() => setApprovalModal(null)}
          title={approvalModal?.title || "Approval Required"}
          description={approvalModal?.description}
          size="lg"
        >
          <div className="space-y-4">
            <div className="rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-xs text-[var(--text)]">
              {typeof approvalModal?.payload === "string"
                ? approvalModal.payload
                : JSON.stringify(approvalModal?.payload || {}, null, 2)}
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => handleApproval("approve")}
                className="flex-1"
              >
                <Check className="icon-xs mr-1.5" />
                Approve
              </Button>
              <Button
                onClick={() => handleApproval("reject")}
                variant="danger"
                className="flex-1"
              >
                <X className="icon-xs mr-1.5" />
                Reject
              </Button>
              <Button
                onClick={() => handleApproval("edit", approvalModal?.payload)}
                variant="secondary"
                className="flex-1"
              >
                <Pencil className="icon-xs mr-1.5" />
                Edit and approve
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </DashboardLayout>
  );
}
