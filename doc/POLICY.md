# AgentFlow policy

> Simplified-release note (2026-11-18): sign-up is deferred in this release — accounts are coming later,
> and everything usable now works without one. The account rules below describe the code as built, not
> something a new visitor can use today.

Short policy for the product as built. Every line below matches the code;
where the code does not do something, this file says so instead of promising
it. The two corporate-policy PDFs that used to sit at the repo root were
deleted because they contradicted the product (JazzCash/EasyPaisa, Rs. 1,500,
a 7-day refund, a 20 MB upload limit, "Kimi Vector Embeddings"). The
in-app Terms page (`src/app/terms/page.tsx`) states the same billing terms.

## Price and payment

- Free plan: $0. Pro plan: $19 per month, charged in USD
  (`unit_amount: 1900` in `src/app/api/payments/checkout/handler.ts`).
  Enterprise has no price in the product; it routes to the contact page.
- Payment is through Stripe only. There is no JazzCash, EasyPaisa, cash on
  delivery, or manual payment path, and no transaction-ID approval flow.
- New verified accounts get a 90-day free trial (`trialEndsAt` is set 90 days
  out at email verification).

## Refunds and cancellation

- The code has no refund flow: no refund endpoint and no Stripe refund call
  exists in `src/`. AgentFlow does not issue refunds.
- The code has no in-app subscription-cancel flow either. A Pro subscription
  bought through Stripe runs to the end of the paid 30-day period recorded
  as `subscriptionEndsAt`.

## Uploads and RAG

- No document upload size limit is enforced in this copy
  (`src/app/api/rag/upload/handler.ts` has no size check). Do not quote a
  limit until one is enforced in code.
- Documents are chunked and embedded locally with Transformers.js
  (`Xenova/all-MiniLM-L6-v2`, 384 dimensions). Embeddings are not produced
  by Kimi or any hosted embedding API. Chat answers come from the
  OpenRouter → NVIDIA → Hugging Face → Moonshot fallback chain
  (`src/lib/llm.ts`).

## Accounts

- Sign-up requires email verification before login. Password reset links are
  emailed and expire after 1 hour. Sessions last 7 days
  (`SESSION_MAX_AGE` in `src/lib/auth/jwt.ts`). Passwords are stored hashed
  with bcryptjs.
- Provider API keys supplied when an agent is created are stored encrypted
  with AES-256-GCM. Keys saved through `POST /api/keys` and agent PATCH are
  stored unencrypted in this copy (fix pending, P0-4).

## Contact

- Use the contact page in the app. The support address shown in the product
  is support@agentflow.ai.
