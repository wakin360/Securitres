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

The role pages are compatibility redirects into the React application. They do not select a role or grant access. Student excuse letters and enrolled courses are loaded from Supabase. The Dean dashboard loads pending letters and records review decisions through a database-authorized RPC; the Professor dashboard, notifications, and assignments remain prototypes and are not database workflows. Do not use real student information outside authenticated student and Dean workflows.

## Database foundation

`supabase/migrations/20261019000000_initial_schema.sql` defines profiles and roles, course offerings and enrollments, excuse letters, evidence metadata, decision history, and row-level security policies. It also creates a private `excuse-evidence` storage bucket with file type and size restrictions. The student letter workflow uses this schema and RLS. Apply `supabase/migrations/20261102142400_require_student_role_for_letter_insert.sql` to require the `student` profile role and match each inserted letter's course to the student's enrollment in the database policy.

Before using real data, connect and test Supabase Auth, database queries, RLS authorization, and private Storage with separate student, professor, and Dean accounts. Confirm UA's official form, retention policy, encryption requirements, and approval authority before launch. The prototype only prepares local notification entries; it does not send email.

## Supabase client and authentication configuration

The centralized browser client is in `src/lib/supabase.js`. Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`: the Supabase project base URL (not the `/rest/v1` API endpoint).
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the project's Supabase publishable key. This public key is intended for browser use; database access must be protected by RLS.

Restart the Vite development server after changing environment variables. The login uses Supabase Auth email/password sign-in, and Supabase's client manages session persistence and refresh. The app checks the existing session at startup and responds to Auth state changes. No demo passwords are provided or accepted by the application.

Vite embeds variables prefixed with `VITE_` into browser code. Only use the Supabase publishable key here. Never put a secret key, legacy service-role key, password, or other server credential in a `VITE_` variable.

After Supabase Auth restores or establishes a session, the app looks up the matching `profiles` row by the authenticated user's UUID through the normal browser client and RLS. Only `student`, `professor`, and `dean` roles are accepted; a missing profile, unsupported role, or failed lookup blocks the dashboard. Students can select enrolled courses, create letters, and read their own letters and permitted status history through RLS. Letter ownership, student role, course enrollment, and initial `pending` status are enforced by the database policy and defaults. Students can optionally select PDF, JPG/JPEG, and PNG evidence (up to 8 MiB per file) while creating a letter; the app inserts the letter first, then uploads each file and inserts its metadata using the real letter UUID. Evidence uses the private `excuse-evidence` bucket and `excuse_evidence` table; files are available through short-lived signed URLs after ownership checks. The migrations `supabase/migrations/20261102151000_secure_student_evidence_storage.sql` and `supabase/migrations/20261102154300_allow_safe_orphan_evidence_cleanup.sql` secure evidence storage and orphan cleanup. If evidence upload fails after letter creation, the letter remains pending, successfully recorded evidence stays attached, and the UI directs the student to review the letter and add remaining evidence. The initial letter status is not written to `letter_status_events`; the existing trigger records later status changes. Phase 8 secures Dean decisions through `decide_excuse_letter`, removes direct authenticated decision updates, and relies on the status-change trigger for audit history; see `supabase/migrations/20261102173200_secure_dean_letter_decisions.sql`. Phase 9B adds the academic program registry, student program linkage, and guarded Dean/program assignment history; it does not seed an assignment. Phase 9C restricts Dean letter, evidence, and related profile access to actively assigned programs and applies the same assignment check inside the decision RPC; its migration is `supabase/migrations/20261107170000_phase9c_dean_program_authorization.sql`. The Phase 8, 9B, and 9C migrations have been applied in the reviewed Supabase environment. Dean assignments are provisioned separately through a controlled administrative process, not by the migrations. The Professor review workflow is not implemented. Other prototype data may still use browser `localStorage`; it is not the source of truth for student letters or authorization.

Students without `program_id` see a setup message and cannot open or submit a new letter in the UI; this frontend check is not an authorization boundary.

## Vercel deployment

Import this repository in Vercel using the project root. Use `npm run build` as the build command and `dist` as the output directory. `vite.config.js` includes the role redirect pages in the build, and `vercel.json` retains the clean role URLs and baseline security headers. This deploys the workflow demo, not production access control.

When deploying, configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Vercel frontend environment variables. Never put a Supabase secret or service-role key in browser code or frontend environment variables.
