import Link from "next/link";
import { PublicLayout } from "@/components/layout/PublicLayout";

/**
 * Plain-language 404: one clear sentence, one clear next step.
 * KFS look only (hairline, Plex, 2px radius) — no redesign.
 */
export default function NotFound() {
  return (
    <PublicLayout>
      <div className="mx-auto max-w-[640px] px-4 py-12 font-sans text-[var(--text)] sm:px-6">
        <h1 className="mb-4 text-3xl font-semibold tracking-[-0.015em]">This page does not exist</h1>
        <p className="mb-8 text-sm leading-relaxed text-[var(--muted)]">
          The link may be mistyped, or the page may have moved. Go back to the home page and start again.
        </p>
        <Link href="/" className="btn btn-primary">
          Go to the home page
        </Link>
      </div>
    </PublicLayout>
  );
}
