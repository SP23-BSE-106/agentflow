import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // H8: Next.js truncates cloned request bodies at its default
  // `proxyClientMaxBodySize` of 10 MB (Next 16.2.9), so the upload
  // handler's own 20 MB cap was unreachable — every file in the 10–20 MB
  // band died in `formData()` parsing with a misleading 500. 32 MB leaves
  // headroom for the multipart envelope around a 25 MB file, so the
  // handler's 20 MB check governs and answers 413. (The older name for
  // this knob, `middlewareClientMaxBodySize`, is deprecated in Next 16.)
  experimental: {
    proxyClientMaxBodySize: '32mb',
  },

  // /api/supervisor/plan moved into the /api/orchestrate catch-all (the
  // Vercel Hobby plan allows 12 serverless functions and the project was at
  // 14). The old URL keeps working through this rewrite. The n8n entry
  // points are folded the same way — webhooks, triggers/check and forms
  // into /api/orchestrate, executions into /api/runs — so the public URLs
  // stay exactly as documented while the function count stays at 12.
  async rewrites() {
    return [
      { source: '/api/supervisor/plan', destination: '/api/orchestrate/plan' },
      // Test-webhook registration (Lane A5): the specific register path
      // must come BEFORE the generic /api/webhooks/:workflowId/:mode
      // rewrite, or the :mode slot would swallow 'test' and 404.
      { source: '/api/webhooks/:workflowId/test/register', destination: '/api/orchestrate/webhooks/:workflowId/test/register' },
      { source: '/api/webhooks/:workflowId/:mode', destination: '/api/orchestrate/webhooks/:workflowId/:mode' },
      { source: '/api/triggers/check', destination: '/api/orchestrate/triggers/check' },
      { source: '/api/forms/:workflowId', destination: '/api/orchestrate/forms/:workflowId' },
      { source: '/api/executions/:id/resume', destination: '/api/runs/executions/:id/resume' },
      { source: '/api/executions', destination: '/api/runs/executions' },
    ]
  },

  // Security headers on every response (pages and API alike). Responses
  // used to carry only Cache-Control: no CSP, no HSTS, no framing or
  // MIME-sniffing guards. The CSP is deliberately pragmatic rather than
  // maximal: Next.js needs 'unsafe-inline'/'unsafe-eval' for its own
  // scripts, and the app loads its fonts from Google Fonts — everything
  // else is same-origin, with framing refused outright.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob: https:",
              "connect-src 'self' https: wss:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]
  },

  // Native addons / Node-only code that must be required natively rather than
  // bundled: pdf-parse -> @napi-rs/canvas (compiled .node binding),
  // @huggingface/transformers -> onnxruntime-node (local embedding model).
  //
  // pdf-parse / pdfjs-dist are kept EXTERNAL on purpose. Bundling them was
  // tried and is worse: pdfjs resolves its worker as
  //   workerSrc ||= "./pdf.worker.mjs"   // relative to the importing chunk
  // so once bundled it looks for .next/server/chunks/pdf.worker.mjs, which is
  // never emitted, and every upload fails with
  //   Setting up fake worker failed: Cannot find module '.../chunks/pdf.worker.mjs'
  // Externally, that import resolves next to the real package and works.
  serverExternalPackages: [
    "pdf-parse",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "@huggingface/transformers",
    "onnxruntime-node",
  ],

  // Files that Node File Trace under-reports for this route.
  //
  // Two separate traps, both invisible on Windows because the native
  // packages ship a different layout there:
  //
  //   sharp / onnxruntime / @napi-rs/canvas resolve their binaries through
  //   *runtime-computed* requires, which the static trace cannot follow:
  //     sharp        require(`@img/sharp-libvips-${platform}/lib`)
  //     onnxruntime  bin/napi-v6/${process.platform}/${process.arch}/...
  //     @napi-rs     require(`@napi-rs/canvas-${platform}-${arch}-${libc}`)
  //   On Vercel (linux-x64) sharp's libvips is a separate package, so
  //   `libvips-cpp.so.8.18.6` went missing and every /api/rag/* route 500'd
  //   at import time with "cannot open shared object file".
  //
  //   pdf-parse -> pdfjs-dist is worse: pdf-parse imports it only from inside
  //   its own bundle (PDFParse.js: `from 'pdfjs-dist/legacy/build/pdf.mjs'`),
  //   and the trace recorded exactly one file of pdfjs-dist - no
  //   pdf.worker.mjs, no cjs entry of pdf-parse - yet even that one file was
  //   absent from the deployed function. Every upload failed with
  //     Cannot find module '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
  //   which pdf-parse wrapped as "Setting up worker failed" and our handler
  //   surfaced as a 422 "could not extract text".
  //
  // Pinning the packages whole sidesteps guessing at each layout. Scoped to
  // /api/rag/* - the only routes that import pdf-parse or
  // @/lib/rag/embeddings - so the rest of the app pays nothing for this.
  outputFileTracingIncludes: {
    "/api/rag/*": [
      "./node_modules/@huggingface/transformers/node_modules/@img/**/*",
      // Include the Linux binary used by Vercel even when the build runs on Windows.
      "./node_modules/onnxruntime-node/bin/**/*",
      "./node_modules/@napi-rs/**/*",
      "./node_modules/pdf-parse/**/*",
      "./node_modules/pdfjs-dist/**/*",
    ],
  },
};

export default nextConfig;
