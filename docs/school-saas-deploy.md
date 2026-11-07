# School Manager SaaS — Render deployment guide

All 8 phases are built and verified (57/57 tests, 2026-11-07). The full ERP is ready to deploy. Deployment needs accounts the
user must create themselves (email verification codes go to the user's
inbox): a GitHub account and a Render account. No code is deployed
anywhere yet.

## What you are deploying

- **Web service:** Node.js + Express API + vanilla frontend (landing,
  school registration, login, school dashboard, super-admin dashboard).
  Full ERP: 12 roles, students/teachers, attendance, fees, exams,
  homework, timetable, parent/teacher/student portals, transport,
  library, inventory, HR/payroll, analytics, reports, audit log.
- **Database:** PostgreSQL (schools, users, classes, students, RLS
  policies, migration tracking).
- **Needs only:** `DATABASE_URL` + `JWT_SECRET` (+ `PORT`, set by Render).

## Step 1 — Put the code on GitHub

On a machine with git (or GitHub Desktop):

```bash
cd school-saas
git init
git add .
git commit -m "School Manager SaaS — all 8 phases"
git branch -M main
git remote add origin https://github.com/<your-username>/school-saas.git
git push -u origin main
```

(Replace `<your-username>` with the GitHub username. The repository
must be public, or Render must be given access to the private repo.)

## Step 2 — Create the Render account

1. Go to https://render.com and sign up (email sign-up is fine).
2. No credit card is required for the free tier.

## Step 3 — Deploy from the Blueprint

1. In the Render dashboard: **New → Blueprint**.
2. Connect the `school-saas` GitHub repository.
3. Render reads `render.yaml` and shows one web service (`school-saas`)
   and one database (`school-saas-db`). Click **Apply**.
4. Wait for the build. The `preDeployCommand` (`npm run migrate`)
   applies migrations 001–016 automatically before the service starts.
5. When the service is live, open `https://school-saas.onrender.com/api/health`
   — it must return `{"status":"ok"}`.
6. Open `https://school-saas.onrender.com/` — the landing page loads,
   with school registration and login forms.

## Step 4 — Register the first school, then the super-admin

There is no super-admin account until you create one:

1. On the landing page, register a school (name, slug, admin name,
   email, password). This creates the school + its first school_admin.
2. In the Render dashboard, open the `school-saas-db` database and use
   its **PSQL command** (or any Postgres client) to promote a user:

```sql
-- Promote the school admin you just registered to super_admin.
-- (Their school_id becomes NULL, so they manage ALL schools.)
UPDATE users SET role = 'super_admin', school_id = NULL
WHERE email = 'you@example.com';
```

3. Log in on the landing page with **email + password only** (leave the
   school slug empty) — super-admins log in without a slug.
4. You land on the super-admin dashboard: all schools, user counts,
   Suspend / Activate buttons.

## Step 5 — Onboard a school

Give a school its link + slug. The school registers itself on the
landing page (or the super-admin registers it), then its school_admin
creates teacher / parent / student accounts from the dashboard
(School dashboard → Users). Teachers see only their assigned classes;
parents see only their linked child.

## Honest free-tier limits (Render Free — DEMO ONLY)

- **Web service sleeps after 15 minutes idle** — the first request
  after idle takes ~1 minute to wake the service.
- **Free PostgreSQL EXPIRES 30 days after creation** (14-day grace,
  then the database is deleted with all data). There are no backups
  on the free plan. Do not run real schools on it.
- **750 free instance hours/month** — roughly one always-on service.
- The app binds to `process.env.PORT` and needs no other services.

## Upgrade path (when real schools go live)

- **Render paid:** web service Starter ~$7/month + PostgreSQL Basic
  ~$6/month ≈ $13/month. Paid databases do not expire and include
  backups. In `render.yaml`, change both `plan: free` entries to the
  paid plans and re-apply the Blueprint.
- **Hostinger VPS (recommended for production in Pakistan):** KVM 1
  (~Rs 2,099/month, 1 vCPU / 4 GB RAM / 50 GB NVMe) runs Node +
  PostgreSQL permanently with no sleep and no database expiry.
  Requires a VPS product — shared web hosting cannot run this app.
- **Before production:** a backup routine (`pg_dump` on a schedule),
  and per-school data export. (Phases 2–8 — attendance, fees, exams,
  portals, transport, library, inventory, HR/payroll, analytics — are
  already built and verified.)

## Local run (for developers)

```bash
npm install
# PostgreSQL running locally, database created:
#   createdb school_saas_test   (or any name)
DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/school_saas_test \
JWT_SECRET=<long-random-secret> npm run migrate
DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/school_saas_test \
JWT_SECRET=<long-random-secret> npm start
# Open http://localhost:3000 — landing page.
# Tests: DATABASE_URL=... JWT_SECRET=... npm test
```

## Troubleshooting

- **"DATABASE_URL is not set" / "JWT_SECRET is not set":** the server
  refuses to boot without them — set both in the environment.
- **Health check fails on Render:** check the deploy logs for the
  `preDeployCommand` migration output; a failed migration blocks the
  deploy (fix the migration, push, redeploy).
- **Login says "school suspended":** a super-admin suspended the
  school — reactivate it from the super-admin dashboard.
- **"Invalid email or password" for a school user:** make sure the
  school slug in the login form matches the school they belong to —
  the same email can exist in several schools, and the slug is what
  disambiguates them.
