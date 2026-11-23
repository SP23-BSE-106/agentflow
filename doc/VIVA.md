# Viva rehearsal checklist

Rehearsed from the code, not copied from the audit. Each demo step says
whether it works in this copy or waits on a named fix — do not demo a step
marked "waits on" until that fix is merged and re-verified. The contract
tests in `tests/phase3` are the check for the fixed behaviour:
`npm run test:phase3` must pass on the merged tree before the viva.

## Set up before the demo

- [ ] Atlas `MONGODB_URI` + the `agentflow_vector_index` search index
      created on `rag_chunks` (384 dimensions, field `embedding`). Local
      MongoDB runs the app, but `$vectorSearch` needs Atlas; without the
      index, retrieval falls back to an exact cosine scan.
- [ ] One inference key: `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`,
      `HF_TOKEN`, or `KIMI_API_KEY` / `MOONSHOT_API_KEY`. The fallback
      order is OpenRouter → NVIDIA → Hugging Face → Moonshot.
- [ ] Mailtrap SMTP credentials (`MAILTRAP_*`) or working `SMTP_*`, so
      signup verification mail actually arrives.
- [ ] Stripe **test** keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
      and `DOMAIN` set to the deployed URL. Without `DOMAIN`, the
      checkout success URL falls back to `http://localhost:3000` and the
      paying user never returns to the app.
- [ ] Google OAuth client only if demoing Google sign-in
      (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
      `GOOGLE_REDIRECT_URI`).
- [ ] Pre-create, so nothing waits on a slow step live: one verified
      user, two agents with different roles (one `critic`), one workflow,
      one uploaded PDF in RAG.

## Demo order (safest first)

- [ ] Fresh clone from `https://github.com/SP23-BSE-106/FYPAGENTFLOW.git`,
      `npm ci`, `npm run build`. Rehearse once on the viva machine/network.
- [ ] `npm run test:workflow` live → `73/73 passed`. Say "73 test cases"
      out loud, not "73 assertions".
- [ ] `npm run test:hardening` live → passes.
- [ ] `npm run test:phase3` live on the merged tree → all cases pass.
      On this copy it is 12/32: the 20 failures are the contract cases
      waiting on Lanes A/B (Stripe P0-2/P0-3, approvals P0-6, agent
      fields P1-1, RAG grounding P1-4, auth tokens + run IDOR P2-4).
      Do not present 12/32 as a pass.
- [ ] Do NOT run `npm run lint` live until the lint fix lands (P2-6):
      it exits 1 with 100 problems on this copy.
- [ ] Canvas + Kimi assistant → workflow Run/validate. The builder's Run
      button is compile-and-validate only: it checks the graph and states
      plainly that nothing was executed. Real execution is
      `POST /api/execute`, proven end to end for a 6-node workflow by
      `tests/phase3/cases/builder.cjs` (Input, LLM, RAG, API, Condition,
      Output — each node's real output asserted, Condition branched both
      ways). Do not say "the builder Run executes" until the button is
      wired to that path.
- [ ] Agent generation in mock mode (`MOCK_LLM=true`) or with a key.
      `MOCK_LLM=true` mocks only `POST /api/agents/generate`; execute,
      orchestration and RAG chat still need a real provider key.
- [ ] RAG chat on the pre-loaded document. Do NOT ask a question with no
      documents uploaded: on this copy the chat answers from general
      knowledge and says so only in the system prompt. After the P1-4
      fix it refuses instead.
- [ ] Orchestrate sequential, then parallel, then supervisor plan preview.
      Per-node agents work in supervisor mode only on this copy; in
      sequential/parallel modes every node runs under the owner agent.
- [ ] Approval pause/resume — WAITS ON P0-6. The approval buttons 404 on
      this copy and resume never re-executes. Do not demo until
      `tests/phase3/cases/approvals.cjs` passes, including the
      approve-then-resume case.
- [ ] Run timeline/events — the events endpoint is real.
- [ ] Deploy + execute — WAITS ON P2-1 for "deploy serves the current
      canvas". On this copy Deploy activates the last saved graph; edits
      inside the autosave window are not deployed. Save first, wait for
      the save, then deploy. Draft agents are executable over the public
      API on this copy; only `active` agents should be presented as live.
- [ ] Analytics — WAITS ON P2-3 for "counts only real runs". On this
      copy every non-`failed` row counts as a success (including
      `running`, `paused`, `cancelled`), and builder compile checks are
      recorded as `exec` successes. Do not quote the totals until the
      status mapping is fixed.
- [ ] Stripe checkout in test mode, with `DOMAIN` set. The return lands
      in the app and verify-session confirms it. On this copy
      verify-session does not check the amount or the payer, and the
      webhook accepts unsigned events — both fixed by P0-2/P0-3, pinned
      by `tests/phase3/cases/stripe.cjs`.

## Honest-failure slide (show deliberately, once)

- With no inference key, `/api/execute` answers 502 "no provider
  configured". Show it once on purpose rather than letting it happen
  by accident.
- With no documents, RAG chat answers from general knowledge on this
  copy (refuses after P1-4). Say which behaviour the build on screen
  has before asking the question.

## Viva traps — answers, in one line each

- "Your README says 10 functions" — it said 10; the build has 14
  `route.ts` files, 2 over the Vercel Hobby limit of 12. The count is
  corrected in the README and the merge-down is P0-7.
- "Your policy PDF says JazzCash/EasyPaisa and Rs. 1,500" — the PDFs are
  deleted. The policy is `doc/POLICY.md`: Stripe only, $19, no refunds,
  no enforced upload limit, local embeddings.
- "Your CI is a webpack template on a branch that doesn't exist" — that
  is P2-6 work, not this lane; say so and do not claim CI gates merges.
- "Lint fails with 45 errors" — yes, on this copy; P2-6 owns it.
- "Where are the integration tests for the multi-agent feature?" —
  `tests/phase3` (32 cases) covers Stripe, approvals + resume, agent
  creation + critic discovery, RAG grounding, auth tokens, run-write
  IDOR, and the 6-node builder execution. The 9-step end-to-end
  scenario from `implementation.md` §7 is still not automated.
- "The E2E test exits 0 without testing anything" — not any more:
  `tests/e2e/orchestration.mjs` exits 2 without its env vars.

## Do not demo

- Any approval flow (P0-6 pending).
- "Edit & Approve" as a real edit (the modal sends the payload unchanged).
- A fresh signup without working SMTP (the user is told to check mail
  that never arrives; there is no resend path on this copy).
- A chat question with no documents uploaded (ungrounded answer).
- Deploy immediately after editing the canvas (stale graph).
- Analytics totals as proof of execution volume (inflated on this copy).
- The PDFs, the "10 functions" line, or the "73 assertions" line — all
  three are gone from the docs; do not quote them in the presentation.
