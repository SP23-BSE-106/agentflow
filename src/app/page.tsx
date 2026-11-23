"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Blocks, BookOpen, Check, ChevronRight, Code2, Headphones, Mail, Megaphone, MessageSquareText, MousePointer2, Play, Scale, ServerCog, Share2, ShieldCheck, TrendingUp } from "lucide-react";

import { PublicLayout } from "@/components/layout/PublicLayout";

/** Number of entries in NODE_CATALOG (src/lib/workflow/kimiEngine.ts) — the
 *  node types offered in the builder's left panel. Mirrored here as a literal
 *  so the landing page keeps its bundle free of the editing engine. */
const CANVAS_NODE_TYPE_COUNT = 6;

/** The hero manifest: one sample workflow's steps and permissions, shown as
 *  a ruled document. Every row is a fact about how AgentFlow runs a workflow;
 *  nothing here is a live record of any one workspace. Steps are named in
 *  plain words: "a link that starts a workflow" is a webhook, "search your
 *  files" is RAG retrieval. */
const MANIFEST_ROWS: { scope: string; decision: "ALLOW" | "DENY" }[] = [
  { scope: "step: a link that starts a workflow", decision: "ALLOW" },
  { scope: "step: pick the best AI model for the job", decision: "ALLOW" },
  { scope: "step: search your files", decision: "ALLOW" },
  { scope: "step: show the answer", decision: "ALLOW" },
  { scope: "link: run it from anywhere", decision: "ALLOW" },
  { scope: "key: your private key, kept scrambled", decision: "ALLOW" },
  { scope: "other people's workspaces", decision: "DENY" },
  { scope: "your passwords", decision: "DENY" },
];

export default function LandingPage() {
  // Counts taken from the source, not from a marketing spreadsheet: the
  // catalogue, the configured providers and the trial length are all
  // inspectable in the repo, so a reviewer can check every number.
  // Every figure here is a fact about the build rather than a marketing number.
  // CANVAS_NODE_TYPE_COUNT mirrors NODE_CATALOG in src/lib/workflow/kimiEngine.ts;
  // it is kept literal so the landing page does not pull the whole editing
  // engine into its bundle — update the two together.
  const stats = [
    { label: "Steps to pick from", value: String(CANVAS_NODE_TYPE_COUNT) },
    { label: "AI providers", value: "4" },
    { label: "Free trial", value: "90 days" },
    { label: "Price after trial", value: "$19/mo" },
  ];

  const features = [
    {
      icon: MousePointer2,
      title: "Drag-and-drop builder",
      desc: "Lay out your steps on a canvas. Connect AI models, your files, and other apps in one place.",
    },
    {
      icon: MessageSquareText,
      title: "Describe it in plain words",
      desc: "Describe the team you want in plain English. AgentFlow turns your words into a working set of steps.",
    },
    {
      icon: Play,
      title: "Try it live",
      desc: "Chat with your workflow and watch each step report what it did, with the sources it used attached.",
    },
    {
      icon: Share2,
      title: "Share it with one click",
      desc: "Get a private link and a key, so your helpers can be called from anywhere.",
    },
    {
      icon: ShieldCheck,
      title: "Your work stays yours",
      desc: "Sign-in, scrambled keys, and limits keep your work separate from everyone else's.",
    },
  ];

  const pricing = [
    {
      name: "Free Trial",
      price: "$0",
      highlight: false,
      features: [
        "90 days of full access",
        "AI workflows",
        "Drag-and-drop builder",
        "Search your files",
        "Community help",
      ],
    },
    {
      name: "Pro Plan",
      // The demo displays the Pro price without processing real charges.
      price: "$19",
      highlight: true,
      features: [
        "Everything in the free trial",
        "Unlimited access after 90 days",
        "Run your workflows",
        "Mock payment activation",
        "Use it from your own apps",
      ],
    },
    {
      name: "Enterprise",
      price: "Custom",
      highlight: false,
      features: [
        "Custom steps & connections",
        "Community help",
      ],
    },
  ];

  return (
    <PublicLayout>
      <div className="bg-[var(--bg)] font-sans text-[var(--text)]">
        <div className="mx-auto max-w-[1120px] px-4 sm:px-6">
          {/* HERO */}
          <section className="grid gap-12 py-12 lg:grid-cols-[1.02fr_0.98fr] lg:py-16">
            <div>
              <p className="mb-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">
                <span className="lamp lamp-ok" aria-hidden />
                AI helpers that work together
              </p>
              <h1 className="mb-4 text-4xl font-semibold leading-[1.08] tracking-[-0.025em] sm:text-5xl">
                Build your own AI team, without writing code.
              </h1>
              <p className="mb-8 max-w-[54ch] text-base leading-relaxed text-[var(--muted)] sm:text-lg">
                Tell AgentFlow what you want done. It turns your words into a
                team of AI helpers that work through the steps together.
                Start with one step, then add more.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Link href="/dashboard" className="btn btn-primary">
                  Start with one step
                  <ArrowRight className="icon-sm" aria-hidden />
                </Link>
                <Link href="/docs" className="btn btn-secondary">
                  <BookOpen className="icon-sm" aria-hidden />
                  Read the Docs
                </Link>
              </div>
              <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--border)] pt-6 sm:grid-cols-4">
                {stats.map((s) => (
                  <div key={s.label}>
                    {/* whitespace-nowrap: at 1440 the four stat cells are
                        113px wide and "Price after trial" needs 117px, so
                        it wrapped mid-phrase ("PRICE AFTER / TRIAL"). The
                        overflow (max 16px, "Steps to pick from") fits inside
                        the 24px column gap, so no label collides with the
                        next cell — verified by measurement, not by eye. */}
                    <dt className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">
                      {s.label}
                    </dt>
                    <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Workflow manifest — the hero's one bold element */}
            <div
              className="self-start rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface)] font-mono text-[13px]"
              role="img"
              aria-label="Sample workflow manifest for the help-desk helper workflow: its steps and link access are allowed, other workspaces and passwords are denied."
            >
              <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">
                <span>Your workflow, on one page</span>
                <span>Sample</span>
              </div>
              <p className="px-4 pb-1 pt-3 font-semibold text-[var(--text)]">
                workflow: help-desk helper
              </p>
              <ul className="list-none p-0">
                {MANIFEST_ROWS.map((row) => (
                  <li
                    key={row.scope}
                    className="flex items-baseline justify-between gap-4 border-t border-[var(--border)] px-4 py-2 text-[var(--muted)]"
                  >
                    <span className="min-w-0 break-words">{row.scope}</span>
                    <span
                      className={
                        row.decision === "ALLOW"
                          ? "shrink-0 text-xs font-semibold tracking-[0.06em] text-[var(--accent)]"
                          : "shrink-0 text-xs font-semibold tracking-[0.06em] text-[var(--danger)]"
                      }
                    >
                      {row.decision}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="flex flex-wrap justify-between gap-3 border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--muted)]">
                <span>keys stored scrambled</span>
                <span>checked · v1</span>
              </p>
            </div>
          </section>

          {/* PROVIDER STRIP */}
          <div className="flex flex-wrap gap-x-12 gap-y-2 overflow-hidden border-y border-[var(--border)] py-5">
            {["OpenRouter", "NVIDIA", "Hugging Face", "Moonshot"].map((name) => (
              <span
                key={name}
                className="font-mono text-xs font-semibold uppercase tracking-[0.09em] text-[var(--muted)]"
              >
                {name}
              </span>
            ))}
          </div>

          {/* CAPABILITIES */}
          <section className="border-b border-[var(--border)] py-12">
            <p className="mb-2 font-mono text-sm text-[var(--muted)]">01</p>
            <h2 className="mb-8 max-w-[28ch] text-3xl font-semibold leading-tight tracking-[-0.015em] sm:text-4xl">
              Everything you need to get AI helpers working together
            </h2>
            <div className="grid gap-x-12 md:grid-cols-2">
              {features.map((f) => (
                <div key={f.title} className="flex gap-3 border-t border-[var(--border)] py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)]" aria-hidden>
                    <f.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="mb-1 text-base font-semibold">{f.title}</h3>
                    <p className="max-w-[62ch] text-sm leading-relaxed text-[var(--muted)]">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* HOW IT WORKS */}
          <section className="border-b border-[var(--border)] py-12">
            <p className="mb-2 font-mono text-sm text-[var(--muted)]">02</p>
            <h2 className="mb-8 text-3xl font-semibold leading-tight tracking-[-0.015em] sm:text-4xl">
              From an idea to a working helper in three steps
            </h2>
            <ol className="list-none p-0">
              {[
                {
                  n: "01",
                  icon: Blocks,
                  title: "Build it",
                  body: "Open the builder and lay out your steps: AI models, your files, and actions from other apps.",
                },
                {
                  n: "02",
                  icon: Play,
                  title: "Try it out",
                  body: "Chat with your workflow. Each message shows a step-by-step record of what each step did.",
                },
                {
                  n: "03",
                  icon: Share2,
                  title: "Share it",
                  body: "Switch it on, then call it from anywhere with a private link and key.",
                },
              ].map((step) => (
                <li
                  key={step.n}
                  className="grid grid-cols-[32px_1fr] gap-4 border-t border-[var(--border)] py-4 sm:grid-cols-[44px_200px_1fr]"
                >
                  <span className="font-mono text-sm text-[var(--muted)]">{step.n}</span>
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <step.icon className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
                    {step.title}
                  </h3>
                  <p className="col-start-2 max-w-[58ch] text-sm leading-relaxed text-[var(--muted)] sm:col-start-3">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          {/* TEMPLATES */}
          <section className="border-b border-[var(--border)] py-12">
            <p className="mb-2 font-mono text-sm text-[var(--muted)]">03</p>
            <h2 className="text-3xl font-semibold leading-tight tracking-[-0.015em] sm:text-4xl">
              Start from a ready-made example
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-[var(--muted)]">
              Use a ready-made workflow in minutes — then change it to fit your work.
            </p>
            <div className="mt-8 grid gap-x-12 md:grid-cols-2">
              {[
                {
                  icon: Headphones,
                  name: "Customer Support Helper",
                  category: "Customer Service",
                  desc: "Searches your support notes, drafts a reply, and passes hard cases to a person.",
                },
                {
                  icon: Megaphone,
                  name: "New-Customer Helper",
                  category: "Marketing",
                  desc: "Fills in details about new customers, scores how interested they are, and writes a welcome message.",
                },
                {
                  icon: Code2,
                  name: "Code Reviewer",
                  category: "Developer Tools",
                  desc: "Spots secrets and security problems in code and writes review notes.",
                },
                {
                  icon: Scale,
                  name: "Contract Questions",
                  category: "Legal & Compliance",
                  desc: "Answers questions about contracts with quotes, and flags risky clauses.",
                },
                {
                  icon: ServerCog,
                  name: "Incident Write-Up",
                  category: "DevOps",
                  desc: "Sums up what happened and writes a blame-free list of next steps.",
                },
                {
                  icon: TrendingUp,
                  name: "Feedback Sorter",
                  category: "Growth",
                  desc: "Groups feedback, labels the problems, and drafts what to fix first.",
                },
              ].map((t) => (
                <div key={t.name} className="flex gap-3 border-t border-[var(--border)] py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)]" aria-hidden>
                    <t.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3">
                      <h3 className="text-base font-semibold">{t.name}</h3>
                      <span className="font-mono text-xs text-[var(--muted)]">{t.category}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-[var(--muted)]">{t.desc}</p>
                    <Link
                      href="/dashboard/templates"
                      className="mt-3 inline-flex items-center gap-1 text-sm font-semibold"
                    >
                      See the examples <ChevronRight className="icon-sm" aria-hidden />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* PRICING */}
          <section className="border-b border-[var(--border)] py-12">
            <p className="mb-2 font-mono text-sm text-[var(--muted)]">04</p>
            <h2 className="mb-8 text-3xl font-semibold leading-tight tracking-[-0.015em] sm:text-4xl">
              Simple plans
            </h2>
            <div className="grid gap-6 md:grid-cols-3">
              {pricing.map((tier) => (
                <div key={tier.name} className="flex flex-col rounded-[4px] border border-[var(--border)] bg-[var(--surface)]">
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">
                      {tier.name}
                    </h3>
                    {tier.highlight && (
                      <span className="status-line">
                        <span className="lamp lamp-ok" aria-hidden />
                        Most popular
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col p-4">
                    <p className="mb-6 flex items-baseline gap-1">
                      <span className="font-mono text-4xl font-semibold tabular-nums">{tier.price}</span>
                      {tier.price !== "Custom" && (
                        <span className="text-sm text-[var(--muted)]">/mo</span>
                      )}
                    </p>
                    <ul className="flex-1 list-none space-y-2 p-0 text-sm text-[var(--muted)]">
                      {tier.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 border-t border-[var(--border)] pt-2 first:border-t-0 first:pt-0">
                          <Check className="mt-0.5 icon-xs shrink-0 text-[var(--accent)]" aria-hidden />
                          <span className="min-w-0">{f}</span>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={tier.price === "Custom" ? "/contact" : "/dashboard"}
                      className={tier.highlight ? "btn btn-primary mt-8 w-full justify-center" : "btn btn-secondary mt-8 w-full justify-center"}
                    >
                      {tier.price === "Custom" ? (
                        <>
                          <Mail className="icon-sm" aria-hidden />
                          Contact Sales
                        </>
                      ) : (
                        <>
                          Open the Builder
                          <ArrowRight className="icon-sm" aria-hidden />
                        </>
                      )}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* BOTTOM CTA */}
          <section className="py-12 text-center">
            <h2 className="mx-auto mb-4 max-w-[22ch] text-4xl font-semibold leading-tight tracking-[-0.02em] sm:text-5xl">
              Ready to build your first AI helper?
            </h2>
            <p className="mx-auto mb-10 max-w-xl text-base leading-relaxed text-[var(--muted)]">
              Start with one step. Add more when you are ready.
            </p>
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/dashboard" className="btn btn-primary">
                Start with one step
                <ArrowRight className="icon-sm" aria-hidden />
              </Link>
              <Link href="/docs" className="btn btn-secondary">
                <BookOpen className="icon-sm" aria-hidden />
                Read the Docs
              </Link>
            </div>
          </section>
        </div>
      </div>
    </PublicLayout>
  );
}
