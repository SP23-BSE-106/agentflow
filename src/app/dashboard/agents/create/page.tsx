"use client";

import * as React from "react";
import Link from "next/link";
import {
  Sparkles, Send, CheckCircle, ArrowRight, ArrowLeft,
  Cpu, AlertTriangle, Loader2, Key, Headphones, TrendingUp, BookOpen,
  ChevronRight, Save, ExternalLink, Tag, Info,
  Zap, Database, GitMerge, Globe, BrainCircuit, Terminal, Layers,
  UploadCloud, FileText, Trash2
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import type { WorkflowGraph, WorkflowNode, NodeType } from "@/lib/mongo/workflow";
import {
  agentNameFromPrompt,
  cleanAgentName,
  isDuplicateAgentName,
  isUsableAgentName,
  nextAvailableAgentName,
} from "@/lib/agentName";
import {
  saveGuestWorkflow,
  workflowSourceFromResponse,
  workflowSourceLabel,
  type WorkflowSource,
} from "@/lib/guestWorkflow";
import { LLM_PROVIDERS } from "@/lib/llmProviders";
import { clearByokKey, loadByokKey, maskedByokKey, saveByokKey } from "@/lib/byok";
import { ProviderKeyField } from "@/components/byok/ProviderKeyField";

// ─── Types ──────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;

// ─── Constants ──────────────────────────────────────────────────────────────

const QUICK_TEMPLATES = [
  { category: "Support", name: "Customer Support Helper", icon: Headphones, prompt: "Create a customer support agent that reads uploaded documents, works out what the customer wants, looks in your files for the answer, and drafts a personal reply." },
  { category: "Sales", name: "New Lead Helper", icon: TrendingUp, prompt: "Build an agent that looks up new leads, works out how good a fit they are, and drafts a personal first message." },
  { category: "Operations", name: "Questions From Your Files", icon: BookOpen, prompt: "Create an agent that answers employee questions from uploaded product guides, onboarding notes, and policy files." },
];

// ─── Node type → icon / colour mapping ──────────────────────────────────────

// Node-type colours: one signal colour only. All node icons are muted;
// the mono type label carries the distinction, not a rainbow.
const NODE_META: Partial<Record<NodeType, { icon: React.FC<{ className?: string }>; colour: string }>> = {
  trigger:   { icon: Zap,         colour: "text-[var(--muted)]" },
  llm:       { icon: BrainCircuit, colour: "text-[var(--muted)]" },
  rag:       { icon: Database,    colour: "text-[var(--muted)]" },
  api:       { icon: Globe,       colour: "text-[var(--muted)]" },
  condition: { icon: GitMerge,    colour: "text-[var(--muted)]" },
  output:    { icon: Terminal,    colour: "text-[var(--muted)]" },
  tool:      { icon: Layers,      colour: "text-[var(--muted)]" },
  memory:    { icon: Cpu,         colour: "text-[var(--muted)]" },
};

function getNodeMeta(type: string) {
  return NODE_META[type as NodeType] ?? { icon: Cpu, colour: "text-[var(--muted)]" };
}

// ─── Step indicator ──────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  const steps = [
    { n: 1 as Step, label: "Describe" },
    { n: 2 as Step, label: "Check" },
    { n: 3 as Step, label: "Save" },
  ];
  return (
    <div className="flex items-center gap-0 select-none">
      {steps.map((s, i) => (
        <React.Fragment key={s.n}>
          <div className="flex flex-col items-center gap-1">
            <div
              className={[
                "h-8 w-8 rounded-[2px] flex items-center justify-center text-xs font-bold border transition-all",
                current === s.n
                  ? "bg-[var(--accent)] border-[var(--accent)] text-white"
                  : current > s.n
                  ? "bg-[var(--surface-2)] border-[var(--accent)] text-[var(--accent)]"
                  : "bg-[var(--surface)] border-[var(--border-strong)] text-[var(--muted)]",
              ].join(" ")}
            >
              {current > s.n ? <CheckCircle className="icon-sm" /> : s.n}
            </div>
            <span className={`text-[10px] font-semibold ${current >= s.n ? "text-[var(--text)]" : "text-[var(--muted)]"}`}>
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px w-10 sm:w-16 mb-4 mx-1 transition-colors ${current > s.n ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Workflow node card ──────────────────────────────────────────────────────

// Plain words for the step types shown on the badges. The stored type
// (node.type) is unchanged — only the label a person reads is simplified:
// a "trigger" is the step that starts things off.
const NODE_TYPE_LABELS: Record<string, string> = {
  trigger: "start",
  llm: "AI step",
  rag: "your files",
  api: "other app",
  condition: "choice",
  output: "answer",
  tool: "tool",
  memory: "memory",
};

function NodeCard({ node, index }: { node: WorkflowNode; index: number }) {
  const meta = getNodeMeta(node.type);
  const Icon = meta.icon;
  return (
    <div className="relative group flex gap-4 pl-2">
      {/* connector line */}
      <div className="flex flex-col items-center">
        <div className="h-8 w-8 rounded-[2px] border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center shrink-0">
          <Icon className={`icon-xs ${meta.colour}`} />
        </div>
        <div className="w-px flex-1 bg-[var(--border)] mt-1 mb-0 min-h-4" />
      </div>
      <div className="flex-1 pb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-[var(--muted)] font-bold font-mono">#{index + 1}</span>
          <span className="text-xs font-semibold text-[var(--text)]">{node.name}</span>
          <span className="text-[10px] font-mono text-[var(--muted)] border border-[var(--border)] rounded-[2px] px-1.5 py-0">
            {NODE_TYPE_LABELS[node.type] ?? node.type}
          </span>
        </div>
        <p className="text-[10px] text-[var(--muted)] mt-1 leading-relaxed">{node.description}</p>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function CreateAgentPage() {

  // ── Form state ─────────────────────────────────────────────────────────────
  const [step, setStep] = React.useState<Step>(1);
  const [prompt, setPrompt] = React.useState("");

  // Step 2 — generated workflow + metadata
  const [workflow, setWorkflow] = React.useState<WorkflowGraph | null>(null);
  const [agentName, setAgentName] = React.useState("");
  const [agentDesc, setAgentDesc] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [provider, setProvider] = React.useState(LLM_PROVIDERS[0].id);
  const [apiKey, setApiKey] = React.useState("");
  // Custom preset extras (only used when the Custom service is picked).
  const [baseUrl, setBaseUrl] = React.useState("");
  const [customModel, setCustomModel] = React.useState("");
  // Plain-words saved state for the key kept in this browser, e.g.
  // "Google Gemini key saved in this browser · …1234". Null when none.
  const [savedByokLabel, setSavedByokLabel] = React.useState<string | null>(null);
  const [knowledgeBaseEnabled, setKnowledgeBaseEnabled] = React.useState(true);
  const [knowledgeBase, setKnowledgeBase] = React.useState("");
  const [uploadedDocuments, setUploadedDocuments] = React.useState<Array<{ id: string; name: string; size: string; content: string }>>([]);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // ── Async state ────────────────────────────────────────────────────────────
  const [generating, setGenerating] = React.useState(false);
  const [generateError, setGenerateError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedAgent, setSavedAgent] = React.useState<{ _id: string; name: string } | null>(null);
  const [isMock, setIsMock] = React.useState(false);
  // Where the generated steps came from (Lane A's `source` flag). Shown in
  // plain words next to the steps; null until a workflow has been generated.
  const [workflowSource, setWorkflowSource] = React.useState<WorkflowSource | null>(null);

  // Names this user already owns, so a duplicate is flagged while typing
  // instead of only after the save round-trip.
  const [existingNames, setExistingNames] = React.useState<string[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/agents", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        if (!cancelled && Array.isArray(list)) {
          setExistingNames(list.map((a: { name?: string }) => cleanAgentName(a.name)).filter(Boolean));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Browser key (BYOK): if one was saved in this browser, pick up its
  // provider so the panel matches what will actually be used. Read after
  // mount (localStorage only exists in the browser) and apply on the next
  // tick, so the first paint is not a cascading re-render.
  React.useEffect(() => {
    const saved = loadByokKey();
    if (!saved) return;
    const timer = setTimeout(() => {
      setProvider(saved.provider);
      if (saved.baseUrl) setBaseUrl(saved.baseUrl);
      if (saved.model) setCustomModel(saved.model);
      setSavedByokLabel(maskedByokKey());
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Keep the typed key in this browser as well, so building and running can
  // use it right away without an account. Signed-in saving still sends
  // userApiKey with the agent, as before.
  const handleSaveByok = () => {
    if (!apiKey.trim()) return;
    saveByokKey({
      provider,
      key: apiKey.trim(),
      ...(customModel.trim() ? { model: customModel.trim() } : {}),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    });
    setSavedByokLabel(maskedByokKey());
  };

  const handleRemoveByok = () => {
    clearByokKey();
    setSavedByokLabel(null);
  };

  const cleanedName = cleanAgentName(agentName);
  const nameIsUsable = isUsableAgentName(cleanedName);
  const duplicateName =
    cleanedName.length === 0
      ? null
      : existingNames.find((existing) => isDuplicateAgentName(existing, cleanedName)) ?? null;

  // ── Typewriter log lines while generating ──────────────────────────────────
  const [logLines, setLogLines] = React.useState<string[]>([]);
  const logTimers = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  function startGeneratingLog() {
    const messages = [
      "Reading what you asked for…",
      "Working out the steps…",
      "Lining the steps up in order…",
      "Checking how your files will be used…",
      "Working out the if-this-then-that parts…",
      "Joining the steps together…",
      "Checking everything makes sense…",
      "Almost done…",
    ];
    setLogLines([]);
    logTimers.current.forEach(clearTimeout);
    logTimers.current = [];
    messages.forEach((msg, i) => {
      const t = setTimeout(() => {
        setLogLines((prev) => [...prev, msg]);
      }, i * 900);
      logTimers.current.push(t);
    });
  }

  function clearLog() {
    logTimers.current.forEach(clearTimeout);
    logTimers.current = [];
    setLogLines([]);
  }

  const handleDocumentUpload = async (files: FileList | null) => {
    if (!files?.length) return;

    setUploadError(null);
    try {
      const nextDocs = await Promise.all(
        Array.from(files).map(async (file) => {
          const isTextLike = file.type.startsWith("text/") || /\.(txt|md|json|csv)$/i.test(file.name);
          const content = isTextLike
            ? await file.text()
            : "[PDF or binary content preview is not available in this demo. Upload text-based files for richer knowledge context.]";

          return {
            id: `${file.name}-${file.size}-${Date.now()}`,
            name: file.name,
            size: `${(file.size / 1024).toFixed(0)} KB`,
            content: content.slice(0, 4000),
          };
        }),
      );

      setUploadedDocuments((prev) => [...nextDocs, ...prev]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Unable to read the selected file.");
    }
  };

  const removeDocument = (id: string) => {
    setUploadedDocuments((prev) => prev.filter((doc) => doc.id !== id));
  };

  // ── Step 1 → Generate ──────────────────────────────────────────────────────
  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || generating) return;

    setGenerating(true);
    setGenerateError(null);
    setWorkflow(null);
    setIsMock(false);
    startGeneratingLog();

    try {
      const baseContext = [
        knowledgeBaseEnabled && knowledgeBase.trim() ? `Knowledge base notes:\n${knowledgeBase.trim()}` : null,
        uploadedDocuments.length > 0
          ? `Uploaded documents:\n${uploadedDocuments
              .map((doc) => `- ${doc.name}: ${doc.content}`)
              .join("\n\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");

      const enrichedPrompt = baseContext ? `${prompt}\n\n${baseContext}` : prompt;

      // A key saved in this browser goes along, so building can use it
      // right away without an account.
      const byok = loadByokKey();
      const generateBody: Record<string, unknown> = { prompt: enrichedPrompt };
      if (byok?.key) {
        const agentKey: Record<string, string> = { provider: byok.provider, key: byok.key };
        if (byok.model) agentKey.model = byok.model;
        if (byok.baseUrl) agentKey.baseUrl = byok.baseUrl;
        generateBody.agentKey = agentKey;
      }

      const res = await fetch("/api/agents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generateBody),
      });

      const data = await res.json();

      if (!res.ok) {
        let errMsg = data?.error || "Generation failed.";
        if (data?.hint) errMsg += `\n\n${data.hint}`;
        if (data?.detail) errMsg += `\n${data.detail}`;
        throw new Error(errMsg);
      }

      clearLog();
      setIsMock(!!data._mock);
      const source = workflowSourceFromResponse(data);
      setWorkflowSource(source);
      setWorkflow(data.workflow as WorkflowGraph);
      // Guest handoff: the generated workflow lives in this browser, so the
      // builder can open it with no account and no server round-trip. The
      // visitor still reviews the steps here first (Step 2) and opens the
      // builder from there; saving to an account stays a separate, login-only
      // step (Step 3 / Save Agent).
      saveGuestWorkflow({
        workflow: data.workflow as WorkflowGraph,
        name: data.workflow?.name,
        description: data.workflow?.description,
        prompt,
        source,
      });
      setAgentDesc((prev) => (data.workflow?.name ? data.workflow.description ?? "" : prev));

      // Always re-derive the name. Carrying over whatever was typed for the
      // previous prompt is how agents end up with titles that describe nothing
      // — and the suggested name is checked against the ones already saved, so
      // the pre-filled value is usable without editing.
      const suggested =
        cleanAgentName(data.workflow?.name) || agentNameFromPrompt(prompt, "New Agent");
      setAgentName(nextAvailableAgentName(suggested, existingNames));

      setStep(2);
    } catch (err) {
      clearLog();
      setGenerateError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setGenerating(false);
    }
  };

  // ── Step 3 → Save ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!workflow || saving) return;
    setSaveError(null);
    if (!nameIsUsable) {
      setSaveError("Give the agent a name that contains letters or numbers.");
      return;
    }
    if (duplicateName) {
      setSaveError(`You already have an agent named "${duplicateName}". Choose a different name.`);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanedName,
          description: agentDesc,
          prompt,
          workflow,
          llmProvider: provider,
          userApiKey: apiKey || undefined,
          status: "draft",
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Save failed.");
      setSavedAgent({ _id: data._id, name: data.name });
      setStep(3);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save agent.");
    } finally {
      setSaving(false);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-h1 font-bold text-[var(--text)] flex items-center gap-2">
              <Sparkles className="icon-lg text-[var(--accent)]" />
              Create Agent
            </h2>
            <p className="text-xs text-[var(--muted)] max-w-xl">
              Tell us what you want your helper to do, in plain words. We will
              build the steps for you — then you check them and save.
            </p>
          </div>
          <StepIndicator current={step} />
        </div>

        {/* ─── STEP 1 — Describe ───────────────────────────────────────────── */}
        {step === 1 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
            {/* Main form */}
            <div className="lg:col-span-2 space-y-5">
              <div className="panel p-4">
                <form onSubmit={handleGenerate} className="space-y-4">
                  <div className="space-y-2">
                    <label htmlFor="agent-prompt" className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                      What should this agent do?
                    </label>
                    <textarea
                      id="agent-prompt"
                      placeholder="e.g. Build an agent that watches our support inbox, looks in our help files for answers, drafts a reply, and asks a person to check it before sending…"
                      className="textarea min-h-40 w-full text-sm resize-none"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value.slice(0, 2000))}
                      disabled={generating}
                      maxLength={2000}
                    />
                    <div className="text-right text-[10px] text-[var(--muted)]">
                      {prompt.length}/2000
                    </div>
                  </div>

                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <span className="text-[10px] text-[var(--muted)] flex items-center gap-1.5">
                      <Sparkles className="icon-xs text-[var(--accent)] animate-pulse" />
                      Built for you by AI
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        multiple
                        accept=".txt,.md,.json,.csv,.pdf"
                        onChange={(e) => handleDocumentUpload(e.target.files)}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={generating}
                      >
                        <UploadCloud className="mr-1.5 icon-xs" />
                        Upload file
                      </button>
                      <button type="submit" className="btn btn-primary" disabled={!prompt.trim() || generating}>
                        {generating ? <Loader2 className="icon-xs mr-1.5 animate-spin" /> : <Send className="icon-xs mr-1.5" />}
                        Build my agent
                      </button>
                    </div>
                  </div>
                </form>
              </div>

              {/* Generating log */}
              {generating && (
                <div className="panel p-4">
                  <div className="flex items-center gap-3 mb-4">
                    <Loader2 className="icon-sm text-[var(--accent)] animate-spin" />
                    <span className="text-xs font-semibold text-[var(--text)]">
                      Building your agent…
                    </span>
                  </div>
                  <div className="space-y-2 font-mono">
                    {logLines.map((line, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px] text-[var(--muted)]">
                        <ChevronRight className="h-3 w-3 text-[var(--accent)] shrink-0" />
                        {line}
                      </div>
                    ))}
                    {logLines.length > 0 && (
                      <span className="inline-block w-1.5 h-3 bg-[var(--accent)] animate-pulse rounded-[2px] ml-5" />
                    )}
                  </div>
                </div>
              )}

              {/* Error */}
              {generateError && !generating && (
                <div className="notice notice-danger">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="icon-sm mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <p className="text-xs font-semibold">Couldn&apos;t build it</p>
                      <p className="text-[11px] whitespace-pre-wrap">{generateError}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Quick templates */}
            <div className="space-y-4">
              <h3 className="font-h3 font-semibold text-[var(--text)] text-sm">Quick Templates</h3>
              <div className="space-y-3">
                {QUICK_TEMPLATES.map(({ icon: Icon, ...t }, i) => (
                  <button
                    key={i}
                    type="button"
                    className="panel w-full p-4 text-left cursor-pointer hover:border-[var(--accent)]"
                    onClick={() => setPrompt(t.prompt)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-2">
                          <div className="h-8 w-8 rounded-[2px] border border-[var(--border)] flex items-center justify-center text-[var(--muted)]">
                            <Icon className="icon-sm" />
                          </div>
                          <span>{t.name}</span>
                        </h4>
                        <p className="text-[10px] text-[var(--muted)] mt-2 leading-relaxed line-clamp-3">
                          {t.prompt}
                        </p>
                      </div>
                      <span className="text-[9px] text-[var(--muted)] font-semibold uppercase tracking-wider whitespace-nowrap mt-1">
                        {t.category}
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="panel p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold text-[var(--muted)] uppercase tracking-wider flex items-center gap-1.5">
                    <Database className="h-3 w-3" /> Your files
                  </p>
                  <label className="flex items-center gap-2 text-[10px] text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={knowledgeBaseEnabled}
                      onChange={(e) => setKnowledgeBaseEnabled(e.target.checked)}
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                    Enable
                  </label>
                </div>
                <p className="text-[10px] text-[var(--muted)] leading-relaxed">
                  Add files and short notes here so the agent can work from the same information you use.
                </p>

                <p className="rounded-[2px] border border-dashed border-[var(--border-strong)] px-3 py-3 text-[10px] text-[var(--muted)]">
                  Upload files with the button above before building, so they can be used when the steps are made.
                </p>

                {uploadError && <p className="text-[10px] text-[var(--danger)]">{uploadError}</p>}

                {uploadedDocuments.length > 0 && (
                  <div className="space-y-2">
                    {uploadedDocuments.map((doc) => (
                      <div key={doc.id} className="flex items-start justify-between gap-2 rounded-[2px] border border-[var(--border)] px-3 py-2">
                        <div className="flex min-w-0 items-start gap-2">
                          <FileText className="mt-0.5 icon-xs text-[var(--accent)]" />
                          <div className="min-w-0">
                            <p className="truncate text-[10px] font-semibold text-[var(--text)]">{doc.name}</p>
                            <p className="text-[9px] text-[var(--muted)]">{doc.size}</p>
                          </div>
                        </div>
                        <button type="button" onClick={() => removeDocument(doc.id)} className="text-[var(--muted)] transition hover:text-[var(--danger)]">
                          <Trash2 className="icon-xs" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <textarea
                  value={knowledgeBase}
                  onChange={(e) => setKnowledgeBase(e.target.value)}
                  placeholder="Paste policy snippets, FAQs, onboarding notes, or product context…"
                  className="textarea min-h-25 w-full text-[11px] resize-none"
                  disabled={!knowledgeBaseEnabled}
                />
              </div>

              <div className="rounded-[4px] border border-[var(--border)] p-4 space-y-2">
                <p className="text-[10px] font-semibold text-[var(--muted)] uppercase tracking-wider flex items-center gap-1.5">
                  <Info className="h-3 w-3" /> How it works
                </p>
                <ul className="space-y-1.5 text-[10px] text-[var(--muted)]">
                  <li className="flex gap-2"><span className="text-[var(--accent)] font-bold">1.</span> You describe what the agent should do</li>
                  <li className="flex gap-2"><span className="text-[var(--accent)] font-bold">2.</span> We build the steps for it</li>
                  <li className="flex gap-2"><span className="text-[var(--accent)] font-bold">3.</span> Add your files and AI key</li>
                  <li className="flex gap-2"><span className="text-[var(--accent)] font-bold">4.</span> Save, then open it to change the steps</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* ─── STEP 2 — Review & Configure ─────────────────────────────────── */}
        {step === 2 && (
          workflow ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
            {/* Workflow preview */}
            <div className="lg:col-span-2 space-y-5">
              <div className="panel p-4">
                <div className="border-b border-[var(--border)] pb-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CheckCircle className="icon-sm text-[var(--accent)]" />
                    <h3 className="text-sm font-semibold text-[var(--text)]">
                      Your agent&apos;s steps — {workflow.nodes?.length ?? 0} steps
                    </h3>
                    <span className="status-line ml-auto">
                      <span className="lamp lamp-ok" />
                      Ready to check
                    </span>
                  </div>
                  <p className="text-[10px] mt-1 text-[var(--muted)]">
                    Read through the steps below. Give the agent a name and add your AI key on the right.
                  </p>
                  {workflowSource && (
                    <p className="text-[10px] mt-1 font-semibold text-[var(--text)]">
                      {workflowSourceLabel(workflowSource, isMock)}
                    </p>
                  )}
                </div>

                {isMock && (
                  <div className="notice notice-warn mt-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="icon-sm shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-semibold">Showing a practice version</p>
                        <p className="text-[10px] text-[var(--muted)] mt-0.5 leading-relaxed">
                          The AI service could not be reached, so this is a simple example made from
                          the words in your description. To build a real agent, check the service
                          is running and try again.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="pt-5">
                  {/* Node chain */}
                  <div className="space-y-0">
                    {(workflow.nodes ?? []).map((node, idx) => (
                      <NodeCard key={node.id ?? idx} node={node} index={idx} />
                    ))}
                  </div>

                  {/* Edges summary */}
                  {(workflow.edges ?? []).length > 0 && (
                    <div className="mt-4 pt-4 border-t border-[var(--border)]">
                      <p className="text-[10px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">
                        How the steps link together ({workflow.edges.length})
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {workflow.edges.map((edge, i) => {
                          const src = workflow.nodes?.find((n) => n.id === edge.source)?.name ?? edge.source;
                          const tgt = workflow.nodes?.find((n) => n.id === edge.target)?.name ?? edge.target;
                          return (
                            <span key={edge.id ?? i} className="text-[10px] font-mono border border-[var(--border)] rounded-[2px] px-2 py-0.5 text-[var(--muted)]">
                              {src} → {tgt}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3 flex-wrap">
                <button type="button" className="btn btn-secondary" onClick={() => { setStep(1); setWorkflow(null); setGenerateError(null); setSaveError(null); }}>
                  <ArrowLeft className="icon-xs mr-1.5" />
                  Back
                </button>
                {/* Guest handoff: the steps are already saved in this browser,
                    so the builder opens them with no account and no server
                    round-trip. Saving to an account still needs Save Agent. */}
                <Link href="/workflow-builder" className="btn btn-secondary">
                  <ExternalLink className="icon-xs mr-1.5" />
                  Open in builder
                </Link>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={!nameIsUsable || Boolean(duplicateName) || saving}
                >
                  {saving ? <Loader2 className="icon-xs mr-1.5 animate-spin" /> : <Save className="icon-xs mr-1.5" />}
                  Save Agent
                </button>
              </div>
              {saveError && (
                <div className="notice notice-danger">
                  <span className="flex items-start gap-2">
                    <AlertTriangle className="icon-sm shrink-0 mt-0.5" />
                    <span className="text-xs">{saveError}</span>
                  </span>
                </div>
              )}
            </div>

            {/* Config panel */}
            <div className="space-y-5">
              {/* Agent metadata */}
              <div className="panel p-4 space-y-4">
                <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
                  Agent Details
                </h3>

                <div className="space-y-1.5">
                  <label htmlFor="agent-name" className="text-[10px] font-semibold text-[var(--muted)]">
                    Agent Name *
                  </label>
                  <input
                    id="agent-name"
                    type="text"
                    className="input"
                    placeholder="My Support Agent"
                    value={agentName}
                    onChange={(e) => {
                      setAgentName(e.target.value);
                      setSaveError(null);
                    }}
                    autoComplete="off"
                    aria-invalid={Boolean(duplicateName) || (agentName.length > 0 && !nameIsUsable)}
                  />
                  {duplicateName && (
                    <p className="flex items-center gap-1.5 text-[10px] text-[var(--danger)]" role="alert">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      You already have an agent named &ldquo;{duplicateName}&rdquo;.
                    </p>
                  )}
                  {!duplicateName && agentName.length > 0 && !nameIsUsable && (
                    <p className="flex items-center gap-1.5 text-[10px] text-[var(--danger)]" role="alert">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      The name needs at least one letter or number.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="agent-desc" className="text-[10px] font-semibold text-[var(--muted)]">
                    Description
                  </label>
                  <textarea
                    id="agent-desc"
                    className="textarea resize-none min-h-17.5"
                    placeholder="Short description of what this agent does"
                    value={agentDesc}
                    onChange={(e) => setAgentDesc(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="agent-tags" className="text-[10px] font-semibold text-[var(--muted)] flex items-center gap-1.5">
                    <Tag className="h-3 w-3" /> Tags (comma-separated)
                  </label>
                  <input
                    id="agent-tags"
                    type="text"
                    className="input"
                    placeholder="support, email, automation"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>

              {/* API Key config */}
              <div className="panel p-4 space-y-4">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider flex items-center gap-2">
                    <Key className="icon-xs text-[var(--accent)]" />
                    AI key
                  </h3>
                  <p className="text-[10px] text-[var(--muted)] mt-1">
                    The password this agent uses to talk to its AI service. It is only used
                    when the agent runs, and it is stored locked away.
                    Leave it blank to add it later.
                  </p>
                </div>

                <ProviderKeyField
                  provider={provider}
                  onProviderChange={setProvider}
                  apiKey={apiKey}
                  onApiKeyChange={setApiKey}
                  baseUrl={baseUrl}
                  onBaseUrlChange={setBaseUrl}
                  model={customModel}
                  onModelChange={setCustomModel}
                  idPrefix="create"
                />

                {/* Key kept in this browser */}
                {savedByokLabel && (
                  <p className="status-line">
                    <span className="lamp lamp-ok" />
                    {savedByokLabel}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleSaveByok}
                    disabled={!apiKey.trim()}
                  >
                    Save key in this browser
                  </button>
                  {savedByokLabel && (
                    <button
                      type="button"
                      className="btn btn-ghost text-[var(--danger)]"
                      onClick={handleRemoveByok}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-[var(--muted)] leading-relaxed">
                  Saved in this browser only. It is used when you build and run,
                  and you can remove it here any time.
                </p>
              </div>
            </div>
          </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
              <AlertTriangle className="h-8 w-8 text-[var(--warn)]" />
              <p className="text-sm font-semibold text-[var(--text)]">No steps were built</p>
              <p className="text-xs text-[var(--muted)]">Something went wrong. Go back and try again.</p>
              <button type="button" className="btn btn-secondary" onClick={() => { setStep(1); setGenerateError(null); }}>
                <ArrowLeft className="icon-xs mr-1.5" /> Go Back
              </button>
            </div>
          )
        )}

        {/* ─── STEP 3 — Saved ──────────────────────────────────────────────── */}
        {step === 3 && savedAgent && (
          <div className="max-w-2xl mx-auto">
            <div className="panel p-8 text-center">
              <div className="flex flex-col items-center gap-5">
                {/* Success icon */}
                <div className="h-16 w-16 rounded-[4px] border border-[var(--accent)] flex items-center justify-center">
                  <CheckCircle className="h-8 w-8 text-[var(--accent)]" />
                </div>

                <div className="space-y-1">
                  <h3 className="font-h1 font-semibold text-[var(--text)]">Your agent is saved!</h3>
                  <p className="text-xs text-[var(--muted)]">
                    <span className="font-semibold text-[var(--text)]">{savedAgent.name}</span> has been
                    saved as a draft — it is not running yet. Open it to change its steps.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 w-full">
                  <Link href={`/workflow-builder?agentId=${savedAgent._id}`} className="btn btn-primary flex-1">
                    <ExternalLink className="icon-xs mr-1.5" />
                    Open and edit
                  </Link>
                  <Link href="/dashboard/agents" className="btn btn-secondary flex-1">
                    <ArrowRight className="icon-xs mr-1.5" />
                    View All Agents
                  </Link>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setStep(1);
                    setPrompt("");
                    setWorkflow(null);
                    setAgentName("");
                    setAgentDesc("");
                    setTags("");
                    setApiKey("");
                    setBaseUrl("");
                    setCustomModel("");
                    setSavedAgent(null);
                    setGenerateError(null);
                  }}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--text)] underline underline-offset-2"
                >
                  Create another agent
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}