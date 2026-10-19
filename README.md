# UA Digital Excuse Letter System

A static workflow prototype for the University of the Assumption. Its navy, red, and gold identity and locally served seal are based on the official UA site.

## Run locally

From the project folder in PowerShell:

```powershell
py -m http.server 8000
```

Open `http://localhost:8000`. Stop the server with `Ctrl+C`.

## Role pages

- Student: `/student.html` locally, `/student` on Vercel. Submit letters and view personal history.
- Dean/Admin: `/dean.html` locally, `/dean` on Vercel. Review requests and record decisions.
- Professor: `/professor.html` locally, `/professor` on Vercel. View approved letters assigned to their classes.

The login screen opens first. Demo accounts for this prototype are:

| Role | Email | Password |
| --- | --- | --- |
| Student | `mika.student@udu.ph` | `UAstudent2026!` |
| Dean/Admin | `amara.dean@udu.ph` | `UAdean2026!` |
| Professor | `elena.prof@udu.ph` | `UAprof2026!` |

These credentials are hard-coded in the public JavaScript and are only a preview gate, not secure authentication. A user can inspect the source or browser storage. Demo data is stored in browser `localStorage`. Do not use real student information until the login is replaced with Supabase Auth and authorization is enforced by the database policies.

## Database foundation

`supabase/migrations/20261019000000_initial_schema.sql` defines profiles and roles, course offerings and enrollments, excuse letters, evidence metadata, decision history, and row-level security policies. It also creates a private `excuse-evidence` storage bucket with file type and size restrictions. New Auth users receive a student profile by default; only a trusted administrator should provision Dean and professor roles.

The UI is not connected to Supabase yet. Apply and test the migration in a Supabase project, connect the frontend to Supabase Auth and database queries, upload evidence to private Storage, and test with separate student, professor, and Dean accounts before using real data. Confirm UA's official form, retention policy, encryption requirements, and approval authority before launch. The demo image previews remain in browser storage; the database migration describes the intended private storage path.

## Vercel deployment

The app is static and needs no build command or output directory. Import this repository in Vercel using the project root; `vercel.json` defines clean role URLs and baseline security headers. This deploys the workflow demo, not production access control.

When Supabase is connected, configure the public project URL and anon key in Vercel's frontend environment variables. Never put a Supabase service-role key in browser code or frontend environment variables.