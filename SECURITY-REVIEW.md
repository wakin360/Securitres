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
