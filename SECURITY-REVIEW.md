# Phase 7 Student Evidence Security Review

Review scope: read-only review of the Phase 7 student evidence feature, its Storage/database policies, and its interaction with the existing Phase 5/6 security boundaries. No production deployment or remote migration was performed.

## Result

No Critical, High, or Medium severity security vulnerability was identified. Authentication, student-role verification, letter ownership, pending status, generated storage paths, private-bucket use, and short-lived signed URLs are enforced by the service and/or database policies.

| # | Severity | File | Lines | Finding | Confidence |
|---|----------|------|-------|---------|------------|
| 1 | ⚪ LOW | `src/services/studentEvidence.js` | 104-120 | If a letter is approved after the Storage upload succeeds but before the evidence metadata insert, the metadata insert is denied because the letter is no longer pending. The compensating Storage delete can also be denied by the pending-only delete policy in `supabase/migrations/20261102151000_secure_student_evidence_storage.sql` (68-82), leaving an inaccessible private object without a database record. | 9/10 |

This is a low-severity data-integrity issue, not an authorization bypass. Consider a narrowly scoped cleanup path for failed metadata inserts that retains authenticated-owner and generated-path checks without requiring the letter to remain pending.

## Security checks

- **PASS** — Evidence service requires a Supabase Auth user and checks that the user's profile role is `student`.
- **PASS** — The service verifies the letter is owned by that Auth UUID and is pending before upload; database and Storage policies independently enforce ownership and pending status.
- **PASS** — Object paths use the Auth UUID, letter UUID, and a generated UUID filename. Storage policies validate the path and its relationship to the owned letter.
- **PASS** — The migration sets the `excuse-evidence` bucket to private and limits it to PDF, JPEG, and PNG with an 8 MiB maximum. Frontend validation rejects other MIME types, empty files, and oversized files.
- **PASS** — Evidence access uses temporary signed URLs (60 seconds); the client does not create public URLs.
- **PASS** — Existing evidence reads require a visible related letter. Student access is scoped to the student's own letters; existing Dean and approved-professor access is preserved.
- **PASS** — No evidence update or delete UI is provided. The migration adds only a narrowly scoped Storage delete policy for compensating cleanup of the authenticated student's generated-path uploads for their own pending letter.
- **PASS** — No service-role key or privileged Supabase credential was found in frontend source. `.env.local` is ignored and not tracked.
- **PASS** — The Phase 5/6 letter/profile authorization policies were not weakened by the Phase 7 changes reviewed.
- **PASS** — No broad anonymous bucket/table access was found in the reviewed policies.
- **NOT LIVE-VERIFIED** — The new migration was not applied to the remote Supabase project during this review. Authenticated upload, signed-URL access, and cross-student negative tests were not performed.

## Validation

- `npm.cmd run build` — passed; Vite reported a bundle-size warning.
- `git diff --check` — passed.
- `.env.local` — ignored by Git and not tracked; contents were not read.

## Recommendation

The implementation has no identified security blocker. The low-severity race can leave an orphaned private object, so consider addressing it before production use. Apply and verify the new migration in a non-production environment before enabling evidence uploads.
