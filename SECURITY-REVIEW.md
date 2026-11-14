# Phase 7 Student Evidence Security Review

Review scope: read-only review of the Phase 7 student evidence feature, its Storage/database policies, and its interaction with the existing Phase 5/6 security boundaries. The cleanup migration was applied to Supabase, and an evidence upload was tested afterward. No deployment was performed as part of this review.

## Result

No Critical, High, or Medium severity security vulnerability was identified. Authentication, student-role verification, letter ownership, pending status, generated storage paths, private-bucket use, and short-lived signed URLs are enforced by the service and/or database policies. The cleanup policy permits removal of unreferenced objects for a student's own letter regardless of its current status; a narrow concurrency caveat remains.

| # | Severity | File | Lines | Finding | Confidence |
|---|----------|------|-------|---------|------------|
| 1 | ⚪ LOW | `supabase/migrations/20261102154300_allow_safe_orphan_evidence_cleanup.sql` | 5-27 | The cleanup helper checks that no `excuse_evidence` row references an uploaded object before permitting its deletion. A metadata reference could theoretically be inserted after this check but before Storage deletes the object, leaving a database record that references a missing file. The helper is `SECURITY DEFINER`, owned by `postgres`, and uses a fixed empty `search_path`; the function owner and live Storage DELETE policy were verified in Supabase after applying the migration. | 8/10 |

The cleanup migration replaces `students_remove_own_pending_letter_uploads` with `students_remove_own_orphaned_letter_uploads`. Cleanup is allowed for an authenticated student's own letter regardless of current status, but only when no `excuse_evidence` record references the object. This reduces the orphaned-upload risk when metadata insertion fails after a status change; it does not eliminate the separate check/delete concurrency race described above.

## Security checks

- **PASS** — Evidence service requires a Supabase Auth user and checks that the user's profile role is `student`.
- **PASS** — The service verifies the letter is owned by that Auth UUID and is pending before upload; database and Storage policies independently enforce ownership and pending status.
- **PASS** — Object paths use the Auth UUID, letter UUID, and a generated UUID filename. Storage policies validate the path and its relationship to the owned letter.
- **PASS** — The migration sets the `excuse-evidence` bucket to private and limits it to PDF, JPEG, and PNG with an 8 MiB maximum. Frontend validation rejects other MIME types, empty files, and oversized files.
- **PASS** — Evidence access uses temporary signed URLs (60 seconds); the client does not create public URLs.
- **PASS** — Existing evidence reads require a visible related letter. Student access is scoped to the student's own letters; existing Dean and approved-professor access is preserved.
- **PASS** — No evidence update or delete UI is provided. The cleanup policy `students_remove_own_orphaned_letter_uploads` replaces `students_remove_own_pending_letter_uploads` and allows deletion only for unreferenced generated-path objects belonging to the authenticated student and their own letter, regardless of letter status.
- **PASS** — The cleanup function is `SECURITY DEFINER`, owned by `postgres`, and uses a fixed empty `search_path`. Supabase verification confirmed the owner and live Storage DELETE policy after the migration was applied.
- **PASS** — No service-role key or privileged Supabase credential was found in frontend source. `.env.local` is ignored and not tracked.
- **PASS** — The Phase 5/6 letter/profile authorization policies were not weakened by the Phase 7 changes reviewed.
- **PASS** — No broad anonymous bucket/table access was found in the reviewed policies.
- **PASS** — The cleanup migration was successfully applied in Supabase, and a new evidence upload was tested afterward.
- **NOT TESTED** — Cross-student negative tests and the narrow concurrent metadata-insert/Storage-delete race were not exercised.

## Validation

- `npm.cmd run build` — passed; Vite reported a bundle-size warning.
- `git diff --check` — passed.
- `.env.local` — ignored by Git and not tracked; contents were not read.

## Recommendation

The implementation has no identified Critical, High, or Medium security blocker. The cleanup migration is applied and verified in Supabase, and evidence upload was tested afterward. The remaining Low-severity concurrency caveat is documented above: a metadata reference could theoretically be inserted between the helper's reference check and Storage deletion.

---

# Securitres Security Review Addendum — 2026-11-14

## Scope and conclusion

This addendum reviews the current encryption, server API, frontend services, migrations, Storage policies, backfill, and tests. It is a static review; Supabase grants, RLS, RPCs, Storage access, and database behavior were not exercised in this review. The previous Phase 7 live-verification statements above were not revalidated here.

No confirmed exploitable vulnerability was established. However, the project is **not ready for isolated database testing**: the migration chain contains a data-snapshot-dependent Phase 9B preflight, and this workspace has no Supabase CLI, Docker CLI, PostgreSQL client, or local Supabase config. This is not a production-readiness assessment.

## Findings

| # | Severity | File | Lines | Finding | Confidence |
|---|----------|------|-------|---------|------------|
| 1 | 🟠 HIGH | [supabase/migrations/20261107153500_phase9b_academic_program_registry.sql](./supabase/migrations/20261107153500_phase9b_academic_program_registry.sql) | 71-97, 203-223 | Migration requires fixed profiles and an exact four-letter inventory. Clean or materially different databases fail before completing the migration chain. Migration blocker; no access-control exploit established. | 10/10 |
| 2 | 🟡 MEDIUM | [scripts/backfill-encrypted-data.js](./scripts/backfill-encrypted-data.js) | 128-146 | Plaintext clearing compares the source plaintext and exact envelope, but selects only the row ID afterward; it does not explicitly read back and validate NULL plaintext and the retained envelope. | 9/10 |
| 3 | ⚪ LOW | [api/notify-student-decision.js](./api/notify-student-decision.js), [api/send-dean-daily-digest.js](./api/send-dean-daily-digest.js) | 8-9; 6 | Notification response helpers omit `Cache-Control: no-store, private`. No concrete data leak from these response bodies was established. | 10/10 |

The existing Phase 7 review above also documents a possible race between the orphan-evidence reference check and Storage deletion. It remains a low-confidence concurrency caveat; it was not re-tested against live Storage.

## Role and data access summary

| Data/action | Student | Dean/Admin | Professor |
|---|---|---|---|
| Own excuse letters | ALLOWED | — | — |
| Other students' letters | DENIED | CONDITIONAL: assigned program | CONDITIONAL: assigned course and approved status |
| Pending/rejected letters | Own records only | CONDITIONAL: assigned program | DENIED by the intended server and SQL paths |
| Dean comments and historical comments | Own records | CONDITIONAL: assigned program | DENIED by the intended API and column-grant design |
| Parent/guardian phone | Own record | CONDITIONAL: assigned program | DENIED by the intended API and table grants |
| Evidence metadata/files | Own records | CONDITIONAL: assigned program | CONDITIONAL: assigned course and approved status |
| Student identity | Own profile | CONDITIONAL: authorized records | CONDITIONAL: name and student number for an assigned approved letter |

These are source/migration conclusions, not verified deployed RLS or ACL results.

## Encryption and exposure limitations

- The implementation uses AES-256-GCM, random per-value DEKs and IVs, KEK wrapping, strict envelope validation, and AAD binding environment/table/row/field/type. Tampered envelopes fail closed; an existing envelope error does not fall back to plaintext.
- HMAC-SHA-256 uses a separate key, but hashes the exact student-number string without trimming or case normalization. This matches exact-string uniqueness; confirm that is the intended business rule.
- The legacy mode is the default when the mode variable is unset. Strict mode rejects non-null plaintext without a valid envelope. Key rotation requires a coordinated migration and retaining old KEKs while stored data still uses them.
- Evidence file bytes are stored in a private bucket but are **not application-encrypted**. Auth metadata may retain a plaintext full name. Decision emails may contain a student's name and Dean remarks. Authorized browser sessions receive decrypted data; this is not end-to-end encryption.

## Database, Storage, and API

The reviewed SQL defines role-scoped policies, sensitive-column revocations, service-role-only encrypted write RPCs, fixed `search_path` settings for reviewed `SECURITY DEFINER` functions, and a status-change trigger that records history in the same database transaction as the decision. Static inspection cannot prove effective grants, RLS behavior, trigger execution, or transaction rollback in the target database.

Evidence uses a private bucket, role-scoped Storage policies, and short-lived signed URLs. Direct Professor letter paths require approved status and an assigned course; Professor response projections omit Dean comments and guardian contact. These controls need real Supabase negative tests.

Encrypted-data API responses set `Cache-Control: no-store, private`; the two notification endpoints do not. Secret keys are referenced only by server-side modules, while the browser client uses the public publishable key. Secret values were not included in this report.

## Backfill and test coverage

Dry-run paths are read-only by inspection; plaintext clearing is an explicit option and uses CAS. Readiness requires a complete `--all` run with no outstanding encryption/index work or failures. The clear step should additionally read back and verify the resulting row state before plaintext retirement.

The tests cover crypto, tampering, AAD, mocked CAS, and static migration assertions. They do **not** prove actual PostgreSQL JSONB equality filters, RLS, grants, Storage authorization, or transactional behavior. The PostgREST serialization test checks the generated request URL only.

Earlier in this session, `node --test tests/*.test.js` produced 132 passes and one failure: `tests/professor-letters.test.js:493` expects 930px, while `src/styles.css:103` specifies 980px. The mismatch was left unchanged. No database operation, migration, backfill, or deployment was performed.

## Required follow-up and isolated test order

1. Make Phase 9B reproducible without relying on fixed live user/letter rows, or provide a controlled, documented isolated fixture.
2. Provision a disposable Supabase environment; do not use production as a substitute.
3. Apply the full migration sequence and inspect effective grants, RLS policies, function owners/settings, triggers, and constraints.
4. Test Student own/other-student access; assigned/unassigned Dean program access; and Professor assigned/unassigned course access for approved, pending, and rejected letters.
5. Test direct PostgREST column reads and RPC execution, especially Dean comments, historical comments, guardian phone, and sensitive envelopes.
6. Test Storage upload/download and signed URLs for each role, including cross-student and unassigned-Professor denials.
7. Test decisions under transaction rollback and concurrency; verify status/history atomicity.
8. Test JSONB CAS with exact matches, stale plaintext/envelopes, and concurrent updates.
9. Test backfill dry-run produces zero writes, then test explicit clearing and read-back; verify strict-mode rejection of missing/tampered envelopes and wrong keys.

### Verdict

**NOT READY FOR ISOLATED DATABASE TESTING.** The Phase 9B data precondition and unavailable local database tooling prevent a clean, reproducible database test in the current workspace. No confirmed exploitable vulnerability was established by static review, but deployed database and Storage security remain unverified.
