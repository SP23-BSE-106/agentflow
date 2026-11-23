"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ProviderKeyField } from "@/components/byok/ProviderKeyField";
import { LLM_PROVIDERS, getProviderPreset } from "@/lib/llmProviders";
import { loadByokKey, maskedByokKey, saveByokKey } from "@/lib/byok";

/**
 * First-run welcome page: bring your own AI key, then a plain-English
 * tour of how the site works.
 *
 * Nothing here is required. Skipping — or finishing — records
 * `agentflow.welcome-seen.v1` in this browser and goes to the dashboard,
 * and the site works with no key at all (plain template answers).
 *
 * The key itself is never stored in a new place: guests keep it in this
 * browser via src/lib/byok.ts, signed-in users store it locked away via
 * POST /api/keys. The Test button lives inside ProviderKeyField and calls
 * the existing POST /api/settings/llm-test.
 */

const WELCOME_SEEN_KEY = "agentflow.welcome-seen.v1";

const JOURNEY: Array<{ href: string; title: string; detail: string }> = [
  {
    href: "/dashboard/agents/create",
    title: "Describe what you want, in plain words",
    detail: "Tell the site what the agent should do, in your own words.",
  },
  {
    href: "/workflow-builder",
    title: "Change the steps on the canvas",
    detail: "Each step is a box you can move, edit, or remove.",
  },
  {
    href: "/testing-sandbox",
    title: "Try it in the sandbox",
    detail: "Run the agent with test input and watch each step run.",
  },
  {
    href: "/dashboard/rag",
    title: "Add your files, so it answers from them",
    detail: "Upload documents and the agent uses what is in them.",
  },
  {
    href: "/dashboard/deployment",
    title: "Make it live",
    detail: "Put the agent where people can reach it.",
  },
  {
    href: "/dashboard/orchestrate",
    title: "Teams: agents asking each other questions",
    detail: "Watch the conversation live as agents pass work to each other.",
  },
];

function markSeenAndGo(router: ReturnType<typeof useRouter>) {
  try {
    window.localStorage.setItem(WELCOME_SEEN_KEY, "1");
  } catch {
    // Storage blocked: the page may show again, but the user still gets
    // to the dashboard.
  }
  router.push("/dashboard");
}

export default function WelcomePageClient() {
  const router = useRouter();

  const [provider, setProvider] = React.useState(LLM_PROVIDERS[0].id);
  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [customModel, setCustomModel] = React.useState("");

  // Signed-in state, as the Navbar does: /api/auth/me answers
  // { user: null } for a guest, so null is a settled guest state.
  const [signedIn, setSignedIn] = React.useState(false);
  const [authLoading, setAuthLoading] = React.useState(true);

  const [savedLabel, setSavedLabel] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState("");

  // A key saved in this browser already: prefill the selector from it,
  // as the create page does.
  React.useEffect(() => {
    const savedKey = loadByokKey();
    if (!savedKey) return;
    const timer = setTimeout(() => {
      setProvider(savedKey.provider);
      if (savedKey.baseUrl) setBaseUrl(savedKey.baseUrl);
      if (savedKey.model) setCustomModel(savedKey.model);
      setSavedLabel(maskedByokKey());
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = (await res.json().catch(() => ({}))) as {
          user?: { fullName?: string; email?: string } | null;
        };
        if (cancelled) return;
        const isSignedIn = Boolean(data.user);
        setSignedIn(isSignedIn);
        if (isSignedIn) {
          // A key saved to the account: show which service it is for.
          // GET /api/keys answers with provider ids only, never key material.
          const keysRes = await fetch("/api/keys");
          const keysData = (await keysRes.json().catch(() => null)) as {
            providers?: unknown;
          } | null;
          if (cancelled) return;
          const providers = Array.isArray(keysData?.providers)
            ? keysData.providers.filter((p): p is string => typeof p === "string")
            : [];
          if (providers.length > 0) {
            const labels = providers.map(
              (id) => getProviderPreset(id)?.label ?? id,
            );
            setSavedLabel(`${labels.join(", ")} key saved to your account`);
          }
        }
      } catch {
        if (!cancelled) setSignedIn(false);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };
    checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      if (signedIn) {
        const res = await fetch("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            key: apiKey.trim(),
            ...(customModel.trim() ? { model: customModel.trim() } : {}),
            ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error || "That key could not be saved");
        const label = getProviderPreset(provider)?.label ?? provider;
        setSavedLabel(`${label} key saved to your account`);
      } else {
        saveByokKey({
          provider,
          key: apiKey.trim(),
          ...(customModel.trim() ? { model: customModel.trim() } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        });
        setSavedLabel(maskedByokKey());
      }
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "That key could not be saved");
    } finally {
      setSaving(false);
    }
  };

  // Editing the key after a save means the saved line no longer describes
  // what is in the field.
  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    setSaved(false);
    setSavedLabel(null);
    setSaveError("");
  };

  const handleProviderChange = (id: string) => {
    setProvider(id);
    setSaved(false);
    setSavedLabel(null);
    setSaveError("");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-12 font-sans text-[var(--text)]">
      <div className="w-full max-w-[420px] min-w-0">
        <div className="panel">
          <Link href="/" className="mb-8 flex items-center gap-3 text-[var(--text)] hover:no-underline">
            <Image
              src="/logo1.png"
              alt="AgentFlow"
              width={36}
              height={36}
              className="h-9 w-9 rounded-[4px]"
            />
            <span className="text-lg font-semibold tracking-[-0.01em]">AgentFlow</span>
          </Link>

          <h1 className="mb-1 text-2xl font-semibold tracking-[-0.015em]">Welcome to AgentFlow</h1>
          <p className="mb-6 text-sm text-[var(--muted)]">
            Two quick steps, then you are in. Nothing here is required — you can
            skip and come back any time.
          </p>

          {/* Step 1 — bring your key */}
          <section aria-labelledby="welcome-step-1" className="space-y-4">
            <div>
              <h2 id="welcome-step-1" className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
                Step 1 — Bring your key
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">
                AgentFlow ships with no AI keys of its own, so you bring yours.
                That way the site owner never pays for your AI use.
              </p>
            </div>

            <ProviderKeyField
              provider={provider}
              onProviderChange={handleProviderChange}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              baseUrl={baseUrl}
              onBaseUrlChange={setBaseUrl}
              model={customModel}
              onModelChange={setCustomModel}
              idPrefix="welcome"
            />

            {savedLabel && (
              <p className="status-line">
                <span className="lamp lamp-ok" />
                {savedLabel}
              </p>
            )}
            {saveError && (
              <p className="status-line" role="alert">
                <span className="lamp lamp-danger" />
                {saveError}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {saved ? (
                <button
                  type="button"
                  className="btn btn-primary flex-1 justify-center"
                  onClick={() => markSeenAndGo(router)}
                >
                  Continue to the dashboard
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary flex-1 justify-center"
                  onClick={handleSave}
                  disabled={saving || authLoading || !apiKey.trim()}
                >
                  {saving ? "Saving…" : signedIn ? "Save key to your account" : "Save key in this browser"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => markSeenAndGo(router)}
              >
                Skip
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--muted)]">
              {signedIn
                ? "Saved keys are locked away on your account, and only used when your agents run."
                : "A guest key stays in this browser only — it is never sent to the site's server except with a request that needs it."}{" "}
              Without a key the site still works, with plain template answers.
            </p>
          </section>

          <div className="my-6 h-[1px] bg-[var(--border)]" />

          {/* Step 2 — how to use the site */}
          <section aria-labelledby="welcome-step-2">
            <h2 id="welcome-step-2" className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
              Step 2 — How to use the site
            </h2>
            <ol className="mt-3 space-y-3">
              {JOURNEY.map((step, i) => (
                <li key={step.href} className="flex gap-3 min-w-0">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] border border-[var(--border)] text-[10px] font-semibold text-[var(--accent)]">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <Link href={step.href} className="text-[13px] font-semibold text-[var(--text)]">
                      {step.title}
                    </Link>
                    <span className="block text-[12px] leading-relaxed text-[var(--muted)]">
                      {step.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
