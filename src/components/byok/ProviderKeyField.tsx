"use client";

import * as React from "react";
import { Globe, Key, Loader2 } from "lucide-react";
import { LLM_PROVIDERS, getProviderPreset } from "@/lib/llmProviders";
import { AppMark } from "@/components/icons/app-icons";

/**
 * The shared AI-key field: provider selector + key input + Check key.
 * Used by the create-agent page (Step 2) and Settings ("Your AI keys") so
 * both stay on the one preset registry (src/lib/llmProviders.ts).
 *
 * Hand-drawn marks exist for OpenRouter, NVIDIA, Hugging Face and Moonshot
 * only — every other preset gets a plain Key (Custom gets a Globe). No brand
 * mark is ever invented here.
 */

// Presets with a hand-drawn mark in src/components/icons/app-icons.tsx.
const BRAND_MARKS = new Set(["openrouter", "nvidia", "huggingface", "moonshot"]);

export type ProviderKeyFieldProps = {
  provider: string;
  onProviderChange: (id: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  /** Prefix for element ids, so the two uses on different pages never clash. */
  idPrefix: string;
};

export function ProviderKeyField({
  provider,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  baseUrl,
  onBaseUrlChange,
  model,
  onModelChange,
  idPrefix,
}: ProviderKeyFieldProps) {
  const [showKey, setShowKey] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  const preset = getProviderPreset(provider) ?? LLM_PROVIDERS[0];

  const pickProvider = (id: string) => {
    setCheckResult(null);
    onProviderChange(id);
  };

  const handleCheck = async () => {
    if (!apiKey.trim()) {
      setCheckResult({ ok: false, message: "Enter your key first." });
      return;
    }
    setChecking(true);
    setCheckResult(null);
    try {
      const body: Record<string, string> = { provider: preset.id, key: apiKey.trim() };
      if (preset.needsBaseUrl && baseUrl.trim()) body.baseUrl = baseUrl.trim();
      if (preset.needsModel && model.trim()) body.model = model.trim();
      const res = await fetch("/api/settings/llm-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setCheckResult({ ok: true, message: "That key works." });
      } else if (res.status === 404) {
        // The check route is not in this build yet — the key itself is
        // still usable; only the check is unavailable.
        setCheckResult({ ok: false, message: "Key checking is not available yet." });
      } else {
        setCheckResult({
          ok: false,
          message:
            typeof data?.error === "string" && data.error.trim()
              ? data.error
              : "That key did not work.",
        });
      }
    } catch {
      setCheckResult({ ok: false, message: "Could not check the key right now. Try again." });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Provider selector — every preset in the shared registry. */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-semibold text-[var(--muted)]">AI service</label>
        <div className="grid grid-cols-2 gap-1.5">
          {LLM_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickProvider(p.id)}
              aria-pressed={provider === p.id}
              className={[
                "text-[10px] font-semibold px-2 py-1.5 rounded-[2px] border transition-all flex items-center gap-1.5 text-left",
                provider === p.id
                  ? "border-[var(--accent)] bg-[var(--surface-2)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {BRAND_MARKS.has(p.id) ? (
                <AppMark markKey={p.id} className="icon-xs shrink-0" />
              ) : p.id === "custom" ? (
                <Globe className="icon-xs shrink-0" />
              ) : (
                <Key className="icon-xs shrink-0" />
              )}
              {/* The grid is two narrow columns: the Custom preset's full
                  label ("Custom (OpenAI-compatible)") truncates to
                  "Custom (OpenAI-c…", so the button shows the short name.
                  The full meaning stays in the help text below. */}
              <span className="min-w-0 truncate">{p.id === "custom" ? "Custom" : p.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Base URL + model — only the Custom preset asks for these. */}
      {preset.needsBaseUrl && (
        <div className="space-y-1.5">
          <label htmlFor={`${idPrefix}-base-url`} className="text-[10px] font-semibold text-[var(--muted)]">
            Web address
          </label>
          <input
            id={`${idPrefix}-base-url`}
            type="text"
            className="input font-mono"
            placeholder="https://your-service.example.com/v1"
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      {preset.needsModel && (
        <div className="space-y-1.5">
          <label htmlFor={`${idPrefix}-model`} className="text-[10px] font-semibold text-[var(--muted)]">
            Model
          </label>
          <input
            id={`${idPrefix}-model`}
            type="text"
            className="input font-mono"
            placeholder="Model name, e.g. gpt-4o-mini"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}

      {/* Key input */}
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-api-key`} className="text-[10px] font-semibold text-[var(--muted)]">
          Your key
        </label>
        <div className="relative">
          <input
            id={`${idPrefix}-api-key`}
            type={showKey ? "text" : "password"}
            className="input pr-16 font-mono"
            placeholder={preset.placeholder}
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--muted)] hover:text-[var(--text)] px-1.5 py-0.5 rounded-[2px]"
          >
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
        <p className="text-[10px] text-[var(--muted)] leading-relaxed">
          {preset.keyHelp}{" "}
          {preset.keyUrl && (
            <a
              href={preset.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              Where to get a key
            </a>
          )}
        </p>
      </div>

      {/* Check key */}
      <div className="space-y-1.5">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleCheck}
          disabled={checking || !apiKey.trim()}
        >
          {checking && <Loader2 className="icon-xs mr-1.5 animate-spin" />}
          Check key
        </button>
        {checkResult && (
          <p className="status-line">
            <span className={`lamp ${checkResult.ok ? "lamp-ok" : "lamp-danger"}`} />
            {checkResult.message}
          </p>
        )}
      </div>
    </div>
  );
}
