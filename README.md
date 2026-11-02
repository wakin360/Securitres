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
- Dean/Admin: `/dean.html` locally, `/dean` on Vercel. Review requests and record decisions.
- Professor: `/professor.html` locally, `/professor` on Vercel. View approved letters assigned to their classes.

The role pages are compatibility redirects into the React application. They do not select a role or grant access. Student excuse letters and enrolled courses are loaded from Supabase; the Dean and Professor dashboards, notifications, assignments, and evidence examples remain prototypes and are not database workflows. Do not use real student information outside the authenticated student letter workflow.

## Database foundation

`supabase/migrations/20261019000000_initial_schema.sql` defines profiles and roles, course offerings and enrollments, excuse letters, evidence metadata, decision history, and row-level security policies. It also creates a private `excuse-evidence` storage bucket with file type and size restrictions. The student letter workflow uses this schema and RLS. Apply `supabase/migrations/20261102142400_require_student_role_for_letter_insert.sql` to require the `student` profile role and match each inserted letter's course to the student's enrollment in the database policy. The Dean and Professor workflows are not implemented against the database.

Before using real data, connect and test Supabase Auth, database queries, RLS authorization, and private Storage with separate student, professor, and Dean accounts. Confirm UA's official form, retention policy, encryption requirements, and approval authority before launch. The prototype only prepares local notification entries; it does not send email.

## Supabase client and authentication configuration

The centralized browser client is in `src/lib/supabase.js`. Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`: the Supabase project base URL (not the `/rest/v1` API endpoint).
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the project's Supabase publishable key. This public key is intended for browser use; database access must be protected by RLS.

Restart the Vite development server after changing environment variables. The login uses Supabase Auth email/password sign-in, and Supabase's client manages session persistence and refresh. The app checks the existing session at startup and responds to Auth state changes. No demo passwords are provided or accepted by the application.

Vite embeds variables prefixed with `VITE_` into browser code. Only use the Supabase publishable key here. Never put a secret key, legacy service-role key, password, or other server credential in a `VITE_` variable.

After Supabase Auth restores or establishes a session, the app looks up the matching `profiles` row by the authenticated user's UUID through the normal browser client and RLS. Only `student`, `professor`, and `dean` roles are accepted; a missing profile, unsupported role, or failed lookup blocks the dashboard. Students can select enrolled courses, create letters, and read their own letters and permitted status history through RLS. Letter ownership, student role, course enrollment, and initial `pending` status are enforced by the database policy and defaults. The initial status is not written to `letter_status_events`; the existing trigger records later status changes. Evidence uploads, Dean decisions, and Professor review are not implemented. Other prototype data may still use browser `localStorage`; it is not the source of truth for student letters or authorization.

## Vercel deployment

Import this repository in Vercel using the project root. Use `npm run build` as the build command and `dist` as the output directory. `vite.config.js` includes the role redirect pages in the build, and `vercel.json` retains the clean role URLs and baseline security headers. This deploys the workflow demo, not production access control.

When deploying, configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Vercel frontend environment variables. Never put a Supabase secret or service-role key in browser code or frontend environment variables.
