# Lane C — Phase 2 contract (PerfectTask)

Mandatory items: P2-1..P2-7 from PUBLISHABLE-CONTRACT.md, plus the addendum
(Builder Run executes for real via POST /api/execute; node config is what runs;
edge labels; deploy saves first; sandbox real trace; analytics only real runs;
audit every control touched — no decorative selects/toggles/panels).

Verification (before calling anything done):
- TMPDIR=~/workspace/fypagentflow-build/lane-c/.tmp-build
- npm ci (exit 0), npm run build (exit 0), npm run lint (report honestly;
  exit 0 for files touched), npm run test:workflow (73/73),
  npm run test:hardening (exit 0), npm run test:phase2 (new, exit 0).
- Grep gates: no `new Function` added by me (executor condition is P0 lane's
  item — I do not touch it); no `/api/rate-limit` route left; no `|| 'dev'`
  secret fallback added; no localhost Stripe fallback left.
- Round-trip evidence: config save/load/execute traced in code (no live DB in
  this sandbox, so execution is verified by build + unit tests + code trace,
  stated honestly in CHANGES.md).
