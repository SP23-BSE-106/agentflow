"use client";

import * as React from "react";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { ArrowLeftRight, BookOpen, Check, Copy, KeyRound, Layers, Play, Rocket, TriangleAlert } from "lucide-react";
import { useBrowserOrigin } from "@/lib/useBrowserOrigin";

const ERROR_ROWS = [
  { code: "400 Bad Request", detail: "Missing or malformed fields — `input` and `agentId` are required." },
  { code: "401 Unauthorized", detail: "Missing, empty or unknown API key, or an expired session cookie." },
  { code: "404 Not Found", detail: "The agent id does not exist, or it belongs to another workspace." },
  { code: "429 Too Many Requests", detail: "More than 20 requests in a minute; wait and retry." },
  { code: "502 Bad Gateway", detail: "No inference provider accepted the request. Nothing was executed." },
];

/**
 * Documents only endpoints that exist in this repository. Snippets are built
 * from the running origin so the examples a reader copies are the requests
 * that actually work against their deployment.
 */
export default function DocsPage() {
  const [copiedText, setCopiedText] = React.useState<string | null>(null);
  const origin = useBrowserOrigin();

  const copyCode = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const endpointUrl = `${origin || "https://fypagent.vercel.app"}/api/execute`;

  const curlSnippet = `curl -X POST ${endpointUrl} \\
  -H "Authorization: Bearer sk_live_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agentId": "665f0c1e8b3f2a0012345678",
    "input": "What is the Pro plan price?"
  }'`;

  const responseSnippet = `{
  "executed": true,
  "agentId": "665f0c1e8b3f2a0012345678",
  "agentName": "Support Triage Agent",
  "output": "The Pro demo plan costs $19 per month; mock payments activate 30 days of access.",
  "model": "openai/gpt-4o",
  "provider": "OpenRouter (GPT-4o)",
  "sources": [
    { "text": "Pro costs $19 per month in the mock payment demo.", "similarity": 0.81 }
  ],
  "executedAt": "2026-09-30T12:04:11.208Z"
}`;

  const inputSnippet = `{
  "agentId": "665f0c1e8b3f2a0012345678",
  "input": "What is the Pro plan price for billing?",
  "topK": 3
}`;

  const errorSnippet = `{
  "error": "Invalid API key."
}`;

  const codeBlock =
    "relative rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] p-4 font-mono text-[11px] leading-relaxed text-[var(--muted)]";
  const copyButton =
    "absolute right-3 top-3 rounded-[2px] p-1.5 text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)]";

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1120px] px-4 py-12 font-sans text-[var(--text)] sm:px-6">
        <div className="flex flex-col gap-12 lg:flex-row">
          {/* Left Docs Navigation */}
          <aside className="w-full shrink-0 space-y-6 lg:w-60">
            <nav className="space-y-1" aria-label="Getting started">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">Getting Started</h2>
              <ul className="list-none space-y-2 p-0 text-xs">
                <li>
                  <a href="#overview" className="inline-flex items-center gap-2 font-semibold">
                    <BookOpen className="icon-xs text-[var(--accent)]" aria-hidden />
                    Overview
                  </a>
                </li>
                <li>
                  <a href="#auth" className="inline-flex items-center gap-2 text-[var(--muted)] hover:text-[var(--text)]">
                    <KeyRound className="icon-xs text-[var(--accent)]" aria-hidden />
                    Authentication
                  </a>
                </li>
                <li>
                  <a href="#quickstart" className="inline-flex items-center gap-2 text-[var(--muted)] hover:text-[var(--text)]">
                    <Rocket className="icon-xs text-[var(--accent)]" aria-hidden />
                    Quickstart Guide
                  </a>
                </li>
                <li>
                  <a href="#core-concepts" className="inline-flex items-center gap-2 text-[var(--muted)] hover:text-[var(--text)]">
                    <Layers className="icon-xs text-[var(--accent)]" aria-hidden />
                    Core Concepts
                  </a>
                </li>
              </ul>
            </nav>

            <nav className="space-y-1" aria-label="API reference">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">API Reference</h2>
              <ul className="list-none space-y-2 p-0 text-xs">
                <li>
                  <a href="#trigger" className="inline-flex items-center gap-2 text-[var(--muted)] hover:text-[var(--text)]">
                    <Play className="icon-xs text-[var(--accent)]" aria-hidden />
                    Run an Agent
                  </a>
                </li>
                <li>
                  <a href="#examples" className="inline-flex items-center gap-2 text-[var(--muted)] hover:text-[var(--text)]">
                    <ArrowLeftRight className="icon-xs text-[var(--accent)]" aria-hidden />
                    Request/Response Examples
                  </a>
                </li>
                <li>
                  <a href="#errors" className="inline-flex items-center gap-2 text-[var(--muted)] hover:text-[var(--text)]">
                    <TriangleAlert className="icon-xs text-[var(--accent)]" aria-hidden />
                    Errors &amp; Limits
                  </a>
                </li>
              </ul>
            </nav>
          </aside>

          {/* Center Docs Content */}
          <div className="min-w-0 flex-1 space-y-12">
            {/* Overview */}
            <div id="overview" className="space-y-3 border-b border-[var(--border)] pb-8 scroll-mt-24">
              <h1 className="text-3xl font-semibold tracking-[-0.015em] sm:text-4xl">AgentFlow API Docs</h1>
              <p className="max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
                This page is for people connecting another app to AgentFlow. Send a message to one of your agents
                and get back an answer — plus the pieces of your files it used to answer. Each request is signed
                with a Workspace API key (a secret code that proves the request is yours) and the answer comes
                back as JSON (a standard format apps can read).
              </p>
              <p className="max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
                No account is needed to try AgentFlow itself: describe what you want, the AI builds the steps,
                edit them on the canvas, and test them in the sandbox — your work lives in your own browser.
                What still needs an account is saving a workflow to an account, uploading your files and
                chatting with them, app passwords and keys, approvals, and payments. The API key flow on this
                page is one of those account parts: it needs an account, and sign-up and sign-in wiring comes later.
              </p>

              <dl className="grid grid-cols-1 gap-x-6 pt-6 md:grid-cols-3">
                <div className="border-t border-[var(--border)] py-4">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">Endpoint</dt>
                  <dd className="mt-1 break-all font-mono text-sm">POST /api/execute</dd>
                </div>
                <div className="border-t border-[var(--border)] py-4">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">Auth</dt>
                  <dd className="mt-1 font-mono text-sm">Bearer {"<API_KEY>"}</dd>
                </div>
                <div className="border-t border-[var(--border)] py-4">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">Response</dt>
                  <dd className="mt-1 font-mono text-sm">JSON + sources[]</dd>
                </div>
              </dl>
            </div>

            {/* Authentication */}
            <div id="auth" className="space-y-4 border-b border-[var(--border)] pb-8 scroll-mt-24">
              <h2 className="text-xl font-semibold">Authentication</h2>
              <p className="max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
                Include a Workspace API key in the <span className="font-semibold text-[var(--accent)]">Authorization</span>{" "}
                header of your request — that is how the app knows the request is yours. Create one from the
                dashboard under Settings; you need an account for this, and the key flow is not part of the
                no-account loop. The full key is shown exactly once, so copy it then; only a scrambled
                copy (its SHA-256 hash) is stored.
              </p>

              <div className={codeBlock}>
                <pre className="overflow-x-auto">Authorization: Bearer {'<API_KEY>'}</pre>
                <button
                  type="button"
                  aria-label="Copy authorization header example"
                  onClick={() => copyCode("Authorization: Bearer <API_KEY>", "auth")}
                  className={copyButton}
                >
                  {copiedText === "auth" ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
                </button>
              </div>

              <p className="max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
                If the key is missing, empty or unknown the API returns a{" "}
                <span className="font-semibold text-[var(--accent)]">401</span> (not allowed). If you are already
                signed in on the dashboard, that session is also accepted — that is how the Make it live page
                previews requests.
              </p>
            </div>

            {/* Quickstart */}
            <div id="quickstart" className="space-y-4 border-b border-[var(--border)] pb-8 scroll-mt-24">
              <h2 className="text-xl font-semibold">Quickstart: Run an Agent</h2>
              <p className="max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
                Send (POST) an <span className="font-semibold text-[var(--accent)]">agentId</span> (which agent should
                answer) and your <span className="font-semibold text-[var(--accent)]">input</span> (your message). The
                agent is looked up for the key&apos;s own workspace — an id from another account returns 404 (not found).
              </p>

              <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
                <div className="space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">Shell curl request</span>
                  <div className={codeBlock}>
                    <pre className="overflow-x-auto">{curlSnippet}</pre>
                    <button
                      type="button"
                      aria-label="Copy curl example"
                      onClick={() => copyCode(curlSnippet, "curl")}
                      className={copyButton}
                    >
                      {copiedText === "curl" ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">JSON response payload</span>
                  <div className={codeBlock}>
                    <pre className="overflow-x-auto">{responseSnippet}</pre>
                    <button
                      type="button"
                      aria-label="Copy response example"
                      onClick={() => copyCode(responseSnippet, "resp")}
                      className={copyButton}
                    >
                      {copiedText === "resp" ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Core Concepts */}
            <div id="core-concepts" className="space-y-4 border-b border-[var(--border)] pb-8 scroll-mt-24">
              <h2 className="text-xl font-semibold">Core Concepts</h2>
              <ul className="max-w-3xl list-none space-y-3 p-0 text-xs leading-relaxed text-[var(--muted)]">
                <li className="border-t border-[var(--border)] pt-3">
                  <span className="font-semibold text-[var(--text)]">Agents</span>: a saved helper with its instructions,
                  AI provider and your files. Every run targets exactly one agent id.
                </li>
                <li className="border-t border-[var(--border)] pt-3">
                  <span className="font-semibold text-[var(--text)]">Your files</span>: documents you upload, split into
                  short pieces and searched by meaning, so the agent answers from your files.
                </li>
                <li className="border-t border-[var(--border)] pt-3">
                  <span className="font-semibold text-[var(--text)]">Sources</span>: the pieces of your files returned
                  alongside the answer, each with a match score, so you can check where an answer came from.
                </li>
                <li className="border-t border-[var(--border)] pt-3">
                  <span className="font-semibold text-[var(--text)]">Workflow</span>: the steps you drew on the canvas,
                  joined by lines. It is what you edit; without an account it is saved in your browser, and
                  saving it to an account needs a login. Running it today means the agent answers using
                  the files it found.
                </li>
              </ul>
            </div>

            {/* Trigger endpoint details */}
            <div id="trigger" className="space-y-4 border-b border-[var(--border)] pb-8 scroll-mt-24">
              <h2 className="text-xl font-semibold">Run an Agent</h2>
              <div className="border-t border-b border-[var(--border)] py-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">POST</div>
                    <div className="font-mono text-sm">/api/execute</div>
                  </div>
                  <div className="max-w-xl text-xs leading-relaxed text-[var(--muted)]">
                    Runs one question: finds the closest pieces of your files, then answers using them and the
                    agent&apos;s instructions. Returns a 502 error rather than a made-up answer if no AI provider responds.
                  </div>
                </div>
              </div>
            </div>

            {/* Request/Response Examples */}
            <div id="examples" className="space-y-4 border-b border-[var(--border)] pb-8 scroll-mt-24">
              <h2 className="text-xl font-semibold">Request/Response Examples</h2>
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <div className="space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">Request body</span>
                  <div className={codeBlock}>
                    <pre className="overflow-x-auto">{inputSnippet}</pre>
                    <button
                      type="button"
                      aria-label="Copy request body example"
                      onClick={() => copyCode(inputSnippet, "req")}
                      className={copyButton}
                    >
                      {copiedText === "req" ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--muted)]">
                    <span className="font-semibold text-[var(--text)]">topK</span> (default 3) sets how many pieces of
                    your files are looked up for the answer.
                  </p>
                </div>

                <div className="space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">Error payload</span>
                  <div className={codeBlock}>
                    <pre className="overflow-x-auto">{errorSnippet}</pre>
                    <button
                      type="button"
                      aria-label="Copy error payload example"
                      onClick={() => copyCode(errorSnippet, "err")}
                      className={copyButton}
                    >
                      {copiedText === "err" ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--muted)]">
                    When something goes wrong you always get an <span className="font-mono">error</span> message and a
                    status code that is not 2xx (not a success code).
                  </p>
                </div>
              </div>
            </div>

            {/* Errors & Limits */}
            <div id="errors" className="space-y-4 scroll-mt-24">
              <h2 className="text-xl font-semibold">Errors &amp; Limits</h2>

              <div className="overflow-x-auto">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Error</th>
                      <th>Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ERROR_ROWS.map((row) => (
                      <tr key={row.code}>
                        <td className="whitespace-nowrap font-mono text-xs font-semibold">{row.code}</td>
                        <td className="text-xs text-[var(--muted)]">{row.detail}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="whitespace-nowrap font-mono text-xs font-semibold">Workspace isolation</td>
                      <td className="text-xs text-[var(--muted)]">
                        Keys are scoped to their owner. Agents, documents and keys from other accounts are never visible,
                        even with a valid key.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
