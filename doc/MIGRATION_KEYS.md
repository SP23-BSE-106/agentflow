# API keys stored before the Phase 0 fix — re-enter, do not trust

## What changed

Before the Phase 0 security fix, provider API keys were stored in MongoDB
in plaintext in two places, even though the field was named `encryptedKey`:

- `api_keys.encryptedKey` — written by `POST /api/keys` and by the
  `saveApiKey` server action.
- `agents.userApiKey` — written by agent PATCH (agent POST already
  encrypted).

Both paths now encrypt with AES-256-GCM (`src/lib/crypto.ts`) before
storing, and the stored agent key is decrypted server-side only when the
agent actually runs (`POST /api/execute` → `src/lib/llm.ts`).

## What this means for keys already stored

Keys stored before the fix are still plaintext in the database. They are
**not** re-encrypted automatically, and the code does not silently trust
them:

- A plaintext value in `agents.userApiKey` cannot be decrypted, so
  `POST /api/execute` for that agent now fails with a clear error telling
  the owner to re-enter the key. It does not fall back to running without
  the key and it does not treat the plaintext as an encrypted value.
- Rows in `api_keys` have no reader that uses them for inference, so a
  plaintext row there is inert but still a live key in the database.

## What to do

1. **Re-enter every provider key** saved before the fix: save it again
   through the dashboard (agent edit, or `POST /api/keys`). The new value
   is stored encrypted.
2. **Rotate each key at its provider** (OpenRouter, NVIDIA, HuggingFace,
   Moonshot). A key that sat in plaintext in a database backup or log
   must be treated as compromised, even if nothing bad is known to have
   happened to it.
3. **Delete the old plaintext rows** once the keys are re-entered and
   rotated. There is no automatic migration because re-encrypting a
   plaintext value in place would leave the old plaintext value in
   database history and backups; rotation is the only clean fix.

## Why there is no automatic migration

An automatic "encrypt what is there" migration would encrypt the stored
plaintext without proving the owner still controls the key, and would
leave the plaintext value recoverable from backups. Re-entering plus
rotating is the honest fix.
