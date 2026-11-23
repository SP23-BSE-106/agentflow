"use client";

import * as React from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  distinctAgentIds,
  extractTurnText,
  formatMessageTime,
  isAwaitingReply,
  isLiveRunStatus,
  isSystemMessage,
  messageId,
  type TeamMessage,
} from "@/lib/teamConversation";

/** Poll interval while the run is live. Polling stops as soon as the run
 *  reaches a terminal status — a finished run is never polled forever. */
const POLL_MS = 2000;
/** The run's own status is re-checked on this slower cadence so a run
 *  that finishes while the view is open stops the message poll. (Reads
 *  are rate-limited at 60/min/IP: 30 message polls + 6 status checks
 *  per minute stays under it.) */
const STATUS_CHECK_MS = 10000;

export type TeamAgent = {
  _id: string;
  name: string;
  role?: string;
};

type TeamConversationProps = {
  runId: string;
  /** Status known by the caller. When omitted (testing sandbox), the
   *  component reads it from GET /api/runs/:runId itself. Either way the
   *  component re-checks the run status while polling, so a run that
   *  finishes mid-view stops the poll. */
  runStatus?: string;
  /** Agents for name + role labels. When omitted, the component loads
   *  them itself from /api/agents (best effort — unknown ids fall back
   *  to "Another helper", never a blank label). */
  agents?: TeamAgent[];
  /** Messages already known (e.g. the orchestrate response snapshot).
   *  The live poll refreshes from the API regardless. */
  initialMessages?: TeamMessage[];
};

/** "Researcher (researcher)" — name + role, the label the contract
 *  requires on every message. */
function agentLabel(agent: TeamAgent | undefined, fallback: string): string {
  if (!agent) return fallback;
  return `${agent.name} (${agent.role || "general"})`;
}

export function TeamConversation({ runId, runStatus: runStatusProp, agents: agentsProp, initialMessages }: TeamConversationProps) {
  // Agents supplied by the caller win; otherwise the component loads
  // them itself for name/role labels. Derived, never synced in an
  // effect — the set-state-in-effect rule forbids the sync.
  const [fetchedAgents, setFetchedAgents] = React.useState<TeamAgent[]>([]);
  const agents = agentsProp ?? fetchedAgents;
  const [messages, setMessages] = React.useState<TeamMessage[]>(initialMessages ?? []);
  const [loading, setLoading] = React.useState(!initialMessages);
  const [error, setError] = React.useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = React.useState<string | null>(null);
  // Status read back from the run itself. Starts from the caller's status
  // (or "running" when the caller has none) and is re-checked while live.
  const [liveStatus, setLiveStatus] = React.useState<string | null>(null);
  const effectiveStatus = liveStatus ?? runStatusProp ?? "running";

  // Keep the caller-supplied agents in step if they arrive late: they
  // are derived above (agentsProp ?? fetchedAgents), so no sync needed.

  // No agents supplied (testing sandbox): load them for name/role labels.
  React.useEffect(() => {
    if (agentsProp) return;
    let cancelled = false;
    fetch("/api/agents", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setFetchedAgents(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agentsProp]);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/messages`, { credentials: "include" });
      if (!res.ok) {
        setError(`Could not load the conversation (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      if (Array.isArray(data)) {
        setMessages(data);
        setError(null);
        setLastUpdated(new Date().toLocaleTimeString());
      }
    } catch {
      setError("Could not load the conversation — check your connection and refresh.");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Live while the run is live, still the moment it finishes. The
  // interval is created only for live statuses, so a finished run is
  // never polled. The run's own status is re-checked on a slower
  // cadence, because the caller's snapshot can go stale mid-run.
  // The first load runs in an async step (not synchronously in the
  // effect body) so the state writes happen in a callback, per the
  // set-state-in-effect rule — same pattern as the sandbox page.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/messages`, { credentials: "include" });
        if (cancelled) return;
        if (!res.ok) {
          setError(`Could not load the conversation (HTTP ${res.status}).`);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data)) {
          setMessages(data);
          setError(null);
          setLastUpdated(new Date().toLocaleTimeString());
        }
      } catch {
        if (!cancelled) setError("Could not load the conversation — check your connection and refresh.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    if (!isLiveRunStatus(effectiveStatus)) return () => { cancelled = true; };
    const interval = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refresh, effectiveStatus, runId]);

  React.useEffect(() => {
    if (!isLiveRunStatus(effectiveStatus)) return undefined;
    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { credentials: "include" });
        if (res.ok) {
          const run = await res.json();
          if (typeof run.status === "string") setLiveStatus(run.status);
        }
      } catch {
        /* status unknown — keep polling on the caller's status */
      }
    };
    void checkStatus();
    const interval = setInterval(() => {
      void checkStatus();
    }, STATUS_CHECK_MS);
    return () => clearInterval(interval);
  }, [runId, effectiveStatus]);

  const live = isLiveRunStatus(effectiveStatus);
  const agentById = (id?: string) => agents.find((a) => a._id === id);
  const teamSize = distinctAgentIds(messages).length;

  return (
    <Card className="p-5" data-testid="team-conversation">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <CardTitle className="text-xs font-bold text-[var(--text)] uppercase tracking-wider">
          Team conversation
        </CardTitle>
        <div className="flex items-center gap-3">
          <span className="status-line">
            <span className={`lamp ${live ? "lamp-dev" : "lamp-ok"}`} />
            {live ? "Live" : "Finished"}
          </span>
          <span className="font-mono text-xs text-muted" aria-live="polite">
            {messages.length} {messages.length === 1 ? "message" : "messages"}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className="icon-xs mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {loading && messages.length === 0 && (
        <p className="text-xs text-muted py-4">Loading the conversation…</p>
      )}

      {error && messages.length === 0 && !loading && (
        <div className="notice notice-danger" role="alert">{error}</div>
      )}

      {!loading && messages.length === 0 && !error && (
        <div className="border-y border-[var(--border)] py-8 text-center">
          <h3 className="font-bold text-[var(--text)] text-sm">No agent messages yet</h3>
          <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
            When helpers talk to each other during this run, their messages appear here in order.
          </p>
        </div>
      )}

      {messages.length > 0 && (
        <div className="border-t border-[var(--border)]">
          {messages.map((msg) => {
            const id = messageId(msg);
            const system = isSystemMessage(msg);
            const awaiting = isAwaitingReply(msg, messages);
            const sender = agentById(msg.fromAgentId);
            const recipient = msg.toAgentId ? agentById(msg.toAgentId) : undefined;
            const body = extractTurnText(msg);
            return (
              <div
                key={id || `${msg.fromAgentId}-${msg.createdAt}`}
                className={
                  system
                    ? "ruled-row py-3 text-xs border-l-2 border-[var(--accent)] bg-[var(--surface-2)] px-3"
                    : "ruled-row py-3 text-xs px-1"
                }
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1 font-mono min-w-0">
                  {system && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                      System
                    </span>
                  )}
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text)]">
                    {msg.type || "message"}
                  </span>
                  <span className="text-[11px] text-[var(--text)] break-words">
                    {agentLabel(sender, system ? "System" : "Another helper")}
                  </span>
                  {!system && (
                    <span className="flex items-center gap-1 text-[11px] text-[var(--accent)] min-w-0">
                      <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="break-words">
                        {msg.toAgentId ? agentLabel(recipient, "Another helper") : "Team"}
                      </span>
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-muted shrink-0">
                    {formatMessageTime(msg.createdAt)}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text)] leading-relaxed break-words">
                  {body || "—"}
                </div>
                {awaiting && (
                  <div className="status-line mt-2">
                    <span className="lamp lamp-paused" />
                    Awaiting reply
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-muted mt-4">
        {live
          ? "Updating every 2 seconds while the run is live."
          : "This run is finished — the conversation above is the complete record."}
        {lastUpdated ? ` Last updated ${lastUpdated}.` : ""}
        {teamSize > 1 ? ` ${teamSize} helpers in this conversation.` : ""}
      </p>
    </Card>
  );
}
