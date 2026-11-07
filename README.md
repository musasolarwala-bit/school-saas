# School Manager SaaS — multi-school cloud platform

**One app, launched across many schools.** Each school is a separate
tenant with fully isolated data. Students, parents and teachers each
log in with their OWN account and see live data — unlike the offline
School Manager APK, where data lives only on one phone.

Original branding only: this project is called "School Manager". It is
not affiliated with any other school software product.

## Stage 1 — foundation (this build)

- **Tenants:** schools (`db/migrations/001_schools.sql`) — name, unique
  slug, phone, address, session (default `2026-27`), status
  active/suspended.
- **Users** (`002_users.sql`): `super_admin` (manages all schools,
  `school_id` NULL), `school_admin`, `teacher`, `parent`, `student`.
  (Phase 1 widened the role set to 12 — see the Phase 1 section.)
  Emails are unique per school (`UNIQUE(email, school_id)`), so the
  same email can exist in different schools — the school slug at
  login disambiguates them. Parent/student accounts link to a student
  record (`linked_student_id`).
- **Classes + students** (`003_classes_students.sql`): classes belong
  to a school and may be assigned a teacher (a teacher's user row);
  students belong to a class, with roll numbers unique per
  (class, section) within a school.
- **Auth:** local only — bcryptjs (10 rounds) + JWT (24h). No
  Supabase, no WhatsApp API, no external auth provider.
  - `POST /api/auth/register-school` — creates a school + its first
    school_admin in one atomic transaction.
  - `POST /api/auth/login` — school users send `{ slug, email,
    password }`; super-admins send `{ email, password }` (no slug).
  - `GET /api/auth/me` — current user + school.
- **Tenant isolation, two layers:**
  1. **API layer (the binding layer):** every school route runs inside
     a tenant transaction (`app.tenant_id` session variable) AND every
     query carries an explicit `school_id = caller` filter. Role gates
     (`school_admin` / `teacher` / `parent` / `student`) are enforced
     server-side; the frontend only hides UI.
  2. **Database layer (RLS):** `ROW LEVEL SECURITY` policies on every
     school table keyed off `app.tenant_id`. Note: PostgreSQL does not
     apply RLS to the table owner, and the app connects as owner on
     Render — so RLS binds non-owner connections (future restricted
     roles, read-only users), while the API layer binds the app
     itself. Both layers are tested.
- **Role visibility:** school_admin sees all of their school; a
  teacher sees only their assigned classes' students; a parent or
  student sees only the linked student record. Cross-school access
  returns 404 (no existence leak), cross-school writes are rejected.
- **Super-admin:** list schools with user counts, suspend a school
  (logins AND existing tokens immediately get 403 — status is
  re-checked on every school request), activate it again.
- **Frontend:** vanilla HTML/CSS/JS, no build step — landing page
  (register + login), school dashboard (users, classes, students),
  super-admin dashboard.
- **Deployment:** binds to `process.env.PORT`, needs only
  `DATABASE_URL` + `JWT_SECRET`. `render.yaml` (free web + free
  Postgres) + `docs/school-saas-deploy.md` (exact Render steps,
  first-super-admin SQL, honest free-tier limits).

## Project layout

```
school-saas/
  server/
    index.js            Express app factory + boot (exports createApp for tests)
    config.js           env config (fails fast when DATABASE_URL/JWT_SECRET missing)
    lib/db.js           pg pool + withTenant() transaction helper
    lib/auth.js         bcrypt + JWT helpers
    lib/middleware.js   requireAuth / requireRole / requireCapability / requireSchool / withSchoolDb
    lib/validate.js     server-side input validators
    lib/permissions.js  role -> capability matrix, the single source of truth (Phase 1)
    lib/subscriptions.js subscription status + student-creation gate (Phase 1)
    lib/csv.js          CSV write/parse helpers (Phase 2)
    lib/scope.js        teacher class scope + parent link helpers (Phases 2/3)
    lib/fees.js         discounts / late fines / outstanding math (Phase 3)
    lib/notify.js       in-app notification creation (Phase 3)
    lib/grades.js       grading scale + result/GPA/position computation (Phase 4)
    lib/audit.js        audit-log writer, same-transaction (Phase 8)
    routes/auth.js      register-school, login, me
    routes/schools.js   super-admin: list schools, suspend, activate
    routes/subscriptions.js super-admin: plans CRUD, subscriptions, payments (Phase 1)
    routes/users.js     users:manage roles: create/list/deactivate users
    routes/classes.js   classes CRUD + role visibility
    routes/students.js  students CRUD, CSV import/export, promote, history, documents (Phase 2)
    routes/staff.js     staff profiles CRUD (Phase 2)
    routes/subjects.js  subjects + class/teacher subject assignments (Phase 2)
    routes/sessions.js  academic sessions (Phase 2)
    routes/attendance.js student attendance: bulk mark, sheets, reports, CSV (Phase 3)
    routes/staffAttendance.js staff attendance (Phase 3)
    routes/notifications.js in-app notifications list/read (Phase 3)
    routes/dashboard.js role-aware dashboard payload, real numbers (Phase 2)
    routes/fees.js      fee heads, plans, payments, discounts, vouchers, defaulters, receipts, reports (Phase 3)
    routes/accounts.js  expense/income categories + records, cashbook, profit & loss (Phase 3)
    routes/exams.js     terms, grading, exams, bulk marks, results, merit, report cards (Phase 4)
    routes/homework.js  homework + submissions lifecycle (Phase 5)
    routes/timetable.js timetable slots with conflict detection (Phase 5)
    routes/portals.js   parent/student + teacher portal aggregates (Phase 5)
    routes/transport.js vehicles, routes, stops, assignments, manifests (Phase 6)
    routes/library.js   books, loans, returns, overdue reporting (Phase 6)
    routes/inventory.js categories, items, stock movements, condition (Phase 6)
    routes/hr.js        leave requests + payroll runs / payslips (Phase 7)
    routes/analytics.js enrollment / attendance / fee analytics (Phase 8)
    routes/reports.js   report-centre CSV exports + audit log (Phase 8)
    routes/settings.js  school branding settings (Phase 1)
    routes/public.js    unauthenticated public branding endpoint (Phase 1)
  db/migrations/        001_schools, 002_users, 003_classes_students,
                        004_attendance, 005_fees, 006_roles,
                        007_subscriptions, 008_branding,
                        009_students_academic, 010_attendance_notifications,
                        011_fees_accounts, 012_exams, 013_learning,
                        014_transport, 015_library_inventory, 016_hr_audit
  scripts/migrate.js    idempotent migration runner (schema_migrations)
  public/               index.html (landing), dashboard.html, admin.html, app.js, styles.css
  tests/run.js          57 tests (node:test, real Postgres, HTTP + direct-DB RLS)
  render.yaml           Render Blueprint (free web + free Postgres)
  docs/school-saas-deploy.md
```

## Run locally

```bash
npm install
DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/school_saas_test \
JWT_SECRET=<long-random-secret> npm run migrate
DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/school_saas_test \
JWT_SECRET=<long-random-secret> npm start   # http://localhost:3000
DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/school_saas_test \
JWT_SECRET=<long-random-secret> npm test    # 57 tests, must all pass
```

## Stage 2 — attendance + fees in the multi-tenant API (done)

Attendance and fees were ported from the offline app in Stage 2 and
then **completed in Phase 2 and Phase 3** (see the two sections below
for the full feature list): bulk attendance with parent notifications,
staff attendance, fee discounts, late fines, bulk vouchers,
defaulters, printable receipts, collection reports, and a cashbook /
profit & loss. **Phases 4–8 (below) complete the remaining modules:**
exams & results, homework, timetable, portals, transport, library,
inventory, HR/payroll, analytics, reports and the audit log. Still
not ported from the offline APK: Books & Stationery Shop, Uniforms
and Exam Papers (small retail/print modules), and a backup routine.

## Phase 1 — roles, subscriptions, branding (done, 2026-11-07)

**Roles 5 → 12** (`db/migrations/006_roles.sql`). The single source of
truth is the capability matrix in `server/lib/permissions.js`, enforced
via `requireCapability()` / `can()` in the routes (route handlers keep
their finer scoping: teacher → own classes, parent/student → linked
child). Summary:

| Role | Can do |
|---|---|
| super_admin | Platform panel: schools, packages, subscriptions, payments |
| school_owner | Same as school_admin, own school |
| school_admin | Everything in own school: users, students, classes, attendance, fees, branding |
| principal | Read-all school data (students, classes, attendance, fees) — writes nothing |
| accountant | Fees read + write, student read — no student writes/deletes |
| hr_manager | User/staff management — no fees |
| teacher | Own classes: students read, attendance read + write |
| parent / student | Own linked child: record, attendance summary, fee summary |
| transport_manager / librarian / receptionist | Student + class read; their own modules landed in Phase 6 (transport / library read+write for the manager and librarian, read-only lookups for receptionist) — still gated OUT of fees and attendance writes |

Any school role except super_admin can be created via
`POST /api/school/users` by a role holding `users:manage`
(school_admin, school_owner, hr_manager). Fee writes moved from
"school_admin only" to the `fees:write` capability, so the accountant
can run fees; the principal reads fee configuration and summaries.

**Subscriptions** (`007_subscriptions.sql`). Pricing is BY DURATION —
one price buys a whole period (packages seeded, all editable by the
super admin):

| Package | Price | Period |
|---|---|---|
| 12 Months | Rs 5,000 | 12 months |
| 24 Months | Rs 8,000 | 24 months |
| 36 Months | Rs 12,000 | 36 months |
| Lifetime | Rs 20,000 | never expires (`expires_at` NULL) |

Rules:

- Registering a school starts a **30-day free trial** (no package, no
  student limit). Schools that existed before this migration were
  backfilled with the same trial.
- `POST /api/admin/schools/:id/subscription/payment` records a payment
  (amount defaults to the package price) and extends the expiry by the
  package period, counting from the later of now and the current
  expiry — renewing early never loses paid time. A Lifetime payment
  clears the expiry. `.../subscription/assign` (re)starts a package
  from today without a payment. Payment history (with a period
  snapshot, since packages are editable) is kept in
  `subscription_payments`.
- `student_limit` lives on the school's subscription, not the package:
  NULL = unlimited (the seeded state), and the super admin can set or
  clear it per school (`PATCH /api/admin/schools/:id/subscription`).
  It counts ACTIVE students only.
- Enforcement: creating a student while the subscription is expired
  or suspended, or at the student limit, returns **403** with a clear
  message. Logins and reads keep working on an expired subscription.
  `GET /api/auth/me` exposes `subscription: { status, plan_name,
  starts_at, expires_at, student_limit }` (status is the EFFECTIVE
  status — a trial/active row past its expiry reports `expired`).
- The super-admin panel lists every school's plan, status and expiry,
  and has package CRUD plus per-school assign / payment / limit forms.

**Branding** (`008_branding.sql`). Each school has `display_name`,
`logo_url`, `primary_color` (hex `#RRGGBB`, validated, default
`#1d6fb8`) and `tagline`. A school_admin / school_owner updates ONLY
their own school (`GET|PUT /api/school/settings/branding` — the school
comes from the token, never from the request). The login page wears
the school's branding via the unauthenticated
`GET /api/public/schools/:slug/branding`, which returns ONLY `name,
display_name, logo_url, primary_color, tagline`.

Tests: 26/26 pass (16 Stage 1/2 + 10 Phase 1 covering all-12-role
creation/login, the role gates, super-admin-only plan CRUD, trial,
payment extension, Lifetime, assignment, the student limit, expired
enforcement, branding isolation, and RLS on the new tables).

## Phase 2 — management + dashboards (done, 2026-11-07)

**Students completed** (`009_students_academic.sql`). Every student
now has an auto-generated, per-school-unique **admission number**
(`ADM-<year>-<seq>`, assigned under a school-row lock so concurrent
admissions cannot collide), `photo_url`, emergency contact name +
phone, `previous_school`, `medical_notes`, and a lifecycle `status`
(`active` / `left` / `graduated` / `transferred`; father name/phone
were already there). A **`student_history`** table records admission,
promotion, transfer in/out, withdrawal, graduation, class change and
status change events — written by create, PATCH (class change),
`POST /api/school/students/:id/status` and bulk promotion.
**`student_documents`** stores document METADATA only (name, type,
URL/path string) with add/list/delete — no binary file upload is
implemented (decision: metadata + URL strings; schools link files
hosted elsewhere). Endpoints: full CRUD plus search + filters
(`q`, `class_id`, `section`, `status`), **CSV export**
(`GET /api/school/students/export.csv`), **CSV import**
(`POST /api/school/students/import` — CSV text in the JSON body, one
transaction with a per-row savepoint: valid rows import, bad rows are
reported with row numbers and messages; the subscription
student-limit gate applies row by row), and **bulk promotion**
(`POST /api/school/students/promote` — moves a class's active
students to a target class, optionally with new rolls/sections; a
roll clash in the target class blocks the move with 409 and changes
nothing).

**Staff & subjects.** `staff_profiles` (optional link to a login
user, contact, CNIC, qualifications, experience, joining date,
department, designation, `salary_basic` + `salary_allowances` JSONB,
status) with CRUD at `/api/school/staff`, gated by `users:manage`
(admin / owner / HR). `subjects`, `class_subjects` (subjects a class
studies) and `teacher_subjects` (teacher → subject + class
assignments) with CRUD at `/api/school/subjects`. A teacher's class
scope is now **class-teacher classes UNION subject-assigned
classes**, so subject teachers see and mark their classes. The
existing class-teacher assignment on `classes` is unchanged.

**Academic sessions** (`sessions` table): name (`2026-27`), dates,
exactly one `is_current` per school. Migration 009 backfills each
pre-existing school's `schools.session` value; schools registered
afterwards are seeded at registration. `POST /api/school/sessions/:id/set-current`
also updates `schools.session`. Classes gained a nullable
`session_id`.

**Dashboard** (`GET /api/school/dashboard`) — real database numbers
only, role-aware: admin/owner/principal get totals (students,
teachers, staff, classes), today's attendance (present/absent/late +
attendance %), today's and this month's fee collection, **total
outstanding fees** (discount-adjusted charges minus payments across
all students — computed from the fee model, not from voucher rows),
this month's expenses, the 5 most recent admissions, and
`upcoming_exams: []` (placeholder key until the Phase 4 exams
module). Teachers get their assigned classes with student counts and
today's marking state; parents/students get their linked child's
summary. The frontend renders these cards from the API (no
placeholder numbers) and gained students filters + CSV import/export,
staff, subjects/assignments, and sessions UI.

## Phase 3 — attendance, fees, accounts (done, 2026-11-07)

**Attendance completed** (`010_attendance_notifications.sql`).
Statuses are now words: `present` / `absent` / `late` / `half_day` /
`leave` (old `P`/`A`/`L` rows migrated; the API still accepts
`P`/`A`/`L`/`T`/`H` as input aliases). **One bulk endpoint**
(`POST /api/school/attendance/bulk`) upserts a whole class sheet in a
single transaction; the single-mark endpoint remains for corrections.
Teachers mark only their assigned classes (403 otherwise);
admin/owner correct anything; the principal is read-only. Reports:
per-student summary over a date range, class daily sheet, **monthly
class summary** (per-student counts + %), and a **monthly CSV
export**. Percentage = `(present + 0.5 × half_day) / (present +
absent + late + half_day)` — leave is excluded. **Staff attendance**
(`staff_attendance` with check-in/check-out times) + bulk endpoint at
`/api/school/staff-attendance`.

**Notifications foundation.** `notifications` table (recipient user,
type, title, body, related entity, read flag) with list / mark-one /
mark-all endpoints at `/api/school/notifications` (a user only ever
sees their own). Marking attendance auto-creates in-app
notifications for linked parent accounts: **absent → absence alert**,
**present → arrival notification** — only when a mark is new or the
status changed, so re-marking never spams.
**Architecture note — external sending is NOT implemented:**
SMS, WhatsApp and email delivery, JazzCash/Easypaisa payment
gateways, GPS tracking and biometric devices are external
dependencies. They plug into `server/lib/notify.js` later; Phase 3
ships the in-app channel only. Nothing in this codebase calls an
external service.

**Fees completed** (`011_fees_accounts.sql`). Student-level
**discounts** (`student_fee_discounts`: percent or fixed amount,
reason — scholarship / sibling / concession / other, optionally tied
to one fee head) reduce a student's charge everywhere: summary,
payment cap, vouchers, defaulters, dashboard outstanding.
**Late fines**: per-school config (`school_fee_settings`: none /
flat / per-day, amount, grace days) applied to overdue plan balances
— fines are reported separately (summary `fine`, defaulters
`overdue_amount = pending + fine`) and are never part of the payment
cap, so a fine can never block paying the principal.
**Bulk voucher generation** (`POST /api/school/fees/vouchers/generate`)
creates one `fee_vouchers` row per student for a class + period in a
single call (idempotent per student+plan+period). **Partial
payments** were verified (a payment below the charge leaves the
balance pending); **defaulters** list (`GET /api/school/fees/defaulters`
+ CSV) shows every student with an overdue balance, amounts and days
overdue. Payments carry a **method enum** (`cash`, `bank_transfer`,
`jazzcash`, `easypaisa`, `other` — recorded as metadata only, no
gateway integration) and a free-text `reference`. **Receipts**:
`GET /api/school/fees/payments/:id/receipt` returns a printable HTML
receipt. **Collection reports**: day/month/year sums at
`/api/school/fees/reports/collections` (+ CSV).

**Accounts.** `expense_categories` (seeded per school on first use:
Salaries, Utilities, Rent, Maintenance, Stationery, Transport,
Other; CRUD), `expense_records`, `income_records` (non-fee income),
**cashbook** (`GET /api/school/accounts/cashbook?date=` — the day's
fee payments + other income + expenses with totals) and
**profit & loss** (`GET /api/school/accounts/profit-loss?from&to` —
totals + expenses by category). Writes need `fees:write` (accountant,
admin, owner); the principal reads; teachers have no access.

**Exports are CSV only** (decision: CSV opens directly in Excel; no
XLSX writer is bundled and no new npm dependency was added): students,
attendance monthly, fee collections, defaulters.

Tests: **43/43 pass, twice from a fresh schema** (26 previous + 17
new covering admission numbers/history, status lifecycle, documents,
CSV import row errors + limit gate, promotion + roll clash, staff
role gates, subject assignment widening teacher scope, sessions,
exact dashboard numbers, bulk attendance + parent notifications,
teacher cross-class 403, staff attendance, discounts, bulk vouchers,
late fines + defaulters, payment methods/receipts/reports, cashbook +
P&L math, and RLS + API isolation on every new table).

## Phase 4 — exams & results (done, 2026-11-07)

**Exam terms, exams, marks** (`012_exams.sql`, `/api/school/exams`).
Terms group exams and carry the **publication gate**
(`results_published`): parents/students see a term's results and
report card only after the office publishes them. Exams belong to a
term + class + subject with a total; **marks are entered in bulk**
per exam in one transaction (any invalid row — wrong class, marks
above the total — rejects the whole sheet). Teachers create exams
and enter marks only for their assigned classes and the subjects
they teach there (or classes they are class teacher of); terms,
grading and publication are office-only (admin/owner). **Grades are
computed at read time** (`server/lib/grades.js`) from a configurable
per-school grading scale (`grade_bands`, replace-all PUT; a sensible
default A+ 90 / A 80 / B 70 / C 60 / D 50 / E 40 / F scale applies
until the school sets its own) — editing the scale re-grades all
history consistently. Results include per-subject rows, totals,
overall %, grade, **GPA** (mean of subject grade points) and **class
position** (ties share a position), plus a **merit list**, a class
results **CSV export**, and a printable HTML **report card** (same
pattern as the fee receipt; browser print → PDF). The dashboard's
`upcoming_exams` now returns the real next 5 scheduled exams for
admin, teacher (own classes) and parent/student (own class) views.

## Phase 5 — homework, timetable, portals (done, 2026-11-07)

**Homework** (`013_learning.sql`, `/api/school/homework`). Assigning
homework to a class creates one submission row per active student
(pending) in the same transaction; the lifecycle is pending →
submitted (or **late** when past the due date) → **checked** (with
teacher feedback). Parents/students submit only for their linked
child; rosters are staff-only. **Timetable** (`timetable_slots`):
weekly slots per class (weekday 1–7, period, optional times + room)
with server-side **conflict detection** — same class/weekday/period
is a UNIQUE constraint (409), and teacher or room double-booking
across classes is rejected with a clear 409. **Portals**
(`/api/school/portal/me`, `/api/school/portal/teacher`) aggregate the
real tables in one call: the parent/student portal shows the linked
child's profile, attendance (month + overall), fee position,
homework still pending, **published** results, class timetable,
transport assignment, active library loans and notifications; the
teacher portal shows my classes/subjects, today's slots, homework
waiting to be checked, and upcoming exams.

## Phase 6 — transport, library, inventory (done, 2026-11-07)

**Transport** (`014_transport.sql`, `/api/school/transport`):
vehicles (registration, type, capacity, driver), routes with ordered
stops (pickup times), **one assignment per student** (route + stop +
transport fee amount — recorded only; fee *collection* stays in the
Phase 3 fees module), and a per-day **route manifest** grouped by
stop with manually marked pickup attendance.
**GPS live tracking is NOT implemented** — it is an external
dependency (driver app / GPS hardware + streaming service); the
manifest is the manual substitute and nothing pretends otherwise.
Roles follow the master prompt: `transport_manager` gets full
transport read+write.
**Library** (`015_library_inventory.sql`, `/api/school/library`):
books (ISBN unique per school) with `copies_total` /
`copies_available` maintained transactionally by issue/return;
loans to students or staff with due dates; overdue is computed at
read time and a late return **reports** a fine of Rs 10/day — it is
not auto-charged (collecting it is a fees-module decision).
`librarian` gets full library read+write; parents see only their
child's loans.
**Inventory** (same migration, `/api/school/inventory`): categories
and items (SKU, unit, min stock, unit cost, location, **condition**:
good / needs_repair / damaged / retired). Every quantity change goes
through a **movement** (`in`, `out`, `adjust`, `damage`, `repair`)
written in the same transaction as the quantity update — quantity
can never be PATCHed directly, and insufficient stock is rejected.
`low_stock` (quantity ≤ min stock) is computed at read time.

## Phase 7 — HR: leaves & payroll (done, 2026-11-07)

**Leave requests** (`016_hr_audit.sql`, `/api/school/hr`): any
staff-linked user requests leave for themself (their linked staff
profile is resolved automatically; a body naming someone else is
ignored for non-HR callers); `hr:write` roles (admin, owner,
hr_manager) create for anyone and **decide** (approve / reject);
decided requests are locked, and a pending request can be cancelled
by its owner. **Payroll**: one run per month (draft → finalized).
Generating fills items from **active staff profiles' salary
structures** (Phase 2: basic + allowances JSON), snapshotting the
amounts so later salary edits never rewrite an issued payslip;
deductions are editable while the run is a draft (net recomputed
server-side); **finalizing locks the run permanently** and writes an
audit row. Payslips are printable HTML (receipt pattern).

## Phase 8 — analytics, reports, audit log (done, 2026-11-07)

**Analytics** (`/api/school/analytics`, `analytics:read` = admin /
owner / principal): enrollment totals, per-class strength,
teacher–student ratio, a 6-month admissions trend, a 14-day
attendance trend, fee totals with **collection rate**
(collected ÷ (collected + outstanding)), defaulter count, a 6-month
collection trend, and per-class analytics (strength, 30-day
attendance, fee position, average result % of the latest term that
has marks, homework counts). **Every figure is an aggregate over the
real tables — there is no ML model and no prediction anywhere; the
"AI analytics" of the master prompt is, honestly, descriptive
analytics on real records.**
**Report centre** (`/api/school/reports`, `reports:read` = admin /
owner / principal / accountant): CSV exports for students,
attendance (monthly), per-student fee summaries, exam results,
payroll runs and transport assignments. As everywhere else, **CSV
only** (opens in Excel; no XLSX library is bundled).
**Audit log** (`audit_log`, same migration): key writes are recorded
**inside the same transaction** as the change — student
create/delete/status change, fee payments, user create/deactivate,
subscription payments (super-admin), exam result publication and
payroll finalization — with actor, action, entity and a small JSON
snapshot. Read via `GET /api/school/reports/audit` (+ CSV), gated by
`audit:read` (admin / owner / principal; the accountant gets the
exports but not the audit log).

Tests: **57/57 pass — verified twice from a fresh schema under
TZ=Asia/Karachi and once under TZ=UTC** (43 previous + 14 new in a
dedicated "Phase School" fixture school covering exact
grade/GPA/position math with a custom grading scale, teacher
marks-entry scope, the publication gate, homework lifecycle,
timetable conflicts, portal aggregates, transport manifest, library
copy accounting + overdue fines, inventory movement math, leave
decisions, exact payroll nets + finalize locks, exact analytics
numbers, every report CSV, audit rows for the key writes, and RLS +
API isolation on all 21 new tables). Honest note (2026-11-07): an
independent run of this suite in the Asia/Karachi timezone failed 2
of these 57 tests — a per-day late fine came out Rs 60 instead of
Rs 50 and today's attendance % in analytics was null instead of 50.
Both were ONE code bug, not test bugs: pg returned DATE columns as
JS Dates at local midnight and `dateStr()` converted them back via
UTC, shifting every stored calendar date one day earlier in UTC+
timezones. Fixed by returning DATE columns as raw 'YYYY-MM-DD'
text (OID-1082 type parser in `server/lib/db.js`); the suite now
passes in both timezones.

## Honest limits

- Books & Stationery Shop, Uniforms and Exam Papers (offline-APK
  modules) are not in the SaaS yet; everything else from the master
  prompt's module list is built (Phases 1–8).
- External dependencies are architected but NOT connected, by
  design: SMS / WhatsApp / email sending (in-app notifications only —
  see `server/lib/notify.js`), JazzCash/Easypaisa payment gateways
  (methods are recorded as metadata), GPS live transport tracking
  (manual manifests), and biometric attendance (manual marking).
  There is no ML/AI prediction anywhere: analytics are descriptive
  aggregates over real records.
- Library late fines are reported (Rs 10/day), not auto-charged;
  transport fee amounts are recorded on assignments, not collected —
  both flow through the Phase 3 fees module when a school wants
  them billed.
- The offline APK and this SaaS do NOT share data; a school moves to
  the SaaS by re-entering (or importing) its data, not by syncing.
- Render Free is demo-only: the service sleeps when idle and the free
  database expires after 30 days (see docs/school-saas-deploy.md).
- No live deployment exists yet: GitHub + Render accounts and the
  Blueprint apply need the user's sign-ups.
