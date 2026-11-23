"use client";

import * as React from "react";
import { Key, Bell, Server, Plus, Trash2, Copy, Loader2, Users } from "lucide-react";

import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { getProviderPreset } from "@/lib/llmProviders";
import { ProviderKeyField } from "@/components/byok/ProviderKeyField";

type SystemInfo = {
  environment: string;
  region: string | null;
  runtime: string;
  appUrl: string;
  serverTime: string;
  database: { status: "connected" } | { status: "error"; message: string };
  vectorIndex: { name: string; state: string; queryable: boolean } | null;
  embedding: { model: string; dimension: number };
};

type PersonalKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

function PanelHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3 mb-6">
      <span className="text-[var(--muted)] shrink-0">{icon}</span>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">{title}</h3>
        <p className="text-[11px] text-[var(--muted)]">{subtitle}</p>
      </div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-[var(--border)] last:border-0">
      <span className="text-[var(--muted)] shrink-0">{label}</span>
      <span className="text-[var(--text)] font-medium text-right break-all">{children}</span>
    </div>
  );
}

/** The populated System card body. */
function SystemDetails({ system }: { system: SystemInfo }) {
  const isProduction = system.environment === "production";

  return (
    <div className="text-xs">
      <MetaRow label="Where this runs">
        <span className="status-line">
          <span className={`lamp ${isProduction ? "lamp-ok" : "lamp-paused"}`} />
          {isProduction ? "Live" : system.environment}
        </span>
      </MetaRow>
      <MetaRow label="Location">{system.region || "On this computer"}</MetaRow>
      <MetaRow label="Software">{system.runtime}</MetaRow>
      <MetaRow label="Web address">
        <a href={system.appUrl} className="text-[var(--accent)] hover:underline font-mono text-[11px]">
          {system.appUrl}
        </a>
      </MetaRow>
      <MetaRow label="Saved data">
        {system.database.status === "connected" ? (
          <span className="status-line">
            <span className="lamp lamp-ok" />
            Connected
          </span>
        ) : (
          <span className="status-line" title={system.database.message}>
            <span className="lamp lamp-danger" />
            Unavailable
          </span>
        )}
      </MetaRow>
      <MetaRow label="File search">
        {system.vectorIndex ? (
          system.vectorIndex.queryable ? (
            <span className="status-line" title={system.vectorIndex.name}>
              <span className="lamp lamp-ok" />
              Ready
            </span>
          ) : (
            <span className="status-line" title={system.vectorIndex.name}>
              <span className="lamp lamp-paused" />
              {system.vectorIndex.state}
            </span>
          )
        ) : (
          <span className="text-[var(--muted)]">Unknown</span>
        )}
      </MetaRow>
      <MetaRow label="File reader">
        <span>Built-in reader</span>
      </MetaRow>
    </div>
  );
}

export default function SettingsPage() {
  // Personal API Keys
  const [personalKeys, setPersonalKeys] = React.useState<PersonalKey[]>([]);
  const [newKey, setNewKey] = React.useState<{ key: string; name: string } | null>(null);
  const [keyName, setKeyName] = React.useState("");
  const [isGeneratingKey, setIsGeneratingKey] = React.useState(false);
  const [keyError, setKeyError] = React.useState("");

  // Your AI keys (keys for other AI services, saved on your account)
  const [byokProvider, setByokProvider] = React.useState("openrouter");
  const [byokKey, setByokKey] = React.useState("");
  const [byokBaseUrl, setByokBaseUrl] = React.useState("");
  const [byokModel, setByokModel] = React.useState("");
  const [savedByokProviders, setSavedByokProviders] = React.useState<string[]>([]);
  const [byokError, setByokError] = React.useState("");
  const [byokMessage, setByokMessage] = React.useState("");
  const [byokSaving, setByokSaving] = React.useState(false);

  // Notification Preferences
  const [emailNotifications, setEmailNotifications] = React.useState(false);
  const [inAppNotifications, setInAppNotifications] = React.useState(false);
  const [isUpdatingPrefs, setIsUpdatingPrefs] = React.useState(false);
  const [prefsMessage, setPrefsMessage] = React.useState("");

  // System status
  const [system, setSystem] = React.useState<SystemInfo | null>(null);
  const [systemLoading, setSystemLoading] = React.useState(true);
  const [systemError, setSystemError] = React.useState("");
  const [workspace, setWorkspace] = React.useState<{
    role?: string;
    permissions?: Record<string, boolean>;
    appearance?: { density?: string; accent?: string };
    defaults?: { topK?: number };
  } | null>(null);
  const [workspaceSaving, setWorkspaceSaving] = React.useState(false);

  React.useEffect(() => {
    const fetchSettings = async () => {
      const [keysRes, profileRes, systemRes, workspaceRes] = await Promise.all([
        fetch("/api/settings/api-keys").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/auth/profile").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/settings/system").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/settings/workspace").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);

      if (keysRes?.keys) setPersonalKeys(keysRes.keys);

      if (profileRes?.user?.preferences) {
        setEmailNotifications(Boolean(profileRes.user.preferences.emailNotifications));
        setInAppNotifications(Boolean(profileRes.user.preferences.inAppNotifications));
      }

      if (systemRes?.system) setSystem(systemRes.system);
      else setSystemError("System status is unavailable.");
      if (workspaceRes?.settings) setWorkspace(workspaceRes.settings);
      setSystemLoading(false);
    };
    fetchSettings();

    // Saved AI services. The list route may not exist in this build yet —
    // any failure just means an empty list, never a broken page.
    fetch("/api/keys")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.providers)) {
          setSavedByokProviders(data.providers.filter((p: unknown) => typeof p === "string"));
        }
      })
      .catch(() => undefined);
  }, []);

  const handleSaveByokKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!byokKey.trim() || byokSaving) return;
    setByokError("");
    setByokMessage("");
    setByokSaving(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: byokProvider,
          key: byokKey.trim(),
          ...(byokModel.trim() ? { model: byokModel.trim() } : {}),
          ...(byokBaseUrl.trim() ? { baseUrl: byokBaseUrl.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save that key");
      setSavedByokProviders((prev) =>
        prev.includes(byokProvider) ? prev : [...prev, byokProvider],
      );
      setByokKey("");
      setByokMessage("Saved.");
    } catch (err) {
      setByokError(err instanceof Error ? err.message : "Failed to save that key");
    } finally {
      setByokSaving(false);
    }
  };

  const handleRemoveByokProvider = async (id: string) => {
    setByokError("");
    try {
      const res = await fetch(`/api/keys?provider=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove that key");
      }
      setSavedByokProviders((prev) => prev.filter((p) => p !== id));
      setByokMessage("Removed.");
    } catch (err) {
      setByokError(err instanceof Error ? err.message : "Failed to remove that key");
    }
  };

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError("");
    setNewKey(null);
    setIsGeneratingKey(true);

    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName || "Untitled password" }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Failed to make an app password");

      setPersonalKeys((prev) => [data.keyRecord, ...prev]);
      setNewKey({ key: data.key, name: data.keyRecord.name });
      setKeyName("");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to make an app password");
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    setKeyError("");
    try {
      const res = await fetch(`/api/settings/api-keys?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to turn off that app password");
      }
      setPersonalKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to turn off that app password");
    }
  };

  const handleTogglePreference = async (type: "email" | "inApp", val: boolean) => {
    // The value before this tap, so a failed save can put the switch back.
    const prev = type === "email" ? emailNotifications : inAppNotifications;
    if (type === "email") setEmailNotifications(val);
    else setInAppNotifications(val);

    setIsUpdatingPrefs(true);
    setPrefsMessage("");
    try {
      const prefs = {
        emailNotifications: type === "email" ? val : emailNotifications,
        inAppNotifications: type === "inApp" ? val : inAppNotifications,
      };

      const res = await fetch("/api/auth/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "updateProfile", preferences: prefs }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) throw new Error(data.error || "Failed to save preferences");
      setPrefsMessage("Saved.");
    } catch (err) {
      if (type === "email") setEmailNotifications(prev);
      else setInAppNotifications(prev);
      setPrefsMessage(err instanceof Error ? err.message : "Failed to save preferences");
    } finally {
      setIsUpdatingPrefs(false);
    }
  };

  const saveWorkspace = async (next: Record<string, unknown>) => {
    setWorkspaceSaving(true);
    try {
      const res = await fetch('/api/settings/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save workspace settings');
      setWorkspace(data.settings || next);
    } catch (err) {
      console.error(err);
    } finally {
      setWorkspaceSaving(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left">
        <div className="space-y-1">
          <h2 className="font-h1 font-bold text-[var(--text)]">Settings</h2>
          <p className="text-xs text-[var(--muted)]">Change how AgentFlow works for you. Everyday choices are at the top; the technical ones are under Advanced below.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          <div className="lg:col-span-2 space-y-6 min-w-0">
            {/* Notification Preferences */}
            <div className="panel">
              <PanelHeader
                icon={<Bell className="icon-lg" />}
                title="Notifications"
                subtitle="How you hear about what happens."
              />

              <div className="space-y-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={emailNotifications}
                    onChange={(e) => handleTogglePreference("email", e.target.checked)}
                    disabled={isUpdatingPrefs}
                    className="w-4 h-4 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block text-sm font-medium text-[var(--text)]">Email notifications</span>
                    <span className="block text-xs text-[var(--muted)]">Receive important updates via email.</span>
                  </span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={inAppNotifications}
                    onChange={(e) => handleTogglePreference("inApp", e.target.checked)}
                    disabled={isUpdatingPrefs}
                    className="w-4 h-4 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block text-sm font-medium text-[var(--text)]">In-app notifications</span>
                    <span className="block text-xs text-[var(--muted)]">Show notifications inside the dashboard.</span>
                  </span>
                </label>

                <div className="h-4 text-[11px] text-[var(--accent)]">{prefsMessage}</div>
              </div>
            </div>

            {/* Advanced — developer surfaces, grouped out of the everyday path. */}
            <div id="advanced" className="pt-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">Advanced</h3>
              <p className="text-[11px] text-[var(--muted)] mt-1 leading-relaxed">
                For connecting other apps and checking the technical details. Most
                people never need anything here.
              </p>
            </div>

            {/* Personal API Keys */}
            <div className="panel" id="api-keys">
              <PanelHeader
                icon={<Key className="icon-lg" />}
                title="App passwords"
                subtitle="A password that lets another app use AgentFlow for you. Make one here, copy it once, and keep it safe — you will not see it again."
              />

              {keyError && <div className="notice notice-danger mb-4">{keyError}</div>}

              {newKey && (
                <div className="border border-[var(--border-strong)] bg-[var(--surface-2)] rounded-[4px] p-4 mb-6">
                  <h4 className="text-sm font-semibold text-[var(--text)] mb-1">Your new app password: {newKey.name}</h4>
                  <p className="text-xs text-[var(--muted)] mb-3">Copy this password now. You will not be able to see it again!</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--border)] rounded-[2px] p-2 text-xs font-mono break-all select-all">{newKey.key}</code>
                    <button type="button" className="btn btn-secondary" onClick={() => navigator.clipboard.writeText(newKey.key)} aria-label="Copy app password">
                      <Copy className="icon-sm" />
                    </button>
                  </div>
                </div>
              )}

              <form onSubmit={handleGenerateKey} className="flex flex-col sm:flex-row gap-3 sm:items-end mb-6">
                <div className="flex-1 min-w-0 space-y-1.5">
                  <label htmlFor="key-name" className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">
                    Name (optional)
                  </label>
                  <input
                    id="key-name"
                    className="input"
                    placeholder="e.g. My other app"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                  />
                </div>
                <button type="submit" disabled={isGeneratingKey} className="btn btn-primary shrink-0">
                  {isGeneratingKey && <Loader2 className="icon-sm mr-2 animate-spin" />}
                  <Plus className="icon-sm mr-2" />
                  Make a new password
                </button>
              </form>

              <div className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)] mb-2">Your app passwords ({personalKeys.length} of 5)</h4>
                {personalKeys.length === 0 ? (
                  <p className="text-xs text-[var(--muted)]">You have no app passwords yet. Make one above if another app needs to talk to AgentFlow.</p>
                ) : (
                  personalKeys.map((key) => (
                    <div key={key.id} className="ruled-row flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--text)]">{key.name}</div>
                        <div className="text-[11px] text-[var(--muted)] font-mono break-all">{key.prefix}</div>
                      </div>
                      <div className="flex items-center gap-4 flex-wrap">
                        <div className="text-[11px] text-[var(--muted)] sm:text-right font-mono">
                          <div>Created: {new Date(key.createdAt).toLocaleDateString()}</div>
                          <div>Last used: {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}</div>
                        </div>
                        <button type="button" className="btn btn-ghost text-[var(--danger)]" onClick={() => handleRevokeKey(key.id)} aria-label={`Revoke ${key.name}`}>
                          <Trash2 className="icon-sm" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Your AI keys — keys for OTHER AI services, not AgentFlow passwords. */}
            <div className="panel" id="ai-keys">
              <PanelHeader
                icon={<Key className="icon-lg" />}
                title="Your AI keys"
                subtitle="Keys for other AI services, so your agents can use them. These are not AgentFlow passwords — they belong to the AI services themselves."
              />

              {byokError && <div className="notice notice-danger mb-4">{byokError}</div>}

              <form onSubmit={handleSaveByokKey} className="space-y-4">
                <ProviderKeyField
                  provider={byokProvider}
                  onProviderChange={(id) => {
                    setByokProvider(id);
                    setByokMessage("");
                  }}
                  apiKey={byokKey}
                  onApiKeyChange={setByokKey}
                  baseUrl={byokBaseUrl}
                  onBaseUrlChange={setByokBaseUrl}
                  model={byokModel}
                  onModelChange={setByokModel}
                  idPrefix="settings"
                />
                <div className="flex items-center gap-3 flex-wrap">
                  <button type="submit" disabled={byokSaving || !byokKey.trim()} className="btn btn-primary">
                    {byokSaving && <Loader2 className="icon-sm mr-2 animate-spin" />}
                    Save key
                  </button>
                  {byokMessage && (
                    <span className="status-line">
                      <span className="lamp lamp-ok" />
                      {byokMessage}
                    </span>
                  )}
                </div>
              </form>

              <div className="space-y-3 mt-6">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)] mb-2">
                  Saved keys ({savedByokProviders.length})
                </h4>
                {savedByokProviders.length === 0 ? (
                  <p className="text-xs text-[var(--muted)]">
                    No AI keys saved yet. Pick a service above, paste your key, and save it.
                  </p>
                ) : (
                  savedByokProviders.map((id) => (
                    <div key={id} className="ruled-row flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--text)]">
                          {getProviderPreset(id)?.label ?? id}
                        </div>
                        <span className="status-line">
                          <span className="lamp lamp-ok" />
                          Saved
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost text-[var(--danger)]"
                        onClick={() => handleRemoveByokProvider(id)}
                        aria-label={`Remove ${getProviderPreset(id)?.label ?? id} key`}
                      >
                        <Trash2 className="icon-sm" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Roles & Customization */}
            <div className="panel">
              <PanelHeader
                icon={<Users className="icon-lg" />}
                title="Who can do what"
                subtitle="Choose what people in this workspace are allowed to do."
              />
              <div className="space-y-4 text-xs">
                <div className="space-y-1">
                  <label htmlFor="workspace-role" className="text-[var(--muted)]">Your role</label>
                  <select
                    id="workspace-role"
                    value={workspace?.role || 'admin'}
                    onChange={(e) => saveWorkspace({ ...(workspace || {}), role: e.target.value })}
                    disabled={workspaceSaving}
                    className="input"
                  >
                    <option value="admin">Admin — full access</option>
                    <option value="editor">Editor — create and edit</option>
                    <option value="viewer">Viewer — read only</option>
                  </select>
                  <p className="text-[11px] text-[var(--muted)]">
                    Viewer is for people who should only look at agents and results, not change anything.
                  </p>
                </div>
                <div className="space-y-2">
                  {([
                    ['canExecute', 'Run agents'],
                    ['canDeploy', 'Make agents live'],
                    ['canManageKeys', 'Manage app passwords'],
                    ['canEditWorkflows', 'Change agent steps'],
                  ] as const).map(([field, label]) => (
                    <label key={field} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(workspace?.permissions?.[field])}
                        onChange={(e) => saveWorkspace({
                          ...(workspace || {}),
                          permissions: { ...(workspace?.permissions || {}), [field]: e.target.checked },
                        })}
                        disabled={workspaceSaving}
                        className="w-4 h-4 accent-[var(--accent)]"
                      />
                      <span className="text-[11px]">{label}</span>
                    </label>
                  ))}
                </div>
                <div className="space-y-1">
                  <label htmlFor="workspace-density" className="text-[var(--muted)]">Spacing</label>
                  <select
                    id="workspace-density"
                    value={workspace?.appearance?.density || 'comfortable'}
                    onChange={(e) => saveWorkspace({
                      ...(workspace || {}),
                      appearance: { ...(workspace?.appearance || {}), density: e.target.value },
                    })}
                    disabled={workspaceSaving}
                    className="input"
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                  <p className="text-[11px] text-[var(--muted)]">
                    Comfortable leaves more space between things; compact packs more on the screen.
                  </p>
                </div>

                <div className="space-y-1">
                  <label htmlFor="workspace-topk" className="text-[var(--muted)]">How many file pieces to read when answering</label>
                  <select
                    id="workspace-topk"
                    value={workspace?.defaults?.topK ?? 3}
                    onChange={(e) => saveWorkspace({
                      ...(workspace || {}),
                      defaults: { ...(workspace?.defaults || {}), topK: Number(e.target.value) },
                    })}
                    disabled={workspaceSaving}
                    className="input"
                  >
                    {[1, 3, 5, 10].map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-[var(--muted)]">
                    When your agent answers from your files, this is how many pieces it
                    reads first. 3 is a good place to start.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6 min-w-0">
            {/* System */}
            <div className="panel" id="system">
              <PanelHeader
                icon={<Server className="icon-lg" />}
                title="System status"
                subtitle="Technical details about this AgentFlow setup."
              />

              {systemLoading ? (
                <p className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <Loader2 className="icon-xs animate-spin" />
                  Loading system status…
                </p>
              ) : systemError ? (
                <p className="text-xs text-[var(--danger)]">{systemError}</p>
              ) : system ? (
                <SystemDetails system={system} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
