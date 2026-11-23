# Stripe integration — SUPERSEDED

This note is kept only so the old one is not followed by mistake. The
checkout it describes was replaced by the code below. Do not follow the
"values to replace" table from the old version: there is no `price_...`
placeholder to replace, no `src/app/api/payments/checkout/route.ts`, and
no `file:///d:/...` paths.

## What the code does today

- Checkout lives in `src/app/api/payments/checkout/handler.ts`, reached
  through the payments catch-all (`src/app/api/payments/[[...path]]/`).
- The price is inline `price_data`, fixed at `unit_amount: 1900` ($19 USD,
  monthly). Client-supplied `line_items` are ignored by the fixed code.
- `success_url` / `cancel_url` point at `/dashboard/payment`
  (`?session_id={CHECKOUT_SESSION_ID}&success=true` /
  `?canceled=true`), built from the `DOMAIN` environment variable.
  Without `DOMAIN` they fall back to `http://localhost:3000`.
- `verify-session` (`src/app/api/payments/verify-session/handler.ts`)
  confirms the session with Stripe and grants Pro for 30 days.
- The webhook (`src/app/api/payments/webhook/handler.ts`) handles
  `checkout.session.completed`. It must fail closed without a signature
  or secret, and must deduplicate by Stripe event id.

## Environment variables

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
DOMAIN=http://localhost:3000
```

Use Stripe test keys and the test card `4242 4242 4242 4242` for demos.
See the Stripe dashboard for keys: https://dashboard.stripe.com/test/apikeys
