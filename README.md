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

The role pages are compatibility redirects into the React application. Demo accounts for this prototype are:

| Role | Email | Password |
| --- | --- | --- |
| Student | `mika.student@udu.ph` | `UAstudent2026!` |
| Dean/Admin | `amara.dean@udu.ph` | `UAdean2026!` |
| Professor | `elena.prof@udu.ph` | `UAprof2026!` |

These credentials are hard-coded in public JavaScript and are only a preview gate, not secure authentication. A user can inspect the source or browser storage. Demo records and evidence previews are stored in browser `localStorage`; the demo session is held in `sessionStorage`. Do not use real student information. Supabase Auth and database authorization have not been implemented.

## Database foundation

`supabase/migrations/20261019000000_initial_schema.sql` defines profiles and roles, course offerings and enrollments, excuse letters, evidence metadata, decision history, and row-level security policies. It also creates a private `excuse-evidence` storage bucket with file type and size restrictions. The React prototype is not connected to Supabase. Do not treat the migration or client-side demo role checks as production security.

Before using real data, connect and test Supabase Auth, database queries, RLS authorization, and private Storage with separate student, professor, and Dean accounts. Confirm UA's official form, retention policy, encryption requirements, and approval authority before launch. The prototype only prepares local notification entries; it does not send email.

## Supabase client configuration

The centralized browser client is in `src/lib/supabase.js`. Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`: the Supabase project URL.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the project's Supabase publishable key. This public key is intended for browser use; database access must be protected by RLS.

Vite embeds variables prefixed with `VITE_` into browser code. Only use the Supabase publishable key here. Never put a secret key, legacy service-role key, password, or other server credential in a `VITE_` variable. The client is only configuration groundwork at this stage; authentication and database workflows are not implemented.

## Vercel deployment

Import this repository in Vercel using the project root. Use `npm run build` as the build command and `dist` as the output directory. `vite.config.js` includes the role redirect pages in the build, and `vercel.json` retains the clean role URLs and baseline security headers. This deploys the workflow demo, not production access control.

When deploying, configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Vercel frontend environment variables. Never put a Supabase secret or service-role key in browser code or frontend environment variables.
