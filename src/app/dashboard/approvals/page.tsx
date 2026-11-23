"use client";

import * as React from "react";
import { RefreshCw, Loader2, ClipboardCheck, Square, Check, X, Pencil, ChevronRight } from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/Table";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Textarea";

type Approval = {
  _id: string;
  userId: string;
  workflowRunId: string;
  taskId: string;
  requestedByAgentId: string;
  title: string;
  description: string;
  payload?: Record<string, unknown> | null;
  status: "pending" | "approved" | "rejected" | "edited" | "expired";
  response?: string;
  respondedBy?: string;
  createdAt: string | Date;
  respondedAt?: string | Date;
};

/** Lamp for an approval status. Pending/edited await action (amber),
 *  approved is good standing (teal), rejected is denied (red), expired is
 *  closed (grey). The word carries the meaning; the dot is the glance. */
function statusLamp(status: string): string {
  switch (status) {
    case "pending": return "lamp-paused";
    case "approved": return "lamp-ok";
    case "rejected": return "lamp-danger";
    case "edited": return "lamp-paused";
    case "expired": return "lamp-retired";
    default: return "lamp-soon";
  }
}

function statusWord(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [selectedApproval, setSelectedApproval] = React.useState<Approval | null>(null);
  const [editResponse, setEditResponse] = React.useState("");

  // ── Load pending approvals ─────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/approvals", {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to load approvals.");
        const data = await res.json();
        if (!cancelled) setApprovals(Array.isArray(data) ? data : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Poll for new approvals ─────────────────────────────────────────────
  React.useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/approvals", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setApprovals(Array.isArray(data) ? data : []);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [polling]);

  // ── Approve / reject / edit ────────────────────────────────────────────
  const handleDecision = async (action: "approve" | "reject" | "edit") => {
    if (!selectedApproval) return;
    const { _id: approvalId } = selectedApproval;

    const endpoint = action === "edit"
      ? `/api/approvals/${approvalId}/edit`
      : `/api/approvals/${approvalId}/${action}`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          response: action === "edit" ? editResponse : "",
          respondedBy: "user",
          ...(action === "edit" ? { editedPayload: selectedApproval.payload } : {}),
        }),
      });

      if (res.ok) {
        setSelectedApproval(null);
        setEditResponse("");
        // Refresh list
        const res2 = await fetch("/api/approvals", { credentials: "include" });
        if (res2.ok) {
          const data = await res2.json();
          setApprovals(Array.isArray(data) ? data : []);
        }
      } else {
        alert("Failed to process approval.");
      }
    } catch {
      alert("Approval failed.");
    }
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20 gap-3">
          <Loader2 className="icon-lg animate-spin text-[var(--accent)]" />
          <span className="text-xs text-[var(--muted)]">Loading approvals…</span>
        </div>
      </DashboardLayout>
    );
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-h1 font-bold text-[var(--text)] flex items-center gap-2">
              <ClipboardCheck className="icon-lg text-[var(--accent)]" />
              Approvals
            </h2>
            <p className="text-xs text-muted">
              Sometimes an agent stops and asks you to check something before it goes on. Look it over here, then say yes, no, or change it first.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setPolling(!polling)}
          >
            {polling ? (
              <>
                <Square className="icon-xs mr-1.5" />
                Stop watching
              </>
            ) : (
              <>
                <RefreshCw className="icon-xs mr-1.5" />
                Watch for new ones
              </>
            )}
          </Button>
        </div>

        {/* Error */}
        {error && <div className="notice notice-danger" role="alert">{error}</div>}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 border-y border-[var(--border)]">
          {[
            { label: "Pending", value: pending.length },
            { label: "Approved", value: decided.filter((a) => a.status === "approved").length },
            { label: "Rejected", value: decided.filter((a) => a.status === "rejected").length },
            { label: "Total", value: approvals.length },
          ].map((stat) => (
            <div key={stat.label} className="px-4 py-3 first:pl-0">
              <div className="text-[10px] font-bold text-muted uppercase tracking-wider">{stat.label}</div>
              <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-[var(--text)]">{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Empty state */}
        {approvals.length === 0 && (
          <div className="border-y border-[var(--border)] py-8 text-center">
            <h3 className="font-bold text-[var(--text)] text-sm">No approval requests</h3>
            <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
              When an agent stops to ask you something, the request will appear here.
            </p>
          </div>
        )}

        {/* Pending approvals */}
        {pending.length > 0 && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <CardTitle className="text-xs font-bold text-[var(--text)] uppercase tracking-wider">
                Waiting for you
              </CardTitle>
              <span className="font-mono text-xs text-muted">{pending.length} awaiting decision</span>
            </div>
            <div className="space-y-4">
              {pending.map((approval) => (
                <ApprovalCard
                  key={approval._id}
                  approval={approval}
                  onSelect={setSelectedApproval}
                />
              ))}
            </div>
          </Card>
        )}

        {/* History */}
        {decided.length > 0 && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <CardTitle className="text-xs font-bold text-[var(--text)] uppercase tracking-wider">
                Past decisions
              </CardTitle>
              <span className="font-mono text-xs text-muted">{decided.length}</span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead className="text-center">Decision</TableHead>
                    <TableHead className="text-right">Responded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {decided.map((approval) => (
                    <TableRow key={approval._id}>
                      <TableCell className="text-[11px] font-medium text-foreground">
                        {approval.title}
                      </TableCell>
                      <TableCell className="text-center text-[11px]">
                        <span className="status-line">
                          <span className={`lamp ${statusLamp(approval.status)}`} />
                          {statusWord(approval.status)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-muted">
                        {approval.respondedAt ? new Date(approval.respondedAt).toLocaleString() : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </div>

      {/* Approval Action Modal */}
      <Modal
        isOpen={!!selectedApproval}
        onClose={() => setSelectedApproval(null)}
        title={selectedApproval?.title || "Approval Required"}
        description={selectedApproval?.description}
        size="lg"
      >
        <div className="space-y-5">
          {/* Payload preview */}
          <div className="rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] p-4 font-mono text-xs text-[var(--text)] overflow-x-auto">
            {typeof selectedApproval?.payload === "string"
              ? selectedApproval.payload
              : JSON.stringify(selectedApproval?.payload || {}, null, 2)}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <Button
              onClick={() => handleDecision("approve")}
              className="flex-1"
            >
              <Check className="icon-xs mr-1.5" />
              Approve
            </Button>
            <Button
              onClick={() => handleDecision("reject")}
              variant="danger"
              className="flex-1"
            >
              <X className="icon-xs mr-1.5" />
              Reject
            </Button>
          </div>

          {/* Edit option */}
          <div className="border-t border-border/40 pt-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-semibold text-muted">Edit and approve</span>
              <Textarea
                value={editResponse}
                onChange={(e) => setEditResponse(e.target.value)}
                placeholder="Add your notes or modifications…"
                rows={2}
                className="text-[10px] flex-1"
              />
            </div>
            <Button
              onClick={() => handleDecision("edit")}
              variant="secondary"
              className="w-full"
            >
              <Pencil className="icon-xs mr-1.5" />
              Submit edited output
            </Button>
          </div>
        </div>
      </Modal>
    </DashboardLayout>
  );
}


function ApprovalCard({ approval, onSelect }: { approval: Approval; onSelect: (a: Approval) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(approval)}
      className="ruled-row flex w-full items-center justify-between gap-3 py-3 text-left cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-[var(--text)]">
            {approval.title}
          </span>
          <span className="font-mono text-[10px] text-muted">
            {new Date(approval.createdAt).toLocaleString()}
          </span>
        </div>
        <div className="text-xs text-[var(--text)] leading-relaxed line-clamp-2">
          {approval.description}
        </div>
      </div>
      <span className="status-line shrink-0">
        <span className={`lamp ${statusLamp(approval.status)}`} />
        {statusWord(approval.status)}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-xs font-semibold text-[var(--accent)]">
        Review
        <ChevronRight className="icon-xs" />
      </span>
    </button>
  );
}
