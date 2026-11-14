# Encrypted data backfill

The backfill is opt-in and is not run by the application, build, or deployment.
Apply the reviewed Phase 2A and `20261113000000_encrypted_data_api.sql`
migrations to the intended isolated database before running it. Run the script
from a trusted server environment with the existing server-only KEK variables
and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` configured. Never put these
values in a `VITE_` variable or print them in a terminal transcript.

## Read mode and cutover

`SECURITRES_ENCRYPTION_MODE` is a server-only variable with two accepted values:

- `legacy`: the default when the variable is unset. A missing envelope may use
  the legacy plaintext column while migration is in progress.
- `strict`: a non-null value without an envelope is rejected. Null optional
  values remain null. Invalid envelopes and authentication failures always fail
  closed in either mode; an envelope error never falls back to plaintext.

Keep the application in `legacy` mode while migrating. New application writes
are encrypted regardless of this setting. First run a bounded dry run, then a
bounded encryption-only pass. Review all failures, and repeat a full dry run
after the complete backfill. Enable `strict` only after that run reports zero
`needsEncryption`, `blindIndexNeedsWrite`, and `failed` counts for all intended
fields. Test strict mode in an isolated environment before changing the
production Vercel server variable. Do not set this variable as a `VITE_` value.

Plaintext retirement is a separate, explicitly approved step. Only after strict
mode and a complete successful verification should `--clear-plaintext` be used.
The option cannot be combined with `--dry-run`; it never runs automatically.

## Keys and student-number uniqueness

Before deploying the encrypted-data API, configure
`SECURITRES_KEK_ACTIVE_VERSION`, the matching
`SECURITRES_KEK_V<version>_B64URL` value (including every older version still
referenced by stored envelopes), and
`SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL` as server-only variables in the
intended Vercel environments. No key values belong in this repository.

Student-number uniqueness uses `student_number_index`, a separate HMAC-SHA-256
blind index. Configure a dedicated stable 32-byte base64url secret as
`SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL`. Keep this secret backed up and
unchanged: rotating it requires a coordinated dual-index migration. The existing
plaintext student-number unique constraint remains in place during this phase.

## Backfill procedure

A dry run reads the selected database and reports `needsEncryption`,
`alreadyEncrypted`, `skippedNull`, `blindIndexNeedsWrite`, and `failed` counts.
It performs no database writes. It still requires the selected environment's
server credentials and encryption/HMAC keys so existing envelopes and index
state can be verified.
It also reports student-number readiness counts separately: valid encrypted
student numbers, valid blind indexes, missing indexes, inconsistent indexes,
missing numbers, invalid or undecryptable envelopes, and records requiring
retry. A profile with an encrypted number and no index is not ready. When its
plaintext column is null, the script decrypts the envelope server-side, derives
the HMAC from the number, and compares the exact envelope during the index
write. The decrypted number is never logged. A dry run counts the missing index
without writing it.

Run a bounded read-only rehearsal first:

```powershell
node scripts/backfill-encrypted-data.js --confirm-encryption-backfill --limit=100 --dry-run
```

After reviewing the report, run the bounded encryption-only pass (no plaintext
is cleared):

```powershell
node scripts/backfill-encrypted-data.js --confirm-encryption-backfill --limit=100
```

For the full database, use `--all` instead of `--limit=100`. The script uses
compare-and-swap filters for the original plaintext and null envelope before
writing, verifies the returned stored envelope after each write, and only
clears plaintext if both the original plaintext and exact verified envelope
still match. Student-number index writes compare the source number and, when
present, the exact envelope as well. JSONB equality values are sent as serialized
JSON text because the installed PostgREST client interpolates `.eq()` values
into its URL filter.
If concurrent changes prevent an update or clear, the row is left unchanged
and reported as a failure; rerunning is safe after the conflict is resolved.

After a complete write pass, run:

```powershell
node scripts/backfill-encrypted-data.js --confirm-encryption-backfill --all --dry-run
```

Require zero `needsEncryption`, `blindIndexNeedsWrite`, `failed`, missing-index,
inconsistent-index, invalid-envelope, and retry counts before enabling strict
mode. Review skipped-null and missing-number counts as well. The backfill reports
`strictModeReady: true` only for a complete `--all` run with no outstanding
encryption work, index work, or failures. In `legacy` mode, profile reads may
create and verify envelopes and a missing blind index; in `strict` mode, a
non-null plaintext value without its envelope is rejected. Profile reads never
clear plaintext. Plaintext retirement occurs only in this explicit backfill mode. If the owner
later approves plaintext retirement, use a separate verified run with
`--clear-plaintext`; production requires both the confirmation flag and
`--allow-production`:

```powershell
node scripts/backfill-encrypted-data.js --confirm-encryption-backfill --all --clear-plaintext --allow-production
```

The script is resumable. It verifies existing envelopes instead of encrypting
them again, prints counts only, and never logs row IDs, plaintext, ciphertext,
or key material. The production flag is only a guard; it does not authorize or
execute a production operation by itself.

The encryption AAD includes the environment name. Use the same `VERCEL_ENV` or
`NODE_ENV` value as the application environment that will later decrypt the
values. Do not copy ciphertext between environment contexts.
