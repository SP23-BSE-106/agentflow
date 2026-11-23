"use client";

import * as React from "react";
import { UploadCloud, FileText, Trash2, Search, Cpu, RefreshCw, AlertCircle, Sparkles, Loader2, BookOpen } from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

interface DocumentItem {
  id: string;
  name: string;
  preview: string;
  chunks: number;
  /** Chunks carrying a vector written by the model currently in use. */
  embedded: number;
  createdAt: string;
}

export default function DocumentCenterPage() {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [isUploading, setIsUploading] = React.useState(false);
  // Two phases, because they are two different waits: bytes going up the wire
  // (measurable) and the server chunking + embedding them (not measurable from
  // the browser). Collapsing them into one bar made 100% appear before the
  // document was anywhere near indexed.
  const [uploadPhase, setUploadPhase] = React.useState<"idle" | "uploading" | "embedding">("idle");
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [documents, setDocuments] = React.useState<DocumentItem[]>([]);
  const [loading, setLoading] = React.useState(true);

  // Search Test State
  const [testQuery, setTestQuery] = React.useState("");
  const [isQuerying, setIsQuerying] = React.useState(false);
  const [queryResults, setQueryResults] = React.useState<Array<{ text: string; similarity: number }>>([]);
  // A failed search used to leave the results area empty and silent, so the
  // button looked broken. This carries the reason instead (or the "nothing
  // matched" note, which was silent too).
  const [queryNotice, setQueryNotice] = React.useState<{
    kind: "error" | "info";
    text: string;
  } | null>(null);

  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [isReindexing, setIsReindexing] = React.useState(false);
  const [reindexMessage, setReindexMessage] = React.useState<string | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const fetchDocuments = React.useCallback(async () => {
    try {
      const res = await fetch("/api/rag/upload");
      if (res.status === 401) {
        // Don't render an empty knowledge base as if it were real — that hid
        // the expired-session problem behind "No documents uploaded yet".
        window.location.replace("/login?redirect=/dashboard/rag");
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
      }
    } catch (err) {
      console.error("Failed to fetch RAG documents", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDelete = async (doc: DocumentItem) => {
    if (!window.confirm(`Delete "${doc.name}"? Your agents will no longer be able to read it.`)) return;
    setDeletingId(doc.id);
    try {
      const res = await fetch("/api/rag/upload", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete document");
      fetchDocuments();
    } catch (err) {
      alert("Error deleting document: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDeletingId(null);
    }
  };

  const handleReindex = async () => {
    setIsReindexing(true);
    setReindexMessage(null);
    try {
      const res = await fetch("/api/rag/reindex", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reindex failed");
      setReindexMessage(
        `Re-read ${data.reindexed} of ${data.total} files.`
      );
      fetchDocuments();
    } catch (err) {
      setReindexMessage("Error: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsReindexing(false);
      setTimeout(() => setReindexMessage(null), 8000);
    }
  };

  React.useEffect(() => {
    // Awaited: the state updates inside fetchDocuments happen after the
    // fetch resolves, not synchronously in the effect body.
    void (async () => {
      await fetchDocuments();
    })();
  }, [fetchDocuments]);

  /**
   * Uploads with XMLHttpRequest rather than fetch, because it is the only way
   * to observe real byte-level progress. Bytes are all the browser can see —
   * chunking and embedding happen on the server — so the caller switches the
   * phase label when the transfer completes instead of pretending to know how
   * far embedding has got.
   */
  const uploadWithProgress = (
    file: File,
  ): Promise<{ ok: boolean; status: number; statusText: string; body: string }> =>
    new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("name", file.name);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/rag/upload");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          setUploadProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        }
      };
      xhr.upload.onload = () => setUploadPhase("embedding");
      xhr.onload = () =>
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          statusText: xhr.statusText,
          body: xhr.responseText,
        });
      xhr.onerror = () => reject(new Error("Network error while uploading."));
      xhr.ontimeout = () => reject(new Error("Upload timed out."));
      xhr.send(formData);
    });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadPhase("uploading");
    setUploadProgress(0);

    try {
      const response = await uploadWithProgress(file);

      // Read as text first: a Vercel gateway/timeout page is HTML, and calling
      // `res.json()` on it throws a confusing "Unexpected token" error.
      let data: { error?: string } = {};
      try {
        data = response.body ? JSON.parse(response.body) : {};
      } catch {
        /* non-JSON error page — handled via the status below */
      }

      if (!response.ok) {
        if (response.status === 401) throw new Error("Session expired — log in again, then retry.");
        throw new Error(
          data.error ||
            `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} (non-JSON error page)`,
        );
      }

      setUploadProgress(100);
      fetchDocuments();
    } catch (err: unknown) {
      alert("Error uploading document: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsUploading(false);
      setUploadPhase("idle");
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleTestQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testQuery.trim()) return;

    setIsQuerying(true);
    setQueryResults([]);
    setQueryNotice(null);

    try {
      const res = await fetch("/api/rag/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: testQuery, topK: 3 }),
      });

      // Text first: an HTML gateway page makes res.json() throw a cryptic
      // parse error that reads like a bug in the app rather than a 502.
      const raw = await res.text();
      let data: { results?: unknown[]; error?: string } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        /* non-JSON body — surfaced via the status below */
      }

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error("Session expired — log in again, then search again.");
        }
        throw new Error(
          data.error ||
            `Search failed — HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
        );
      }

      // The API contract is { text, similarity } per hit; anything else in
      // the payload is dropped rather than rendered as a broken row.
      const results: Array<{ text: string; similarity: number }> = Array.isArray(data.results)
        ? data.results.filter(
            (r): r is { text: string; similarity: number } =>
              typeof r === 'object' &&
              r !== null &&
              typeof (r as { text?: unknown }).text === 'string' &&
              typeof (r as { similarity?: unknown }).similarity === 'number',
          )
        : []
      setQueryResults(results);
      if (results.length === 0) {
        setQueryNotice({
          kind: "info",
          text: "Nothing in your files matched that question. Add a file first, or try different words.",
        });
      }
    } catch (err) {
      setQueryNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "The search could not be completed.",
      });
    } finally {
      setIsQuerying(false);
    }
  };

  const filteredDocs = documents.filter((doc) =>
    doc.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left">
        {/* Header Title */}
        <div className="space-y-1">
          <h2 className="font-h1 font-bold text-[var(--text)]">Your files</h2>
          <p className="text-xs text-[var(--muted)]">
            Upload files — PDFs, text, or notes — so your agents can read them and
            answer from them. Start by adding one file below.
          </p>
        </div>

        {/* Top metrics — ruled strip, not cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 border-t border-b border-[var(--border)] py-4">
          <div className="space-y-1 min-w-0">
            <span className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider flex items-center gap-1.5">
              <FileText className="icon-xs" /> Files
            </span>
            <div className="text-2xl font-semibold text-[var(--text)] font-mono">{loading ? "…" : documents.length}</div>
          </div>
          <div className="space-y-1 min-w-0">
            <span className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider flex items-center gap-1.5">
              <Cpu className="icon-xs" /> Pieces your agents can read
            </span>
            <div className="text-2xl font-semibold text-[var(--text)] font-mono">
              {documents.reduce((acc, doc) => acc + doc.chunks, 0)}
            </div>
          </div>
          <div className="space-y-1 min-w-0">
            <span className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider flex items-center gap-1.5">
              <BookOpen className="icon-xs" /> How files are read
            </span>
            <div className="text-sm font-semibold text-[var(--text)] font-mono break-words">Built-in reader</div>
          </div>
        </div>

        {/* Upload Area & Table */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          {/* Ingest Form & Query Tester */}
          <div className="space-y-6">
            <div className="panel">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)] mb-4">Add files</h3>

              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept=".txt,.pdf,.md"
                className="hidden"
              />

              <button
                type="button"
                className="w-full border border-dashed border-[var(--border-strong)] rounded-[2px] p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:border-[var(--accent)] bg-[var(--surface)] group"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadCloud className="h-10 w-10 text-[var(--muted)] group-hover:text-[var(--accent)] mb-3" />
                <span className="text-xs font-semibold text-[var(--text)]">Click to add a file</span>
                <span className="text-[11px] text-[var(--muted)] mt-1">PDF, TXT, and MD files work here</span>
              </button>

              {isUploading && (
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-[11px] flex-wrap gap-2">
                    <span className="font-semibold text-[var(--accent)]">
                      {uploadPhase === "embedding"
                        ? "File received — now reading it so your agents can use it…"
                        : "Uploading file…"}
                    </span>
                    <span className="font-mono">
                      {uploadPhase === "embedding" ? "working" : `${uploadProgress}%`}
                    </span>
                  </div>
                  <div className="h-2.5 w-full bg-[var(--surface-2)] rounded-[2px] overflow-hidden">
                    {uploadPhase === "embedding" ? (
                      <div className="h-full w-full bg-[var(--accent)] opacity-60 animate-pulse" />
                    ) : (
                      <div
                        className="h-full bg-[var(--accent)] transition-all duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Re-read stored files with the current reader */}
              <div className="mt-4 pt-4 border-t border-[var(--border)] space-y-2">
                <button
                  type="button"
                  onClick={handleReindex}
                  disabled={isReindexing || documents.length === 0}
                  className="btn btn-ghost w-full"
                >
                  {isReindexing && <Loader2 className="icon-sm animate-spin mr-2" />}
                  <RefreshCw className="icon-xs mr-1.5" />
                  Re-read all files
                </button>
                <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                  Reads your files again with the current reader. Use this if answers
                  start looking out of date — you do not need to upload again.
                </p>
                {reindexMessage && (
                  <div className={`notice ${reindexMessage.startsWith("Error") ? "notice-danger" : ""}`}>
                    {reindexMessage}
                  </div>
                )}
              </div>
            </div>

            {/* Try searching your files */}
            <div className="panel">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)] mb-3 flex items-center gap-2">
                <Sparkles className="icon-xs text-[var(--accent)]" />
                Try a search
              </h3>
              <p className="text-[11px] text-[var(--muted)] leading-relaxed mb-3">
                Ask a question and see which parts of your files answer it. This is a
                quick check — your agents do the same search when they work.
              </p>
              <form onSubmit={handleTestQuery} className="space-y-3">
                <input
                  type="text"
                  placeholder="Ask a question about your files..."
                  aria-label="Ask a question about your files"
                  className="input"
                  value={testQuery}
                  onChange={(e) => {
                    setTestQuery(e.target.value);
                    if (queryNotice) setQueryNotice(null);
                  }}
                />
                <button type="submit" disabled={isQuerying} className="btn btn-primary w-full">
                  {isQuerying && <Loader2 className="icon-sm animate-spin mr-2" />}
                  Search my files
                </button>
              </form>

              {queryNotice && (
                <div
                  role={queryNotice.kind === "error" ? "alert" : "status"}
                  className={`notice mt-4 ${queryNotice.kind === "error" ? "notice-danger" : ""}`}
                >
                  <span className="flex items-start gap-2">
                    <AlertCircle className="icon-xs shrink-0 mt-0.5" />
                    <span>{queryNotice.text}</span>
                  </span>
                </div>
              )}

              {queryResults.length > 0 && (
                <div className="mt-4 space-y-2">
                  <span className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">Best matches:</span>
                  {queryResults.map((r, i) => (
                    <div key={i} className="ruled-row space-y-1">
                      <div className="flex justify-between gap-2 text-[11px] font-mono">
                        <span className="text-[var(--muted)]">Result #{i + 1}</span>
                        <span className="text-[var(--accent)] font-semibold">{(r.similarity * 100).toFixed(1)}% match</span>
                      </div>
                      <p className="text-[var(--muted)] text-xs leading-relaxed">{r.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Catalog list */}
          <div className="lg:col-span-2 space-y-4 min-w-0">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <h3 className="font-h3 font-semibold text-[var(--text)]">Your files</h3>

              <div className="w-full sm:max-w-xs relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 icon-xs text-[var(--muted)]" />
                <input
                  type="text"
                  placeholder="Search your files..."
                  aria-label="Search your files"
                  className="input pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Preview</th>
                    <th>Pieces</th>
                    <th>Status</th>
                    <th>Added</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocs.map((doc) => (
                    <tr key={doc.id}>
                      <td className="font-semibold text-xs text-[var(--text)] max-w-[180px] truncate">
                        {doc.name}
                      </td>
                      <td className="text-xs text-[var(--muted)] max-w-[220px] truncate">
                        {doc.preview || "No preview"}
                      </td>
                      <td className="text-xs text-[var(--muted)] font-mono">{doc.chunks}</td>
                      <td>
                        {(() => {
                          const fresh = doc.embedded ?? 0;
                          if (doc.chunks === 0) {
                            return (
                              <span className="status-line">
                                <span className="lamp lamp-paused" />
                                Empty
                              </span>
                            );
                          }
                          if (fresh >= doc.chunks) {
                            return (
                              <span className="status-line">
                                <span className="lamp lamp-ok" />
                                Ready
                              </span>
                            );
                          }
                          return (
                            <span className="status-line">
                              <span className="lamp lamp-paused" />
                              <span className="font-mono">{fresh}/{doc.chunks} read</span>
                            </span>
                          );
                        })()}
                      </td>
                      <td className="text-xs text-[var(--muted)] font-mono">
                        {new Date(doc.createdAt).toLocaleDateString()}
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={deletingId === doc.id}
                          onClick={() => handleDelete(doc)}
                          aria-label={`Delete ${doc.name}`}
                          className="btn btn-danger"
                        >
                          {deletingId === doc.id ? (
                            <Loader2 className="icon-xs animate-spin" />
                          ) : (
                            <Trash2 className="icon-xs" />
                          )}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredDocs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center py-8 text-xs text-[var(--muted)]">
                        {loading
                          ? "Loading your files..."
                          : documents.length === 0
                            ? "No files yet. Add your first file on the left — a PDF, a text file, or notes — and your agents will be able to read it."
                            : "Nothing matched that search. Try a different word."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
