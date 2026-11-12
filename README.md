# UA Digital Excuse Letter System

A React/Vite workflow prototype for the University of the Assumption. It retains the prototype's navy, red, and gold identity, responsive dashboards, student submission form, Dean review flow, professor view, and locally served university seal.

## Run locally

Install Node.js and npm, then run these commands from the project folder:

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). Stop the development server with `Ctrl+C`.

Create and preview a production build with:

```powershell
npm run build
npm run preview
```

## Role pages

- Student: `/student.html` locally, `/student` on Vercel. Submit letters and view personal history.
- Dean: `/dean.html` locally, `/dean` on Vercel. Review requests and record decisions.
- Professor: `/professor.html` locally, `/professor` on Vercel. View approved letters assigned to their classes.

The role pages are compatibility redirects into the React application. They do not select a role or grant access. Student excuse letters and enrolled courses are loaded from Supabase. The Dean dashboard loads pending letters and records review decisions through a database-authorized RPC. The Professor dashboard loads the signed-in Professor's assigned course offerings and approved letters through Supabase, with search, course/date filters, refresh, and read-only details. Professor letter, evidence, and private Storage reads rely on RLS; Professors cannot make decisions. A narrowly scoped RPC returns only a student's full name and student number for an approved letter assigned to the authenticated Professor, without granting general profile access. Evidence links are short-lived signed URLs and are only offered when the database authorization rules permit access. Students receive no immediate email when they submit a letter. A Vercel Cron endpoint sends one daily aggregate pending-letter count reminder to each eligible Dean. Students and Deans can view a QR code for a letter they are authorized to access; it contains only an application link and letter ID.

The local hardening migration `supabase/migrations/20261110130000_professor_evidence_access_and_course_rls.sql` adds restrictive RLS policies without dropping or replacing the existing permissive policies. Professor evidence reads and Storage object downloads require a Professor role, an approved letter, and an assigned course. Course-offering reads are additionally scoped to the signed-in Professor's assignments, a Student's enrolled courses, or a Dean's program-authorized related letters. It leaves the Dean program authorization helpers and decision workflow unchanged. After applying all migrations to an isolated local/test database, use authenticated requests to verify: an assigned Professor can read evidence and obtain a signed URL only for approved assigned-course letters; a non-Professor assigned account, an unassigned Professor, a Student, a Professor requesting another Professor's evidence, and requests for pending, disapproved, or unrelated evidence cannot read metadata or obtain a signed URL; direct `course_offerings` queries return only the requester's authorized courses; enrolled Students can still retrieve their courses; and Deans retain course details only for program-authorized letters. Verify objects in other Storage buckets retain their existing policy behavior. Do not run these checks against production as part of this procedure.

The Professor student-identity RPC migration is `supabase/migrations/20261110120000_professor_approved_letter_student_identity.sql`. It returns only a student's full name and student number for an approved letter assigned to the authenticated Professor. It does not change profile or letter RLS policies. After applying it to an isolated local/test database (never as part of this test procedure against production), run the following authorization checks using existing fixture UUIDs:

1. As an assigned Professor, set `request.jwt.claim.sub` to that Professor's Auth/profile UUID and call `SELECT * FROM public.get_professor_approved_letter_student_identity('<approved-letter-assigned-to-this-professor-uuid>');`. Expect exactly one row with only `full_name` and `student_number`.
2. With the same Professor identity, call the RPC with an approved letter belonging to another Professor, a pending letter, a disapproved letter, and a nonexistent UUID. Expect zero rows for each.
3. Set the claim to a valid Student UUID or Dean UUID and call it with an otherwise qualifying approved letter. Expect SQLSTATE `42501` and no identity result.
4. As `authenticated`, set `request.jwt.claim.sub` to the empty string and call the RPC. Expect SQLSTATE `42501`.
5. Inspect the function ACL and verify `authenticated` can execute it while `anon`, `service_role`, and `PUBLIC` cannot. Also confirm there are no new `profiles`, `excuse_letters`, `course_offerings`, or Storage policies.

For each claim scenario in a SQL session, use `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '<fixture-user-uuid-or-empty-string>', true);` before the RPC call and `ROLLBACK;` afterward. An expected authorization exception aborts that transaction; issue `ROLLBACK;` before starting the next scenario.

## Database foundation

`supabase/migrations/20261019000000_initial_schema.sql` defines profiles and roles, course offerings and enrollments, excuse letters, evidence metadata, decision history, and row-level security policies. It also creates a private `excuse-evidence` storage bucket with file type and size restrictions. The student letter workflow uses this schema and RLS. Apply `supabase/migrations/20261102142400_require_student_role_for_letter_insert.sql` to require the `student` profile role and match each inserted letter's course to the student's enrollment in the database policy.

Before using real data, connect and test Supabase Auth, database queries, RLS authorization, and private Storage with separate student, professor, and Dean accounts. Confirm UA's official form, retention policy, encryption requirements, and approval authority before launch.

## Supabase client and authentication configuration

The centralized browser client is in `src/lib/supabase.js`. Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`: the Supabase project base URL (not the `/rest/v1` API endpoint).
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the project's Supabase publishable key. This public key is intended for browser use; database access must be protected by RLS.

Restart the Vite development server after changing environment variables. The login uses Supabase Auth email/password sign-in, and Supabase's client manages session persistence and refresh. The app checks the existing session at startup and responds to Auth state changes. No demo passwords are provided or accepted by the application.

Vite embeds variables prefixed with `VITE_` into browser code. Only use the Supabase publishable key here. Never put a secret key, legacy service-role key, password, or other server credential in a `VITE_` variable.

### Daily Dean digest email

The email sender is `api/send-dean-daily-digest.js`, a Vercel serverless function invoked by the daily schedule in `vercel.json`. Configure these values in Vercel Project Settings → Environment Variables (or in a local Vercel environment file, never in browser-prefixed variables):

- `SUPABASE_URL`: the same Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the server-only Supabase service key, passed directly to the shared server client. Never expose or commit it.
- `GMAIL_USER`: the Gmail account used as the sender.
- `GMAIL_APP_PASSWORD`: an app password created for that Gmail account (enable 2-Step Verification first). Do not use the account's normal password.
- `APP_URL`: the canonical HTTPS deployment origin, such as `https://your-app.example.com`.
- `CRON_SECRET`: a randomly generated secret with at least 32 characters. Vercel sends it as a Bearer authorization header to the scheduled endpoint. Never add it to `vercel.json` or a `VITE_` variable.

The endpoint calls `claim_dean_daily_digests` and `finish_dean_daily_digest`. The initial digest migration and follow-up migration `supabase/migrations/20261112100000_send_daily_dean_reminder_without_pending_letters.sql` create/update an RLS-protected delivery log and two `SECURITY DEFINER` functions executable only by `service_role`. The aggregation includes Deans with confirmed Auth emails and active assignments to active programs; it includes zero when no letters are pending. Multiple programs assigned to one Dean are combined into one count. A daily reminder is sent even when the pending count is zero. The email is sent from `GMAIL_USER` to the confirmed Dean Auth email and contains only the aggregate count and a `/dean` link, not student or letter details.

Claims are unique per Dean and Philippine calendar day. A failed delivery can be retried after five minutes. Abandoned `sending` claims are marked failed after 15 minutes; the digest is only reclaimed for delivery if the Dean is still eligible. A successful delivery is never reclaimed. SMTP cannot guarantee exactly-once delivery if Gmail accepts a message but the function crashes before recording success; the database claim minimizes, but cannot eliminate, that ambiguity. Failed deliveries are recorded without storing credentials or student details. Vercel Cron invokes the endpoint using `GET /api/send-dean-daily-digest` and includes `CRON_SECRET` as a Bearer authorization header; ordinary requests without that secret are rejected. An authorized retry during the same Philippine calendar day can re-run the endpoint; the delivery log suppresses already-sent digests.

The Vercel Cron expression is `0 0 * * *`: midnight UTC, or 8:00 AM in the Philippines. Cron registration and execution require a production deployment and are not proven by local builds. Vercel Hobby plans allow daily cron jobs but may run them with up to 59 minutes of timing variance; function execution and usage limits also apply. See Vercel's [Cron quickstart](https://vercel.com/docs/cron-jobs/quickstart) and [Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

### Student decision email notifications

After `decide_excuse_letter` successfully saves an approval or rejection, the app makes a separate request to `api/notify-student-decision.js`. The API verifies the Dean's Supabase session. Its database RPC then verifies the saved decision, status event, and current active Dean/program assignment; the browser cannot select the decision or recipient. The recipient is read from the student's Supabase Auth user and must have a confirmed email. An absent or unconfirmed email is recorded as a failure and no email is sent. The email contains the decision, letter ID, relevant dates, and (for rejection) the Dean's remarks or a neutral fallback. It does not contain the excuse reason, evidence, or private file links. Its link opens the exact letter after sign-in and remains subject to student ownership checks. Email failure does not reverse the saved decision.

The migration `supabase/migrations/20261110000000_student_decision_email_notifications.sql` follows the daily digest migration and creates an RLS-protected notification log plus service-role-only RPCs. The API calls `claim_student_decision_notification` and `finish_student_decision_notification`; the claim RPC verifies the saved decision, status event, and active Dean/program assignment. It requires `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` for Dean session verification, `SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `APP_URL`. The Dean sees whether delivery succeeded, and can retry a failed email from the letter detail. A retry is limited to the Dean who made the decision, and failed attempts can be retried after five minutes. Stale sends can be reclaimed after 15 minutes. A unique letter/decision key prevents repeat sends after success and serializes simultaneous requests. SMTP cannot provide exactly-once delivery if Gmail accepts a message but the function loses confirmation before recording success; a later retry after the stale-claim period could send a duplicate. The decision remains saved regardless of email failure.

Do not call the notification endpoint with another student's ID or an arbitrary recipient; authorization and the saved decision are checked server-side. Test with controlled accounts only. No live Gmail delivery or production deployment is implied by local build/smoke checks.

The earlier migration `supabase/migrations/20261108000000_dean_email_notification_recipients.sql` creates `get_excuse_letter_notification_recipients(uuid)`. No current API calls it: the digest obtains recipients and counts through `claim_dean_daily_digests`, while student decision notifications use the student's Auth email. It is not required by either active notification route and is retained pending a decision about its migration status. Apply notification migrations in timestamp order: 20261108 recipient helper, 20261109 initial Dean digest, 20261110 student decision notifications, then 20261112 zero-pending Dean reminders. No migration is run by the local build.

`npm run dev` starts only the Vite frontend, not Vercel API functions or Cron. To test the API locally, use `vercel dev` with server environment variables configured in a local ignored environment file. Do not put secret values in chat, source code, `.env.example`, or frontend variables.

This project uses npm as its canonical package manager: `package-lock.json` is the lockfile tracked in repository history, and local/Vercel commands use npm. `package.json` declares the npm version, and Vercel is configured to run `npm ci`. The untracked pnpm lock/workspace files are retained in the worktree but are not active installation configuration; use npm unless intentionally switching package managers. Review whether those pnpm files belong in a future commit before staging.

After Supabase Auth restores or establishes a session, the app looks up the matching `profiles` row by the authenticated user's UUID through the normal browser client and RLS. Only `student`, `professor`, and `dean` roles are accepted; a missing profile, unsupported role, or failed lookup blocks the dashboard. Students can select enrolled courses, create letters, and read their own letters and permitted status history through RLS. Letter ownership, student role, course enrollment, and initial `pending` status are enforced by the database policy and defaults. Students can optionally select PDF, JPG/JPEG, and PNG evidence (up to 8 MiB per file) while creating a letter; the app inserts the letter first, then uploads each file and inserts its metadata using the real letter UUID. Evidence uses the private `excuse-evidence` bucket and `excuse_evidence` table; files are available through short-lived signed URLs after ownership checks. The migrations `supabase/migrations/20261102151000_secure_student_evidence_storage.sql` and `supabase/migrations/20261102154300_allow_safe_orphan_evidence_cleanup.sql` secure evidence storage and orphan cleanup. If evidence upload fails after letter creation, the letter remains pending, successfully recorded evidence stays attached, and the UI directs the student to review the letter and add remaining evidence. The initial letter status is not written to `letter_status_events`; the existing trigger records later status changes. Phase 8 secures Dean decisions through `decide_excuse_letter`, removes direct authenticated decision updates, and relies on the status-change trigger for audit history; see `supabase/migrations/20261102173200_secure_dean_letter_decisions.sql`. Phase 9B adds the academic program registry, student program linkage, and guarded Dean/program assignment history; it does not seed an assignment. Phase 9C restricts Dean letter, evidence, and related profile access to actively assigned programs and applies the same assignment check inside the decision RPC; its migration is `supabase/migrations/20261107170000_phase9c_dean_program_authorization.sql`. The Phase 8, 9B, and 9C migrations have been applied in the reviewed Supabase environment. Dean assignments are provisioned separately through a controlled administrative process, not by the migrations. The Professor review workflow is not implemented. Other prototype data may still use browser `localStorage`; it is not the source of truth for student letters or authorization.

Students without `program_id` see a setup message and cannot open or submit a new letter in the UI; this frontend check is not an authorization boundary.

Each new excuse-letter submission requires a parent/guardian phone number. It is stored separately from the letter so only the owning Student and a Dean authorized for that letter can read it; Professors cannot access the contact table. Apply `supabase/migrations/20261112180000_parent_guardian_contact.sql` before using this field.

## Vercel deployment

Import this repository in Vercel using the project root. Use `npm ci` as the install command, `npm run build` as the build command, and `dist` as the output directory. `vite.config.js` includes the role redirect pages in the build, and `vercel.json` retains the clean role URLs and baseline security headers. This deploys the workflow demo, not production access control.

When deploying, configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Vercel frontend environment variables, and configure the Gmail/server variables listed above as server-only environment variables. Add `CRON_SECRET` in Vercel Project Settings, then redeploy to register the schedule. Never put a Supabase secret or service-role key in browser code or frontend environment variables.
