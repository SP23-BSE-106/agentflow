"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Send, RefreshCw, ArrowLeft, ChevronRight } from "lucide-react";
import { BuilderLayout } from "@/components/layout/BuilderLayout";
import { Button } from "@/components/ui/Button";
import { TeamConversation } from "@/components/runs/TeamConversation";
import { loadGuestWorkflow, type GuestWorkflow } from "@/lib/guestWorkflow";

/** Lamp for a trace line, read off the line's own mark: a failed step
 *  is an alarm (red), a passed step is good standing (teal), anything else
 *  (system notes, boot banner) is unmarked grey. Display only — the text
 *  itself is untouched. */
function traceLamp(text: string): string {
  if (text.includes("✗") || text.includes("[ERROR]")) return "lamp-danger";
  if (text.includes("✓")) return "lamp-ok";
  return "lamp-soon";
}

function TestingSandboxInner() {
  const searchParams = useSearchParams();
  const agentId = searchParams?.get("agentId");
  const agentName = searchParams?.get("name") || "Your agent";
  // A team conversation exists only for a persisted run. The sandbox
  // opens one when linked with ?runId=<id> (e.g. from a run view); a
  // plain sandbox run has no run id and shows no team UI.
  const runId = searchParams?.get("runId");

  const [input, setInput] = React.useState("");
  // Guest mode: no agentId and a workflow held in this browser (no account).
  // Loaded after mount so the first render matches the server render.
  const [guestWorkflow, setGuestWorkflow] = React.useState<GuestWorkflow | null>(null);
  const isGuestRun = !agentId && guestWorkflow !== null;
  const guestName = guestWorkflow?.name ?? "Your workflow";
  const displayName = agentId ? agentName : guestWorkflow ? guestName : agentName;
  const [chatHistory, setChatHistory] = React.useState([
    { role: "assistant", text: `Connected to ${displayName}. Send a message and I'll run it through your steps, showing each one as it goes.` }
  ]);
  // Initialize logs without timestamps to avoid hydration mismatch
  const [logs, setLogs] = React.useState<any[]>([]);
  const [isTyping, setIsTyping] = React.useState(false);
  // The model that actually answered, read back from the response. This panel
  // used to print "Kimi (HuggingFace Router)" unconditionally, including when
  // no provider answered at all.
  const [engine, setEngine] = React.useState<{ provider: string | null; model: string | null } | null>(null);
  const [recorded, setRecorded] = React.useState(0);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const lastQuestionRef = React.useRef<string | null>(null);
  const [kbStatus, setKbStatus] = React.useState<{ documents: number; chunks: number } | null>(null);
  // On small screens the trace is a tab, not a hidden panel: below `md` the
  // chat and the trace share the screen and the user picks which to see.
  const [mobileTab, setMobileTab] = React.useState<"chat" | "trace">("chat");
  const [kbUploadBusy, setKbUploadBusy] = React.useState(false);
  const [kbUploadMessage, setKbUploadMessage] = React.useState<string | null>(null);
  const [kbClearBusy, setKbClearBusy] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const refreshKbStatus = React.useCallback(async () => {
    try {
      const res = await fetch('/api/rag/status', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setKbStatus({
          documents: data.knowledge_base.documents,
          chunks: data.knowledge_base.chunks
        });
      }
    } catch (err) {
      console.warn('Failed to fetch KB status:', err);
    }
  }, []);

  const handleKbClear = async () => {
    if (!window.confirm('Delete ALL your files?')) return;
    setKbClearBusy(true);
    setKbUploadMessage(null);
    try {
      const res = await fetch('/api/rag/upload', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to clear knowledge base');
      await refreshKbStatus();
      setKbUploadMessage('✓ Your files are cleared — ready to add more');
      setTimeout(() => setKbUploadMessage(null), 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setKbUploadMessage(`✗ Clear failed: ${message}`);
    } finally {
      setKbClearBusy(false);
    }
  };

  const handleKbUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setKbUploadBusy(true);
    setKbUploadMessage(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', file.name);

      const res = await fetch('/api/rag/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include', // Send auth cookie
      });

      if (res.ok) {
        const data = await res.json();
        setKbUploadMessage(`✓ Added "${data.fileName}" (${data.totalChunks} pieces)`);
        // Refresh KB status
        await refreshKbStatus();
        setTimeout(() => setKbUploadMessage(null), 3000);
      } else {
        // Never default to "Unauthorized": a Vercel gateway/timeout page or a
        // 404 returns HTML, `res.json()` fails, and the old `|| 'Unauthorized'`
        // fallback blamed auth for what was really a 5xx.
        const raw = await res.text().catch(() => "");
        let errData: { error?: string } = {};
        try {
          errData = raw ? JSON.parse(raw) : {};
        } catch {
          /* non-JSON error page — fall through to the status line below */
        }

        if (res.status === 401) {
          setKbUploadMessage("✗ Session expired — log in again, then retry the upload.");
        } else if (errData.error) {
          setKbUploadMessage(`✗ Upload failed (${res.status}): ${errData.error}`);
        } else {
          const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 140);
          setKbUploadMessage(
            `✗ Upload failed — HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` +
              (snippet ? ` — ${snippet}` : ""),
          );
        }
      }
    } catch (err) {
      console.error('KB upload error:', err);
      setKbUploadMessage('✗ Connection error during upload');
    } finally {
      setKbUploadBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * The boot banner is derived rather than stored, so it follows `agentName`
   * without a state write inside an effect. Its timestamps are deliberately
   * blank: those lines predate the client clock and must match SSR output.
   */
  const bootLogs = React.useMemo(
    () => [
      {
        type: "sys",
        text: isGuestRun
          ? `Connected to ${displayName} — running the workflow saved in this browser. Your files are not available as a guest.`
          : `Connected to ${displayName} — answers come from your files and the AI, for real.`,
        time: "",
      },
      { type: "sys", text: "Ready. Send a message to try it out.", time: "" },
    ],
    [displayName, isGuestRun],
  );
  const visibleLogs = React.useMemo(() => [...bootLogs, ...logs], [bootLogs, logs]);

  // Guest workflow: read once from this browser. The greeting follows the
  // workflow's name once it is known. The read runs in an async step (not
  // synchronously in the effect body) so the state writes happen in a
  // callback, per the set-state-in-effect rule — behaviour is unchanged.
  React.useEffect(() => {
    if (agentId) return;
    let cancelled = false;
    (async () => {
      const found = loadGuestWorkflow();
      if (cancelled || !found) return;
      setGuestWorkflow(found);
      setChatHistory([
        { role: "assistant", text: `Connected to ${found.name}. Send a message and I'll run it through your steps, showing each one as it goes.` },
      ]);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Fetch knowledge base status — login-only, so guests never fetch it.
  React.useEffect(() => {
    if (isGuestRun) return;
    const fetchKbStatus = async () => {
      try {
        const res = await fetch('/api/rag/status', {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setKbStatus({
            documents: data.knowledge_base.documents,
            chunks: data.knowledge_base.chunks
          });
        }
      } catch (err) {
        console.warn('Failed to fetch KB status:', err);
      }
    };

    fetchKbStatus();
    // Refresh status every 5 seconds
    const interval = setInterval(fetchKbStatus, 5000);
    return () => clearInterval(interval);
  }, [isGuestRun]);

  /**
   * Every execution is written to the run history so Monitoring & Control has
   * real numbers to show. Fire-and-forget: a monitoring failure must never be
   * able to fail the test it is recording.
   *
   * H17: this is ONLY for runs the server does not record itself — the
   * /api/rag/chat turns below and saved sessions. Runs that go through
   * POST /api/execute are recorded once on the server (see runWorkflow),
   * so this page must not post them again or each run counts twice.
   */
  const recordRun = async (
    kind: "exec" | "session",
    payload: {
      input: string;
      output: string;
      status: "success" | "failed";
      durationMs?: number;
      sourceCount?: number;
      provider?: string | null;
      model?: string | null;
      error?: string | null;
    },
  ): Promise<boolean> => {
    try {
      const res = await fetch("/api/agents/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ kind, agentId, agentName, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) return false;
      setRecorded((count) => count + 1);
      return true;
    } catch {
      // Recording is best-effort; the run itself already happened.
      return false;
    }
  };

  const runQuestion = async (rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || isTyping) return;

    lastQuestionRef.current = question;
    setChatHistory((prev) => [...prev, { role: "user", text: question }]);
    setInput("");
    setIsTyping(true);

    const startedAt = Date.now();
    const stamp = () => new Date().toLocaleTimeString();

    // Trace lines are appended only after their step actually runs — the
    // old code logged Node 1/2 before the fetch started, so a failed run
    // still read as half-executed.
    if (agentId) {
      setEngine({ provider: 'Starting…', model: null })
      setLogs((prev) => [...prev, { type: 'sys', text: 'Starting…', time: stamp() }])
      try {
        const execRes = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, input: question, topK: 3 }),
          credentials: 'include',
        })
        const elapsedMs = Date.now() - startedAt
        const execData = await execRes.json().catch(() => ({}))
        if (!execRes.ok) {
          const providerFailures = Array.isArray(execData.failures)
            ? execData.failures
                .map((failure: any) => `${failure.provider}: ${failure.message || `HTTP ${failure.status || "error"}`}`)
                .join(" | ")
            : ""
          const reason = [execData.error || `HTTP ${execRes.status}`, providerFailures]
            .filter(Boolean)
            .join(" ")
          setIsTyping(false)
          setEngine(null)
          setChatHistory((prev) => [...prev, { role: 'assistant', text: `Error: ${reason}` }])
          setLogs((prev) => [...prev, { type: 'exec', text: `[Run] ✗ ${reason}`, time: stamp() }])
          // H17: no client-side record — POST /api/execute already wrote
          // the one `workflow_runs` row for this run on the server.
          return
        }
        const answer = execData.output || 'No answer was generated.'
        const provider = execData.provider ?? null
        const model = execData.model ?? null
        setEngine({ provider, model })
        setIsTyping(false)
        setChatHistory((prev) => [...prev, { role: 'assistant', text: answer }])
        const traceLogs = Array.isArray(execData.trace)
          ? execData.trace.map((step: any) => ({ type: 'exec', text: `[${step.name}] ${step.summary} (${step.durationMs ?? 0} ms)`, time: stamp() }))
          : []
        setLogs((prev) => [...prev, ...traceLogs])
        // H17: no client-side record — POST /api/execute already wrote the
        // one `workflow_runs` row for this run on the server, so the run is
        // already in past runs.
        setLogs((prev) => [...prev, { type: 'sys', text: `Saved in past runs (${elapsedMs} ms).`, time: stamp() }])
      } catch (err) {
        const elapsedMs = Date.now() - startedAt
        const reason = err instanceof Error ? err.message : 'network failure'
        setIsTyping(false)
        setEngine(null)
        setLogs((prev) => [...prev, { type: 'exec', text: `[ERROR] Network failure after ${elapsedMs} ms: ${reason}`, time: stamp() }])
        // H17: a failed fetch never reached the server, so no execution
        // happened and no row is recorded.
      }
      return
    }

    // Guest run: the workflow lives in this browser, not on an account.
    // It runs statelessly through POST /api/execute with the workflow
    // itself — nothing is saved, and the step-by-step record comes back
    // exactly like a signed-in run (trace included even on failure).
    if (guestWorkflow) {
      setEngine({ provider: 'Starting…', model: null })
      setLogs((prev) => [...prev, { type: 'sys', text: 'Starting…', time: stamp() }])
      try {
        const execRes = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow: guestWorkflow.workflow, input: question, topK: 3 }),
          credentials: 'include',
        })
        const elapsedMs = Date.now() - startedAt
        const execData = await execRes.json().catch(() => ({}))
        const traceLogs = Array.isArray(execData.trace)
          ? execData.trace.map((step: any) => ({ type: 'exec', text: `[${step.name}] ${step.summary} (${step.durationMs ?? 0} ms)`, time: stamp() }))
          : []
        const ragFailed = Array.isArray(execData.trace) && execData.trace.some((step: any) => step.type === 'rag' && step.ok === false)
        const guestNotes = [
          { type: 'sys', text: 'Guest runs are not saved — log in to keep past runs.', time: stamp() },
          ...(ragFailed
            ? [{ type: 'sys', text: 'Your files are not available as a guest — log in to add files and use the file-search step.', time: stamp() }]
            : []),
        ]
        if (!execRes.ok) {
          const reason = execData.error || `HTTP ${execRes.status}`
          setIsTyping(false)
          setEngine(null)
          setChatHistory((prev) => [...prev, { role: 'assistant', text: `Error: ${reason}` }])
          setLogs((prev) => [...prev, ...traceLogs, { type: 'exec', text: `[Run] ✗ ${reason}`, time: stamp() }, ...guestNotes])
          return
        }
        const answer = execData.output || 'No answer was generated.'
        const provider = execData.provider ?? null
        const model = execData.model ?? null
        setEngine({ provider, model })
        setIsTyping(false)
        setChatHistory((prev) => [...prev, { role: 'assistant', text: answer }])
        setLogs((prev) => [
          ...prev,
          ...traceLogs,
          { type: 'sys', text: `Finished in ${elapsedMs} ms.`, time: stamp() },
          ...guestNotes,
        ])
      } catch (err) {
        const elapsedMs = Date.now() - startedAt
        const reason = err instanceof Error ? err.message : 'network failure'
        setIsTyping(false)
        setEngine(null)
        setLogs((prev) => [...prev, { type: 'exec', text: `[ERROR] Network failure after ${elapsedMs} ms: ${reason}`, time: stamp() }])
      }
      return
    }

    setEngine({ provider: 'Looking in your files…', model: null })
    setLogs((prev) => [...prev, { type: 'sys', text: 'Looking in your files…', time: stamp() }])

    try {
      const chatRes = await fetch("/api/rag/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, topK: 3 }),
        credentials: "include",
      });

      const elapsedMs = Date.now() - startedAt;

      if (!chatRes.ok) {
        const errData = await chatRes.json().catch(() => ({}));
        const reason: string = errData.error || `HTTP ${chatRes.status}`;

        setIsTyping(false);
        setEngine(null);
        setChatHistory((prev) => [...prev, { role: "assistant", text: `Error: ${reason}` }]);
        setLogs((prev) => [
          ...prev,
          { type: "exec", text: `[Your files] ✗ ${reason}`, time: stamp() },
          { type: "sys", text: `Didn't finish — stopped after ${elapsedMs} ms.`, time: stamp() },
        ]);

        await recordRun("exec", {
          input: question,
          output: reason,
          status: "failed",
          durationMs: elapsedMs,
          error: reason,
        });
        return;
      }

      const chatData = await chatRes.json();
      const sources: Array<{ similarity?: number }> = Array.isArray(chatData.sources)
        ? chatData.sources
        : [];
      const provider: string | null = chatData.provider ?? null;
      const model: string | null = chatData.model ?? null;
      const answer: string = chatData.answer || "No answer was generated.";
      const engineLabel = model || provider || "not set yet";

      setEngine({ provider, model });
      setIsTyping(false);
      setChatHistory((prev) => [...prev, { role: "assistant", text: answer }]);

      const topSimilarity = Number(sources[0]?.similarity ?? 0);
      // No agent is loaded here, so there is no workflow graph and no Node
      // 1–4 to report on. Log the two steps that really happened — retrieval
      // and the chat completion — and say so plainly.
      setLogs((prev) => [
        ...prev,
        sources.length > 0
          ? {
              type: "exec",
              text: `[Your files] ✓ Found ${sources.length} piece(s) (best match ${(topSimilarity * 100).toFixed(1)}%).`,
              time: stamp(),
            }
          : {
              type: "exec",
              text: "[Your files] No matching pieces — answering without your files.",
              time: stamp(),
            },
        {
          type: "exec",
          text: `[Answer] ✓ Written by ${engineLabel} in ${elapsedMs} ms.`,
          time: stamp(),
        },
      ]);

      const recordedOk = await recordRun("exec", {
        input: question,
        output: answer,
        status: "success",
        durationMs: elapsedMs,
        sourceCount: sources.length,
        provider,
        model,
      });
      setLogs((prev) => [
        ...prev,
        { type: "sys", text: recordedOk ? "Saved in past runs." : "Finished, but saving it in past runs failed.", time: stamp() },
      ]);
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const reason = err instanceof Error ? err.message : "network failure";

      console.error("Sandbox RAG chat error:", err);
      setIsTyping(false);
      setEngine(null);
      setChatHistory((prev) => [
        ...prev,
        { role: "assistant", text: "Connection error — could not reach the answering service. Please try again." },
      ]);
      setLogs((prev) => [
        ...prev,
        { type: "exec", text: `[ERROR] Network failure after ${elapsedMs} ms: ${reason}`, time: stamp() },
      ]);

      await recordRun("exec", {
        input: question,
        output: reason,
        status: "failed",
        durationMs: elapsedMs,
        error: reason,
      });
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    void runQuestion(input);
  };

  /**
   * "Run Agent" re-executes the last question. It used to call the reset
   * handler, so the button that said Run quietly threw the session away.
   */
  const handleRerun = () => {
    const last = lastQuestionRef.current;
    if (!last) {
      setLogs((prev) => [
        ...prev,
        {
          type: "sys",
          text: "Nothing to run yet — send a message first, then Run repeats it.",
          time: new Date().toLocaleTimeString(),
        },
      ]);
      return;
    }
    void runQuestion(last);
  };

  /** Saves the whole conversation to the run history, where the dashboard can read it back. Guests have no run history — say so plainly instead of posting to a login-only endpoint. */
  const handleSaveSession = async () => {
    if (isGuestRun) {
      setSaveStatus("error");
      setSaveError("Log in to save chats — guest chats are not saved.");
      window.setTimeout(() => setSaveStatus("idle"), 6000);
      return;
    }
    if (chatHistory.length < 2) {
      setSaveStatus("error");
      setSaveError("Nothing to save yet — run at least one exchange first.");
      window.setTimeout(() => setSaveStatus("idle"), 6000);
      return;
    }

    const transcript = chatHistory
      .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.text}`)
      .join("\n");

    setSaveStatus("saving");
    setSaveError(null);

    try {
      const res = await fetch("/api/agents/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          kind: "session",
          agentId,
          agentName,
          input: transcript,
          output: chatHistory[chatHistory.length - 1]?.text ?? "",
          status: "success",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);

      setSaveStatus("saved");
      window.setTimeout(() => setSaveStatus("idle"), 4000);
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Could not save the session.");
      window.setTimeout(() => setSaveStatus("idle"), 8000);
    }
  };

  const handleReset = () => {
    lastQuestionRef.current = null;
    setEngine(null);
    setSaveStatus("idle");
    setSaveError(null);
    setChatHistory([
      { role: "assistant", text: `Connected to ${displayName}. Send a message and I'll run it through your steps, showing each one as it goes.` }
    ]);
    // Dropping the trace returns the right-hand panel to its boot banner.
    setLogs([]);
  };

  return (
    <BuilderLayout
      title={`Try it out: ${displayName}`}
      subtitle="Send a message and watch each step run, one by one."
      onRun={handleRerun}
      runLabel="Run again"
      isRunning={isTyping}
      onSave={handleSaveSession}
      saveLabel="Save chat"
      isSaving={saveStatus === "saving"}
      autoSaveStatus={saveStatus}
      autoSaveError={saveError}
    >
      <div className="absolute inset-0 flex flex-col select-none bg-[var(--bg)]">
        {/* Small screens: Chat / Steps tabs. The record used to be hidden
            below `md` with no way to see it at all. */}
        <div className="flex md:hidden border-b border-[var(--border)] bg-[var(--surface)]" role="tablist" aria-label="Sandbox view">
          <button role="tab" aria-selected={mobileTab === "chat"} onClick={() => setMobileTab("chat")} className={`flex-1 px-4 py-2 text-xs font-semibold ${mobileTab === "chat" ? "text-accent border-b-2 border-accent" : "text-muted"}`}>Chat</button>
          <button role="tab" aria-selected={mobileTab === "trace"} onClick={() => setMobileTab("trace")} className={`flex-1 px-4 py-2 text-xs font-semibold ${mobileTab === "trace" ? "text-accent border-b-2 border-accent" : "text-muted"}`}>Steps</button>
        </div>
        <div className="flex flex-1 min-h-0">
        {/* Left chat panel */}
        <div className={`${mobileTab === "chat" ? "flex" : "hidden"} md:flex flex-1 flex-col min-w-0 border-r border-border text-left relative`}>
          <div className="h-11 px-4 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface)]">
            <div className="flex items-center gap-2">
              <Link
                href={
                  agentId
                    ? `/workflow-builder?agentId=${encodeURIComponent(agentId)}&agentName=${encodeURIComponent(agentName)}`
                    : "/workflow-builder"
                }
                className="text-muted hover:text-[var(--accent)] p-1 rounded-[2px] transition-colors flex items-center gap-1 text-xs"
              >
                <ArrowLeft className="icon-xs" /> Back to the builder
              </Link>
            </div>
            <Button variant="ghost" size="sm" onClick={handleReset} className="h-7 text-[10px] font-semibold text-muted hover:text-accent">
              <RefreshCw className="h-3 w-3 mr-1" />
              Start over
            </Button>
          </div>

          {/* Messages feed */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-[2px] p-3.5 text-xs leading-relaxed border ${
                    msg.role === "user"
                      ? "border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)] font-semibold"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-[2px] p-3 bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-[2px] bg-accent animate-bounce" />
                  <span className="h-1.5 w-1.5 rounded-[2px] bg-accent animate-bounce [animation-delay:0.2s]" />
                  <span className="h-1.5 w-1.5 rounded-[2px] bg-accent animate-bounce [animation-delay:0.4s]" />
                </div>
              </div>
            )}
          </div>

          {/* Input Box */}
          <form onSubmit={handleSend} className="p-4 border-t border-[var(--border)] bg-[var(--surface)] flex gap-2">
            <input
              type="text"
              placeholder="Type a message to try it out…"
              className="input flex-1 px-3.5 py-2 text-xs"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isTyping}
            />
            <Button type="submit" size="sm" disabled={isTyping}>
              <Send className="icon-xs" />
            </Button>
          </form>
        </div>

        {/* Right step-by-step record panel */}
        <div className={`${mobileTab === "trace" ? "flex" : "hidden"} md:flex w-full md:w-95 flex-col border-l border-border bg-surface text-left`}>
          <div className="h-11 px-4 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface)] shrink-0">
            <span className="text-xs font-bold text-foreground">Step-by-step record</span>
          </div>

          {/* Step-by-step record items */}
          <div className="flex-1 overflow-y-auto px-4 py-2">
            {visibleLogs.map((log, i) => (
              <div key={i} className="ruled-row flex items-start gap-3 py-2 text-[11px] font-mono leading-normal">
                <span className={`lamp mt-1 ${traceLamp(log.text)}`} />
                <span className="text-[10px] text-muted shrink-0 mt-0.5">{log.time || "—"}</span>
                <div className="flex flex-col">
                  {log.type === "sys" ? (
                    <span className="text-accent font-semibold">{log.text}</span>
                  ) : (
                    <span className="text-foreground/90">{log.text}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Team conversation for the linked run, same component as the
              run view. Only when ?runId= was given — a plain sandbox run
              has no persisted conversation to show. */}
          {runId && (
            <div className="shrink-0 border-t border-[var(--border)] px-4 py-3 max-h-[45%] overflow-y-auto">
              <TeamConversation runId={runId} />
            </div>
          )}

          {/* Metrics summary */}
          <div className="p-4 border-t border-[var(--border)] bg-[var(--surface)] text-[10px] text-muted space-y-3">
            {/* Which model answered is detail, not the headline: it lives
                behind "More options" and still works exactly as before. */}
            <details>
              <summary className="cursor-pointer font-semibold text-[var(--text)]">More options</summary>
              <div className="space-y-3 pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0">Answered by:</span>
              <span
                className={`font-mono font-bold truncate ${engine ? "text-[var(--text)]" : "text-muted"}`}
                title={
                  engine
                    ? [engine.provider, engine.model].filter(Boolean).join(" — ")
                    : undefined
                }
              >
                {engine ? engine.model || engine.provider || "not set yet" : "not run yet"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0">Service:</span>
              <span className={`font-mono font-bold truncate ${engine?.provider ? "text-[var(--text)]" : "text-muted"}`}>
                {engine?.provider || "—"}
              </span>
            </div>
              </div>
            </details>
            <div className="flex items-center justify-between">
              <span>Runs saved:</span>
              <span className="font-mono font-bold text-[var(--text)]">{recorded}</span>
            </div>
            <Link
              href="/dashboard/analytics"
              className="inline-flex items-center gap-0.5 pt-1 text-[9px] font-semibold text-accent hover:underline"
            >
              See past runs
              <ChevronRight className="h-3 w-3" aria-hidden />
            </Link>
            
            {/* Your files status & upload — login-only. Guests see the
                plain line instead of upload buttons that would 401. */}
            <div className="pt-2 border-t border-border/30 space-y-2">
              {isGuestRun ? (
                <div className="flex items-center justify-between">
                  <span>Your files:</span>
                  <span className="status-line">Log in to add files</span>
                </div>
              ) : (
              <>
              <div className="flex items-center justify-between">
                <span>Your files:</span>
                <span className="status-line">
                  <span className={`lamp ${kbStatus && kbStatus.chunks > 0 ? "lamp-ok" : "lamp-soon"}`} />
                  {kbStatus ? (kbStatus.chunks > 0 ? `Ready (${kbStatus.chunks} pieces)` : "No files yet") : "Loading…"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Files:</span>
                <span className="font-mono font-bold text-[var(--text)]">{kbStatus?.documents || 0}</span>
              </div>
              
              {/* Upload / Clear Buttons */}
              <div className="mt-3 pt-3 border-t border-border/30 space-y-2">
                {(!kbStatus || kbStatus.chunks === 0) ? (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={kbUploadBusy}
                    className="btn btn-primary w-full"
                  >
                    {kbUploadBusy ? 'Uploading…' : 'Upload document'}
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={kbUploadBusy || kbClearBusy}
                      className="btn btn-primary flex-1"
                    >
                      {kbUploadBusy ? 'Uploading…' : 'Upload'}
                    </button>
                    <button
                      onClick={handleKbClear}
                      disabled={kbUploadBusy || kbClearBusy}
                      className="btn btn-danger flex-1"
                    >
                      {kbClearBusy ? 'Clearing…' : 'Clear all'}
                    </button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleKbUpload}
                  accept=".txt,.pdf,.md"
                  className="hidden"
                  disabled={kbUploadBusy}
                />
                {kbUploadMessage && (
                  <div className={kbUploadMessage.startsWith('✓') ? 'notice' : 'notice-danger'}>
                    {kbUploadMessage}
                  </div>
                )}
              </div>
              </>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
    </BuilderLayout>
  );
}

export default function TestingSandboxPage() {
  return (
    <React.Suspense fallback={<div className="h-screen w-screen flex items-center justify-center bg-background text-muted text-sm">Loading…</div>}>
      <TestingSandboxInner />
    </React.Suspense>
  );
}
