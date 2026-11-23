"use client";

import * as React from "react";
import Link from "next/link";
import { Copy, Check, ExternalLink, Loader2, Rocket } from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useBrowserOrigin } from "@/lib/useBrowserOrigin";

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  createdAt?: string;
  lastUsedAt?: string | null;
};

type AgentRow = { _id: string; name: string; status?: string };

/**
 * Everything shown here is read from the workspace: the keys are the ones
 * actually issued and hashed by /api/settings/api-keys, the endpoint in the
 * example is the deployed origin, and the counts come from /api/agents. There
 * is no widget script and no custom domain because neither exists.
 */
export default function DeploymentCenterPage() {
  const [keys, setKeys] = React.useState<ApiKeyRow[]>([]);
  const [agents, setAgents] = React.useState<AgentRow[]>([]);
  const origin = useBrowserOrigin();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [copiedText, setCopiedText] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [keysRes, agentsRes] = await Promise.all([
          fetch("/api/settings/api-keys", { credentials: "include" }),
          fetch("/api/agents", { credentials: "include" }),
        ]);
        if ([keysRes, agentsRes].some((response) => response.status === 401)) {
          throw new Error("Your session has expired. Please log in again.");
        }
        if ([keysRes, agentsRes].some((response) => !response.ok)) {
          throw new Error("Deployment details could not be loaded.");
        }
        const [keysData, agentsData] = await Promise.all([keysRes.json(), agentsRes.json()]);
        if (cancelled) return;
        setKeys(Array.isArray(keysData?.keys) ? keysData.keys : []);
        setAgents(Array.isArray(agentsData) ? agentsData : []);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load deployment details.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  const exampleAgentId = agents[0]?._id ?? "<your-agent-id>";

  const apiSnippet = `curl -X POST ${origin || "https://fypagent.vercel.app"}/api/execute \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"agentId": "${exampleAgentId}", "input": "Hello Agent"}'`;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left">
        {/* Header */}
        <div className="space-y-1">
          <h2 className="font-h1 font-bold text-[var(--text)] flex items-center gap-2">
            <Rocket className="icon-lg text-[var(--accent)]" />
            Make it live
          </h2>
          <p className="text-xs text-muted">
            Use your helpers from outside the dashboard with an app password. App passwords are stored safely and
            can be turned off at any time from Settings.
          </p>
        </div>

        {error && <div className="notice notice-danger" role="alert">{error}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          <div className="lg:col-span-2 space-y-6">
            {/* Real keys */}
            <Card className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="space-y-0.5 flex-1">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
                    App passwords
                  </h3>
                  <p className="text-[10px] text-muted">
                    The full password is shown once when you make it. Only a scrambled copy is kept.
                  </p>
                </div>
                <Link href="/dashboard/settings">
                  <Button variant="secondary" size="sm">
                    Manage app passwords
                    <ExternalLink className="icon-xs ml-1.5" />
                  </Button>
                </Link>
              </div>

              {loading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
                  <Loader2 className="icon-sm animate-spin" />
                  Loading app passwords…
                </div>
              ) : keys.length === 0 ? (
                <div className="border-y border-[var(--border)] px-4 py-5 text-center">
                  <p className="text-xs font-semibold text-foreground">No app passwords yet</p>
                  <p className="mt-1 text-[11px] text-muted">
                    Make one in Settings — it will be shown there exactly once.
                  </p>
                  <Link href="/dashboard/settings" className="mt-3 inline-block">
                    <Button size="sm">Make an app password</Button>
                  </Link>
                </div>
              ) : (
                <div className="border-t border-[var(--border)]">
                  {keys.map((key) => (
                    <div
                      key={key.id}
                      className="ruled-row flex items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-foreground">{key.prefix}</p>
                        <p className="mt-0.5 text-[10px] text-muted">
                          {key.name} · last used{" "}
                          {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}
                        </p>
                      </div>
                      <span className="status-line shrink-0">
                        <span className="lamp lamp-ok" />
                        Active
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Real endpoint */}
            <Card className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="space-y-0.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
                    Run a helper from another app
                  </h3>
                  <p className="text-[10px] text-muted">
                    Send a message and say which helper should answer; you get back the helper&apos;s answer and the pages it
                    found in your files.
                  </p>
                </div>
              </div>

              <div className="relative font-mono text-[11px] bg-[var(--surface-2)] border border-[var(--border)] rounded-[2px] p-4 text-muted leading-relaxed">
                <pre className="overflow-x-auto">{apiSnippet}</pre>
                <button
                  type="button"
                  onClick={() => copyToClipboard(apiSnippet, "api_code")}
                  aria-label="Copy example request"
                  className="absolute right-3.5 top-3.5 p-1.5 rounded-[2px] text-muted hover:bg-[var(--row-hover)] hover:text-[var(--accent)] transition-colors"
                >
                  {copiedText === "api_code" ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
                </button>
              </div>

              <p className="mt-3 text-[10px] leading-relaxed text-muted">
                Requests are limited to 20 per minute, and an app password can only reach your own helpers. See{" "}
                <Link href="/docs" className="text-accent underline underline-offset-2">
                  the docs
                </Link>{" "}
                for what comes back and what can go wrong.
              </p>
            </Card>
          </div>

          {/* Real status */}
          <div className="space-y-6">
            <Card className="p-5 space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text)]">Your setup</h4>
              <div className="border-t border-[var(--border)] w-full" />
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Agents</span>
                <span className="font-semibold text-foreground">{agents.length}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Active agents</span>
                <span className="font-semibold text-foreground">{activeAgents}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">App passwords</span>
                <span className="font-semibold text-foreground">{keys.length}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Address</span>
                <span className="font-mono text-[10px] text-accent truncate max-w-[140px]">POST /api/execute</span>
              </div>
            </Card>

            <Card className="p-5 space-y-3.5 text-xs text-muted leading-relaxed">
              <h5 className="font-bold text-[var(--text)]">
                Abuse protection
              </h5>
              <p>
                Every request has a limit per caller, wrong passwords are counted separately, and an app password
                can only reach the helpers in your account — never anyone else&apos;s.
              </p>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
