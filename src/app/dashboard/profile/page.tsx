"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, User, Shield, Lock, Loader2 } from "lucide-react";


import { DashboardLayout } from "@/components/layout/DashboardLayout";

type ProfileResponse = {
  user?: {
    id: string;
    email?: string;
    fullName?: string;
    avatarUrl?: string | null;
    preferences?: Record<string, unknown>;
    emailVerified?: boolean;
  };
};

type Preferences = {
  marketingEmails?: boolean;
};

function Field({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">{label}</label>
      {children}
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();

  const [loading, setLoading] = React.useState(true);

  const [profileName, setProfileName] = React.useState("");
  const [profileEmail, setProfileEmail] = React.useState("");
  const [avatarBase64, setAvatarBase64] = React.useState<string>("");
  const [preferences, setPreferences] = React.useState<Preferences>({ marketingEmails: false });

  // Manage Profile
  const [isSaving, setIsSaving] = React.useState(false);
  const [isSaved, setIsSaved] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState<string>("");
  const [statusError, setStatusError] = React.useState<string>("");

  // Change Password
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [isChangingPassword, setIsChangingPassword] = React.useState(false);
  const [passwordStatusMessage, setPasswordStatusMessage] = React.useState("");
  const [passwordStatusError, setPasswordStatusError] = React.useState("");
  React.useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch("/api/auth/profile");
        const data = (await res.json().catch(() => ({}))) as ProfileResponse;

        if (!data.user) {
          router.push("/login");
          return;
        }

        setProfileName(data.user.fullName || "");
        setProfileEmail(data.user.email || "");
        setAvatarBase64(data.user.avatarUrl || "");
        setPreferences({ marketingEmails: Boolean(data.user.preferences?.marketingEmails) });
      } catch {
        router.push("/login");
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [router]);

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });

  const refreshProfile = async () => {
    const res = await fetch("/api/auth/profile");
    const data = (await res.json().catch(() => ({}))) as ProfileResponse;
    if (!data.user) return;

    setProfileName(data.user.fullName || "");
    setProfileEmail(data.user.email || "");
    setAvatarBase64(data.user.avatarUrl || "");
    setPreferences({ marketingEmails: Boolean(data.user.preferences?.marketingEmails) });
  };


  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusError("");
    setStatusMessage("");
    setIsSaving(true);

    try {
      const nextAvatar = avatarBase64;

      const res = await fetch("/api/auth/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateProfile",
          fullName: profileName,
          email: profileEmail,
          avatarBase64: nextAvatar || undefined,
          preferences,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        message?: string
        emailChangePendingVerification?: boolean
      };

      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to save profile");
      }

      if (data.emailChangePendingVerification) {
        setStatusMessage(data.message || "Email changed. Verify your new email address.");
      } else {
        setStatusMessage("Profile updated successfully.");
      }

      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2500);

      await refreshProfile();
    } catch (err: unknown) {
      setStatusError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordStatusError("");
    setPasswordStatusMessage("");

    if (newPassword !== confirmPassword) {
      setPasswordStatusError("New passwords do not match.");
      return;
    }

    setIsChangingPassword(true);

    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to change password");
      }

      setPasswordStatusMessage("Password updated successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setPasswordStatusError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const onAvatarFileChange = async (file: File | null) => {
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setStatusError("Your photo must be under 2MB");
      return;
    }

    const isPng = file.type === "image/png";
    const isJpg = file.type === "image/jpeg" || file.type === "image/jpg";
    if (!isPng && !isJpg) {
      setStatusError("Your photo must be JPG or PNG");
      return;
    }

    setStatusError("");
    setStatusMessage("");

    const b64 = await fileToBase64(file);
    setAvatarBase64(b64);
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64 gap-3">
          <Loader2 className="icon-lg animate-spin text-[var(--accent)]" />
          <p className="text-[var(--muted)] text-xs">Loading your profile…</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left">
        <div className="space-y-1">
          <h2 className="font-h1 font-bold text-[var(--text)]">Your profile</h2>
          <p className="text-xs text-[var(--muted)]">Your name, email, photo, and password. Change anything here, then save.</p>
        </div>

        {statusError ? <div className="notice notice-danger">{statusError}</div> : null}
        {!statusError && statusMessage ? (
          <div className="notice">{statusMessage}</div>
        ) : null}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          <div className="lg:col-span-2 space-y-6 min-w-0">
            <div className="panel">
              <div className="flex items-center gap-3 mb-6">
                <span className="text-[var(--muted)] shrink-0">
                  <User className="icon-lg" />
                </span>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">About you</h3>
                  <p className="text-[11px] text-[var(--muted)]">Name, email, photo, and what we may email you about.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Full Name" id="profile-name">
                  <input
                    id="profile-name"
                    className="input"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    required
                  />
                </Field>

                <Field label="Email Address" id="profile-email">
                  <input
                    id="profile-email"
                    className="input"
                    type="email"
                    value={profileEmail}
                    onChange={(e) => setProfileEmail(e.target.value)}
                    required
                  />
                </Field>
              </div>

              <div className="mt-5 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">Photo</div>
                <div className="flex flex-col sm:flex-row items-start gap-4">
                  <div>
                    <div className="h-16 w-16 rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden flex items-center justify-center shrink-0">
                      {avatarBase64 ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={avatarBase64} alt="Your photo" className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-[var(--muted)] text-xs">No image</span>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 min-w-0 w-full">
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="block w-full text-xs text-[var(--muted)]"
                      onChange={(e) => onAvatarFileChange(e.target.files?.[0] || null)}
                    />
                    <p className="text-[11px] text-[var(--muted)] mt-1">Max 2MB. JPG/PNG only.</p>
                  </div>
                </div>
              </div>

              <div className="mt-6">
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">What we may email you about</div>
                <label className="mt-3 flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(preferences.marketingEmails)}
                    onChange={(e) => setPreferences((p) => ({ ...p, marketingEmails: e.target.checked }))}
                    className="w-4 h-4 accent-[var(--accent)]"
                  />
                  <span className="text-xs text-[var(--muted)]">News and offers by email</span>
                </label>
              </div>
            </div>

            <form onSubmit={handleSaveProfile}>
              <div className="panel space-y-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">Save Profile</h4>
                <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                  Name and photo changes apply straight away. If you change your email, we will ask you to confirm the new one first.
                </p>
                <div className="h-px bg-[var(--border)] w-full" />
                <button type="submit" className="btn btn-primary w-full" disabled={isSaving}>
                  {isSaving && <Loader2 className="icon-sm mr-1.5 animate-spin" />}
                  {isSaved ? (
                    <>
                      <Check className="icon-sm mr-1.5" />
                      Saved
                    </>
                  ) : (
                    "Save Changes"
                  )}
                </button>
              </div>
            </form>


          </div>

          <div className="space-y-6 min-w-0">
            <div className="notice">
              <div className="flex items-start gap-3">
                <Shield className="icon-lg text-[var(--accent)] flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h5 className="text-xs font-semibold text-[var(--text)]">Stored safely on this computer</h5>
                  <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                    AgentFlow keeps your passwords and keys on this computer. They are never sent anywhere else.
                  </p>
                </div>
              </div>
            </div>

            <form onSubmit={handleChangePassword}>
              <div className="panel space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <Lock className="icon-sm text-[var(--muted)]" />
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">Change Password</h4>
                </div>

                {passwordStatusError ? <div className="notice notice-danger">{passwordStatusError}</div> : null}
                {!passwordStatusError && passwordStatusMessage ? (
                  <div className="notice">{passwordStatusMessage}</div>
                ) : null}

                <div className="space-y-3">
                  <Field label="Current Password" id="current-password">
                    <input
                      id="current-password"
                      className="input"
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="New Password" id="new-password">
                    <input
                      id="new-password"
                      className="input"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Confirm New Password" id="confirm-password">
                    <input
                      id="confirm-password"
                      className="input"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                    />
                  </Field>
                </div>
                <div className="h-px bg-[var(--border)] w-full mt-4 mb-2" />
                <button type="submit" className="btn btn-primary w-full" disabled={isChangingPassword}>
                  {isChangingPassword && <Loader2 className="icon-sm mr-1.5 animate-spin" />}
                  Update Password
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
