"use client";

import * as React from "react";
import { Check, Clock, Mail, Send } from "lucide-react";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";

export default function ContactPage() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSent, setIsSent] = React.useState(false);

  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, subject, message }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to send message");
      }

      setIsSent(true);
      setName("");
      setEmail("");
      setSubject("");
      setMessage("");

      setTimeout(() => setIsSent(false), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send message";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1120px] px-4 py-12 font-sans text-[var(--text)] sm:px-6">
        <header className="max-w-2xl border-b border-[var(--border)] pb-8">
          <h1 className="mb-4 text-3xl font-semibold tracking-[-0.015em] sm:text-4xl">Contact Support</h1>
          <p className="text-sm leading-relaxed text-[var(--muted)]">
            Questions about using AgentFlow, or about connecting your own files and apps? Send us a message.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-x-12 md:grid-cols-3">
          <div className="panel p-4 sm:p-6 md:col-span-2">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Name"
                  placeholder="John Doe"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
                <Input
                  label="Email"
                  type="email"
                  placeholder="name@company.com"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <Input
                label="Subject"
                placeholder="How do I add my own files?"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
              <Textarea
                label="Message"
                placeholder="Tell us what you tried and what happened..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
              />
              <Button type="submit" className="w-full justify-center" isLoading={isLoading}>
                {isSent ? (
                  <>
                    <Check className="icon-sm" aria-hidden />
                    Sent Successfully!
                  </>
                ) : (
                  <>
                    <Send className="icon-sm" aria-hidden />
                    Send Inquiry Message
                  </>
                )}
              </Button>

              {error && (
                <p className="notice notice-danger text-center" role="alert">
                  {error}
                </p>
              )}
            </form>
          </div>

          <aside className="py-8">
            <div className="ruled-row flex-col items-start gap-1">
              <h2 className="flex items-center gap-2 text-xs font-semibold">
                <Mail className="icon-sm text-[var(--accent)]" aria-hidden />
                Email Channels
              </h2>
              <p className="font-mono text-xs text-[var(--muted)]">support@agentflow.ai</p>
              <p className="font-mono text-xs text-[var(--muted)]">info@agentflow.ai</p>
            </div>
            <div className="ruled-row flex-col items-start gap-1">
              <h2 className="flex items-center gap-2 text-xs font-semibold">
                <Clock className="icon-sm text-[var(--accent)]" aria-hidden />
                Response Queue
              </h2>
              <p className="text-xs leading-relaxed text-[var(--muted)]">
                We usually reply to all messages within 24 business hours.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </PublicLayout>
  );
}
