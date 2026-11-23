"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, Eye, PenTool } from "lucide-react";
import { PublicLayout } from "@/components/layout/PublicLayout";

export default function AboutPage() {
  const stack = [
    { name: "Next.js 16", desc: "The web framework the app is built on." },
    { name: "TypeScript", desc: "Helps catch mistakes in the code before the app runs." },
    { name: "Tailwind CSS v4", desc: "Styles the pages — layout, spacing and colours." },
    { name: "React Flow", desc: "Draws the canvas where you connect your steps." },
    { name: "Zustand", desc: "Keeps the layout and on-screen messages in sync." },
    { name: "Framer Motion", desc: "The small slide and hover animations on panels." }
  ];

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1120px] px-4 py-12 font-sans text-[var(--text)] sm:px-6">
        <header className="max-w-3xl border-b border-[var(--border)] pb-8">
          <h1 className="mb-4 text-3xl font-semibold tracking-[-0.015em] sm:text-4xl">Project Vision</h1>
          <p className="mb-3 text-sm leading-relaxed text-[var(--muted)]">
            AgentFlow is a Final Year Project (FYP). It makes building AI helpers simple: instead of writing code,
            you draw the steps on a canvas, add your own files so answers come from them, and test the result
            live.
          </p>
          <p className="text-sm leading-relaxed text-[var(--muted)]">No coding needed.</p>
        </header>

        <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
          <section className="border-b border-[var(--border)] py-8">
            <h2 className="mb-4 text-lg font-semibold">Core Principles</h2>
            <ul className="list-none space-y-4 p-0 text-sm leading-relaxed text-[var(--muted)]">
              <li className="flex gap-3 border-t border-[var(--border)] pt-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)]" aria-hidden>
                  <PenTool className="icon-sm" />
                </span>
                <span className="min-w-0">
                  <strong className="font-semibold text-[var(--text)]">Visual-First Design</strong>: Build your helper by
                  drawing steps on a canvas, instead of writing code.
                </span>
              </li>
              <li className="flex gap-3 border-t border-[var(--border)] pt-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)]" aria-hidden>
                  <Eye className="icon-sm" />
                </span>
                <span className="min-w-0">
                  <strong className="font-semibold text-[var(--text)]">See Every Step</strong>: Try a question live and
                  see what each step did, so you always know how an answer was reached.
                </span>
              </li>
            </ul>
          </section>

          <section className="border-b border-[var(--border)] py-8">
            <h2 className="mb-4 text-lg font-semibold">What It Is Built With</h2>
            <dl>
              {stack.map((item) => (
                <div key={item.name} className="ruled-row flex-col items-start gap-0.5">
                  <dt className="font-mono text-sm font-semibold">{item.name}</dt>
                  <dd className="text-xs leading-relaxed text-[var(--muted)]">{item.desc}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <section className="py-12 text-center">
          <h2 className="mx-auto mb-4 max-w-[22ch] text-3xl font-semibold leading-tight tracking-[-0.015em] sm:text-4xl">
            Want to see it work?
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-base leading-relaxed text-[var(--muted)]">
            Start with one step. Add more when you are ready.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/dashboard" className="btn btn-primary">
              Open the Builder
              <ArrowRight className="icon-sm" aria-hidden />
            </Link>
            <Link href="/docs" className="btn btn-secondary">
              <BookOpen className="icon-sm" aria-hidden />
              Read the Docs
            </Link>
          </div>
        </section>
      </div>
    </PublicLayout>
  );
}
