'use strict';

// School Manager SaaS — Stage 1 test suite.
//   DATABASE_URL=postgres://postgres:bf_local_test@127.0.0.1:5432/school_saas_test \
//   JWT_SECRET=test-secret node tests/run.js
// Resets the test database, runs migrations, boots the real server on
// an ephemeral port, and exercises HTTP + direct-DB tenant isolation.
// Exit code 0 only when every test passes.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:bf_local_test@127.0.0.1:5432/school_saas_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-school-saas';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const { createApp } = require('../server/index.js');
const { getPgPool } = require('../server/lib/db');

let base = '';
let server = null;
let ownerPool = null;

const RLS_USER = 'school_saas_app';
const RLS_PASS = 'saas_app_test_pw';

async function req(method, url, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function resetDb() {
  // Fresh schema + migrations + the restricted RLS test role.
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate.js')], {
    env: { ...process.env },
    encoding: 'utf8',
  });
  if (out.status !== 0) throw new Error('migrate failed: ' + out.stderr);
}

before(async () => {
  ownerPool = new Pool({ connectionString: process.env.DATABASE_URL });
  await ownerPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  resetDb();
  await ownerPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RLS_USER}') THEN
        CREATE ROLE ${RLS_USER} LOGIN PASSWORD '${RLS_PASS}';
      END IF;
    END $$;
  `);
  await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${RLS_USER}`);
  await ownerPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_USER}`);
  await ownerPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_USER}`);

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (ownerPool) await ownerPool.end();
});

// Shared fixtures.
const ctx = {};

test('health endpoint returns ok', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
});

test('school registration creates school + admin atomically', async () => {
  const r = await req('POST', '/api/auth/register-school', null, {
    school_name: 'City Model School',
    slug: 'city-model-school',
    admin_name: 'Ayesha Admin',
    admin_email: 'admin@citymodel.test',
    admin_password: 'password123',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.school.slug, 'city-model-school');
  assert.equal(r.data.school.session, '2026-27');
  assert.equal(r.data.user.role, 'school_admin');
  assert.ok(r.data.token);
  assert.equal(r.data.user.password_hash, undefined);
  ctx.schoolA = r.data.school;
  ctx.adminA = r.data.token;

  const r2 = await req('POST', '/api/auth/register-school', null, {
    school_name: 'Town High School',
    slug: 'town-high-school',
    admin_name: 'Bilal Admin',
    admin_email: 'admin@townhigh.test',
    admin_password: 'password123',
  });
  assert.equal(r2.status, 201);
  ctx.schoolB = r2.data.school;
  ctx.adminB = r2.data.token;
});

test('duplicate slug is rejected and leaves no orphan user', async () => {
  const r = await req('POST', '/api/auth/register-school', null, {
    school_name: 'Copy School',
    slug: 'city-model-school',
    admin_name: 'Orphan Admin',
    admin_email: 'orphan@copy.test',
    admin_password: 'password123',
  });
  assert.equal(r.status, 409);
  const { rows } = await ownerPool.query('SELECT id FROM users WHERE email = $1', ['orphan@copy.test']);
  assert.equal(rows.length, 0);
});

test('registration validation rejects bad input', async () => {
  const badSlug = await req('POST', '/api/auth/register-school', null, {
    school_name: 'X', slug: 'BAD SLUG!', admin_name: 'A',
    admin_email: 'a@b.co', admin_password: 'password123',
  });
  assert.equal(badSlug.status, 400);
  const shortPw = await req('POST', '/api/auth/register-school', null, {
    school_name: 'X', slug: 'ok-slug', admin_name: 'A',
    admin_email: 'a@b.co', admin_password: 'short',
  });
  assert.equal(shortPw.status, 400);
  const badEmail = await req('POST', '/api/auth/register-school', null, {
    school_name: 'X', slug: 'ok-slug-2', admin_name: 'A',
    admin_email: 'not-an-email', admin_password: 'password123',
  });
  assert.equal(badEmail.status, 400);
});

test('login: wrong password, unknown email, and no-slug school user all rejected', async () => {
  const wrong = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'admin@citymodel.test', password: 'wrongpass',
  });
  assert.equal(wrong.status, 401);
  const unknown = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'nobody@citymodel.test', password: 'password123',
  });
  assert.equal(unknown.status, 401);
  const noSlug = await req('POST', '/api/auth/login', null, {
    email: 'admin@citymodel.test', password: 'password123',
  });
  assert.equal(noSlug.status, 401);
  const good = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'admin@citymodel.test', password: 'password123',
  });
  assert.equal(good.status, 200);
  assert.ok(good.data.token);
});

test('invalid and expired JWTs are rejected', async () => {
  const bad = await req('GET', '/api/auth/me', 'this.is.not.a.token');
  assert.equal(bad.status, 401);
  const expired = jwt.sign(
    { sub: 'x', school_id: ctx.schoolA.id, role: 'school_admin', email: 'admin@citymodel.test' },
    process.env.JWT_SECRET,
    { expiresIn: '-1s' }
  );
  const r = await req('GET', '/api/auth/me', expired);
  assert.equal(r.status, 401);
  const none = await req('GET', '/api/auth/me', null);
  assert.equal(none.status, 401);
});

test('school A admin creates classes and students; school B cannot touch them', async () => {
  const cls = await req('POST', '/api/school/classes', ctx.adminA, { name: 'Class 5' });
  assert.equal(cls.status, 201);
  ctx.classA = cls.data.class.id;

  const st = await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA, section: 'A', roll_no: '1', name: 'Ali Khan',
    guardian_name: 'Ahmed Khan', guardian_phone: '03001234567',
  });
  assert.equal(st.status, 201);
  ctx.studentA = st.data.student.id;

  // B lists students: A's student must not appear.
  const listB = await req('GET', '/api/school/students', ctx.adminB);
  assert.equal(listB.status, 200);
  assert.ok(!listB.data.students.some((s) => s.id === ctx.studentA));

  // B reads / patches / deletes A's student: all 404 (no leak).
  assert.equal((await req('GET', `/api/school/students/${ctx.studentA}`, ctx.adminB)).status, 404);
  assert.equal((await req('PATCH', `/api/school/students/${ctx.studentA}`, ctx.adminB, { name: 'Hacked' })).status, 404);
  assert.equal((await req('DELETE', `/api/school/students/${ctx.studentA}`, ctx.adminB)).status, 404);

  // B cannot enrol a student into A's class.
  const cross = await req('POST', '/api/school/students', ctx.adminB, {
    class_id: ctx.classA, section: 'A', roll_no: '9', name: 'Cross Kid',
  });
  assert.equal(cross.status, 400);

  // A can still read its own student.
  const own = await req('GET', `/api/school/students/${ctx.studentA}`, ctx.adminA);
  assert.equal(own.status, 200);
  assert.equal(own.data.student.name, 'Ali Khan');
});

test('roll numbers are unique per class section, not across sections', async () => {
  const dup = await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA, section: 'A', roll_no: '1', name: 'Duplicate Roll',
  });
  assert.equal(dup.status, 409);
  const otherSection = await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA, section: 'B', roll_no: '1', name: 'Same Roll Other Section',
  });
  assert.equal(otherSection.status, 201);
  ctx.studentA2 = otherSection.data.student.id;
});

test('class cannot be deleted while it has students', async () => {
  const r = await req('DELETE', `/api/school/classes/${ctx.classA}`, ctx.adminA);
  assert.equal(r.status, 409);
  const empty = await req('POST', '/api/school/classes', ctx.adminA, { name: 'Class 9 Empty' });
  assert.equal(empty.status, 201);
  const del = await req('DELETE', `/api/school/classes/${empty.data.class.id}`, ctx.adminA);
  assert.equal(del.status, 200);
});

test('teacher and parent role gates + scoping', async () => {
  // Teacher user in A + a second class assigned to them.
  const t = await req('POST', '/api/school/users', ctx.adminA, {
    name: 'Fatima Teacher', email: 'teacher@citymodel.test',
    password: 'password123', role: 'teacher',
  });
  assert.equal(t.status, 201);
  const teacherId = t.data.user.id;
  const login = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'teacher@citymodel.test', password: 'password123',
  });
  assert.equal(login.status, 200);
  ctx.teacherToken = login.data.token;

  const cls6 = await req('POST', '/api/school/classes', ctx.adminA, { name: 'Class 6' });
  assert.equal(cls6.status, 201);
  ctx.classA6 = cls6.data.class.id;
  const assign = await req('PATCH', `/api/school/classes/${ctx.classA6}`, ctx.adminA, { teacher_id: teacherId });
  assert.equal(assign.status, 200);

  const st6 = await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA6, section: 'A', roll_no: '1', name: 'Sara Six',
  });
  assert.equal(st6.status, 201);

  // Teacher sees only their assigned class's students.
  const tList = await req('GET', '/api/school/students', ctx.teacherToken);
  assert.equal(tList.status, 200);
  assert.deepEqual(tList.data.students.map((s) => s.name), ['Sara Six']);
  const tClasses = await req('GET', '/api/school/classes', ctx.teacherToken);
  assert.deepEqual(tClasses.data.classes.map((c) => c.name), ['Class 6']);

  // Teacher cannot create users or classes.
  assert.equal((await req('POST', '/api/school/users', ctx.teacherToken, {
    name: 'X', email: 'x@citymodel.test', password: 'password123', role: 'parent',
  })).status, 403);
  assert.equal((await req('POST', '/api/school/classes', ctx.teacherToken, { name: 'Nope' })).status, 403);

  // Parent linked to Ali Khan sees only Ali Khan.
  const p = await req('POST', '/api/school/users', ctx.adminA, {
    name: 'Ahmed Khan', email: 'parent@citymodel.test',
    password: 'password123', role: 'parent', linked_student_id: ctx.studentA,
  });
  assert.equal(p.status, 201);
  const plogin = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'parent@citymodel.test', password: 'password123',
  });
  ctx.parentToken = plogin.data.token;
  const pList = await req('GET', '/api/school/students', ctx.parentToken);
  assert.deepEqual(pList.data.students.map((s) => s.name), ['Ali Khan']);
  assert.equal((await req('GET', `/api/school/students/${ctx.studentA2}`, ctx.parentToken)).status, 404);
  assert.equal((await req('GET', '/api/school/users', ctx.parentToken)).status, 403);
  assert.equal((await req('GET', '/api/school/classes', ctx.parentToken)).status, 403);

  // Parent linked to a student of ANOTHER school is rejected at creation.
  const clsB = await req('POST', '/api/school/classes', ctx.adminB, { name: 'Class 1' });
  const stB = await req('POST', '/api/school/students', ctx.adminB, {
    class_id: clsB.data.class.id, section: 'A', roll_no: '1', name: 'Bilal B',
  });
  const crossParent = await req('POST', '/api/school/users', ctx.adminA, {
    name: 'Cross Parent', email: 'cross@citymodel.test',
    password: 'password123', role: 'parent', linked_student_id: stB.data.student.id,
  });
  assert.equal(crossParent.status, 400);
});

test('same email can exist in different schools and login is unambiguous', async () => {
  const inB = await req('POST', '/api/school/users', ctx.adminB, {
    name: 'Shared Teacher', email: 'shared@school.test',
    password: 'password123', role: 'teacher',
  });
  assert.equal(inB.status, 201);
  const inA = await req('POST', '/api/school/users', ctx.adminA, {
    name: 'Shared Teacher', email: 'shared@school.test',
    password: 'password123', role: 'teacher',
  });
  assert.equal(inA.status, 201);
  const dupInA = await req('POST', '/api/school/users', ctx.adminA, {
    name: 'Dup', email: 'shared@school.test',
    password: 'password123', role: 'teacher',
  });
  assert.equal(dupInA.status, 409);

  const loginA = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'shared@school.test', password: 'password123',
  });
  assert.equal(loginA.status, 200);
  const meA = await req('GET', '/api/auth/me', loginA.data.token);
  assert.equal(meA.data.school.slug, 'city-model-school');
  const loginB = await req('POST', '/api/auth/login', null, {
    slug: 'town-high-school', email: 'shared@school.test', password: 'password123',
  });
  const meB = await req('GET', '/api/auth/me', loginB.data.token);
  assert.equal(meB.data.school.slug, 'town-high-school');
});

test('attendance: mark, re-mark, class sheet, summary, role gates', async () => {
  // Admin marks Ali Khan present, then re-marks the same day absent:
  // the day updates, it does not duplicate.
  const m1 = await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '2026-10-29', status: 'P',
  });
  assert.equal(m1.status, 201);
  const m2 = await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '2026-10-29', status: 'A',
  });
  assert.equal(m2.status, 201);
  const sheet = await req('GET', `/api/school/attendance?class_id=${ctx.classA}&date=2026-10-29`, ctx.adminA);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.data.attendance.length, 1);
  // Phase 3 renamed the stored statuses from codes (P/A/L) to words.
  assert.equal(sheet.data.attendance[0].status, 'absent');

  // Validation: bad status and bad date rejected.
  assert.equal((await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '2026-10-30', status: 'X',
  })).status, 400);
  assert.equal((await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '29-10-2026', status: 'P',
  })).status, 400);

  // Cross-school: B marking A's student, and B reading A's class sheet.
  assert.equal((await req('POST', '/api/school/attendance', ctx.adminB, {
    student_id: ctx.studentA, date: '2026-10-29', status: 'P',
  })).status, 404);
  assert.equal((await req('GET', `/api/school/attendance?class_id=${ctx.classA}&date=2026-10-29`, ctx.adminB)).status, 404);

  // Teacher: can mark their assigned Class 6, not unassigned Class 5.
  const st6 = await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA6, section: 'A', roll_no: '2', name: 'Bilal Six',
  });
  assert.equal(st6.status, 201);
  assert.equal((await req('POST', '/api/school/attendance', ctx.teacherToken, {
    student_id: st6.data.student.id, date: '2026-10-29', status: 'P',
  })).status, 201);
  assert.equal((await req('POST', '/api/school/attendance', ctx.teacherToken, {
    student_id: ctx.studentA, date: '2026-10-29', status: 'P',
  })).status, 403);
  assert.equal((await req('GET', `/api/school/attendance?class_id=${ctx.classA}&date=2026-10-29`, ctx.teacherToken)).status, 403);

  // Parent: class sheet forbidden, but own child's summary works.
  assert.equal((await req('GET', `/api/school/attendance?class_id=${ctx.classA}&date=2026-10-29`, ctx.parentToken)).status, 403);
  assert.equal((await req('GET', `/api/school/attendance/summary?student_id=${ctx.studentA2}&month=2026-10`, ctx.parentToken)).status, 404);

  // Summary: leave excluded from the %. Ali: 29 Oct A, 30 Oct L, 31 Oct P
  // -> present 1, absent 1, leave 1, pct 50.
  await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '2026-10-30', status: 'L',
  });
  await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '2026-10-31', status: 'P',
  });
  const sum = await req('GET', `/api/school/attendance/summary?student_id=${ctx.studentA}&month=2026-10`, ctx.parentToken);
  assert.equal(sum.status, 200);
  assert.deepEqual(
    [sum.data.summary.present, sum.data.summary.absent, sum.data.summary.leave, sum.data.summary.pct],
    [1, 1, 1, 50]
  );
});

test('fees: heads, plans, partial payments, overpayment rejected, summary, role gates', async () => {
  // Fee head + plan for Class 5 (Ali Khan's class). Tuition 10000, due
  // in the past so any unpaid part counts as overdue.
  const head = await req('POST', '/api/school/fees/heads', ctx.adminA, { name: 'Tuition' });
  assert.equal(head.status, 201);
  assert.equal((await req('POST', '/api/school/fees/heads', ctx.adminA, { name: 'Tuition' })).status, 409);
  const plan = await req('POST', '/api/school/fees/plans', ctx.adminA, {
    class_id: ctx.classA, fee_head_id: head.data.fee_head.id, amount: 10000, due_date: '2026-01-01',
  });
  assert.equal(plan.status, 201);
  const planId = plan.data.fee_plan.id;
  assert.equal((await req('POST', '/api/school/fees/plans', ctx.adminA, {
    class_id: ctx.classA, fee_head_id: head.data.fee_head.id, amount: 10000,
  })).status, 409);

  // A second plan with a future due date is pending but not overdue.
  const head2 = await req('POST', '/api/school/fees/heads', ctx.adminA, { name: 'Exam' });
  const plan2 = await req('POST', '/api/school/fees/plans', ctx.adminA, {
    class_id: ctx.classA, fee_head_id: head2.data.fee_head.id, amount: 2000, due_date: '2099-01-01',
  });
  assert.equal(plan2.status, 201);

  // Partial payment 4000 against Tuition: receipt issued, summary matches.
  const pay = await req('POST', '/api/school/fees/payments', ctx.adminA, {
    student_id: ctx.studentA, plan_id: planId, amount: 4000, method: 'Cash',
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.data.fee_payment.receipt_no, 'RCPT-000001');
  const sum = await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.adminA);
  assert.equal(sum.status, 200);
  assert.deepEqual(
    [sum.data.summary.total, sum.data.summary.paid, sum.data.summary.pending, sum.data.summary.overdue],
    [12000, 4000, 8000, 6000]
  );
  assert.equal(sum.data.summary.overdue_plan_count, 1);

  // Overpayment rejected (pending on Tuition is 6000), zero rejected,
  // and a plan from another class is rejected for this student.
  assert.equal((await req('POST', '/api/school/fees/payments', ctx.adminA, {
    student_id: ctx.studentA, plan_id: planId, amount: 6001,
  })).status, 400);
  assert.equal((await req('POST', '/api/school/fees/payments', ctx.adminA, {
    student_id: ctx.studentA, plan_id: planId, amount: 0,
  })).status, 400);
  const otherClassPlan = await req('POST', '/api/school/fees/plans', ctx.adminA, {
    class_id: ctx.classA6, fee_head_id: head.data.fee_head.id, amount: 5000,
  });
  assert.equal((await req('POST', '/api/school/fees/payments', ctx.adminA, {
    student_id: ctx.studentA, plan_id: otherClassPlan.data.fee_plan.id, amount: 100,
  })).status, 400);

  // Paying the rest clears Tuition; overdue drops to 0.
  const payRest = await req('POST', '/api/school/fees/payments', ctx.adminA, {
    student_id: ctx.studentA, plan_id: planId, amount: 6000,
  });
  assert.equal(payRest.status, 201);
  assert.equal(payRest.data.fee_payment.receipt_no, 'RCPT-000002');
  const sum2 = await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.adminA);
  assert.deepEqual(
    [sum2.data.summary.paid, sum2.data.summary.pending, sum2.data.summary.overdue],
    [10000, 2000, 0]
  );

  // Cross-school: B cannot use A's head/plan/student.
  assert.equal((await req('POST', '/api/school/fees/plans', ctx.adminB, {
    class_id: ctx.classA, fee_head_id: head.data.fee_head.id, amount: 100,
  })).status, 404);
  assert.equal((await req('POST', '/api/school/fees/payments', ctx.adminB, {
    student_id: ctx.studentA, plan_id: planId, amount: 100,
  })).status, 404);
  assert.equal((await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.adminB)).status, 404);

  // Role gates: teacher cannot touch fees at all; parent sees only
  // their own child's summary, not another student's.
  assert.equal((await req('POST', '/api/school/fees/heads', ctx.teacherToken, { name: 'X' })).status, 403);
  assert.equal((await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.teacherToken)).status, 403);
  const parentSum = await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.parentToken);
  assert.equal(parentSum.status, 200);
  assert.equal(parentSum.data.summary.pending, 2000);
  assert.equal((await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA2}`, ctx.parentToken)).status, 404);
  const parentPays = await req('GET', `/api/school/fees/payments?student_id=${ctx.studentA}`, ctx.parentToken);
  assert.equal(parentPays.status, 200);
  assert.equal(parentPays.data.fee_payments.length, 2);
});

test('school_admin cannot touch super-admin routes', async () => {
  assert.equal((await req('GET', '/api/admin/schools', ctx.adminA)).status, 403);
  assert.equal((await req('POST', `/api/admin/schools/${ctx.schoolA.id}/suspend`, ctx.adminA, {})).status, 403);
});

test('DB-level RLS: restricted role sees only its tenant', async () => {
  const rlsPool = new Pool({
    connectionString: `postgres://${RLS_USER}:${RLS_PASS}@127.0.0.1:5432/school_saas_test`,
  });
  try {
    // Tenant A sees only A's students.
    const cA = await rlsPool.connect();
    try {
      await cA.query('BEGIN');
      await cA.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ctx.schoolA.id]);
      const r = await cA.query('SELECT id, school_id FROM students ORDER BY name');
      assert.ok(r.rows.length > 0);
      assert.ok(r.rows.every((row) => row.school_id === ctx.schoolA.id));
      // Direct filter for B's school returns nothing under A's tenant.
      const rb = await cA.query('SELECT id FROM students WHERE school_id = $1', [ctx.schoolB.id]);
      assert.equal(rb.rows.length, 0);
      // Cross-tenant INSERT is blocked by the WITH CHECK policy.
      // (SAVEPOINT keeps the transaction usable after the rejection.)
      await cA.query('SAVEPOINT rls_sp');
      await assert.rejects(
        cA.query('INSERT INTO students (school_id, class_id, section, roll_no, name) VALUES ($1, $2, $3, $4, $5)',
          [ctx.schoolB.id, ctx.classA, 'A', '999', 'RLS Breaker']),
        (err) => err.code === '42501'
      );
      await cA.query('ROLLBACK TO SAVEPOINT rls_sp');
      // Tenant's users view excludes the other school (and super_admins).
      const u = await cA.query('SELECT DISTINCT school_id FROM users');
      assert.deepEqual(u.rows.map((row) => row.school_id), [ctx.schoolA.id]);
      await cA.query('ROLLBACK');
    } finally {
      cA.release();
    }
    // No tenant set: default-deny, zero rows everywhere.
    const c0 = await rlsPool.connect();
    try {
      const r = await c0.query('SELECT id FROM students');
      assert.equal(r.rows.length, 0);
      const r2 = await c0.query('SELECT id FROM schools');
      assert.equal(r2.rows.length, 0);
    } finally {
      c0.release();
    }
  } finally {
    await rlsPool.end();
  }
});

test('super-admin: list schools, suspend blocks logins, activate restores', async () => {
  const hash = await bcrypt.hash('superpass123', 10);
  await ownerPool.query(
    "INSERT INTO users (school_id, name, email, password_hash, role) VALUES (NULL, 'Super', 'super@saas.test', $1, 'super_admin')",
    [hash]
  );
  const login = await req('POST', '/api/auth/login', null, {
    email: 'super@saas.test', password: 'superpass123',
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'super_admin');
  const superToken = login.data.token;

  const list = await req('GET', '/api/admin/schools', superToken);
  assert.equal(list.status, 200);
  const slugs = list.data.schools.map((s) => s.slug);
  assert.ok(slugs.includes('city-model-school'));
  assert.ok(slugs.includes('town-high-school'));
  const schoolA = list.data.schools.find((s) => s.slug === 'city-model-school');
  assert.ok(schoolA.user_count >= 3);

  const susp = await req('POST', `/api/admin/schools/${ctx.schoolA.id}/suspend`, superToken, {});
  assert.equal(susp.status, 200);
  assert.equal(susp.data.school.status, 'suspended');

  // Suspended school: login rejected AND existing tokens rejected on school routes.
  const blockedLogin = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'admin@citymodel.test', password: 'password123',
  });
  assert.equal(blockedLogin.status, 403);
  const blockedRoute = await req('GET', '/api/school/students', ctx.adminA);
  assert.equal(blockedRoute.status, 403);

  // Other school unaffected.
  const okB = await req('GET', '/api/school/students', ctx.adminB);
  assert.equal(okB.status, 200);

  const act = await req('POST', `/api/admin/schools/${ctx.schoolA.id}/activate`, superToken, {});
  assert.equal(act.status, 200);
  const restored = await req('POST', '/api/auth/login', null, {
    slug: 'city-model-school', email: 'admin@citymodel.test', password: 'password123',
  });
  assert.equal(restored.status, 200);
});

// ---------------------------------------------------------------------
// Phase 1 — roles (12), subscriptions (duration packages), branding.
// ---------------------------------------------------------------------

async function loginAs(slug, email, password) {
  const body = { email, password: password || 'password123' };
  if (slug) body.slug = slug;
  const r = await req('POST', '/api/auth/login', null, body);
  assert.equal(r.status, 200, `login failed for ${email}`);
  return r.data.token;
}

test('phase1: all 12 roles exist; the 7 new school roles can be created and log in', async () => {
  ctx.superToken = await loginAs(null, 'super@saas.test', 'superpass123');

  const newRoles = [
    ['school_owner', 'owner@citymodel.test', 'ownerToken'],
    ['school_admin', 'admin2@citymodel.test', 'admin2Token'],
    ['principal', 'principal@citymodel.test', 'principalToken'],
    ['accountant', 'accountant@citymodel.test', 'accountantToken'],
    ['hr_manager', 'hr@citymodel.test', 'hrToken'],
    ['transport_manager', 'transport@citymodel.test', 'transportToken'],
    ['librarian', 'librarian@citymodel.test', 'librarianToken'],
    ['receptionist', 'receptionist@citymodel.test', 'receptionistToken'],
  ];
  for (const [role, email, key] of newRoles) {
    const created = await req('POST', '/api/school/users', ctx.adminA, {
      name: 'Phase1 ' + role, email, password: 'password123', role,
    });
    assert.equal(created.status, 201, `create ${role}`);
    assert.equal(created.data.user.role, role);
    ctx[key] = await loginAs('city-model-school', email);
    const me = await req('GET', '/api/auth/me', ctx[key]);
    assert.equal(me.data.user.role, role);
    assert.equal(me.data.school.slug, 'city-model-school');
  }

  // super_admin can never be created through the school users API.
  const bad = await req('POST', '/api/school/users', ctx.adminA, {
    name: 'Fake Super', email: 'fake@citymodel.test', password: 'password123', role: 'super_admin',
  });
  assert.equal(bad.status, 400);
});

test('phase1: role gates — accountant, principal, librarian, transport, hr, owner', async () => {
  // Accountant: money yes, platform no, student writes no.
  assert.equal((await req('POST', `/api/admin/schools/${ctx.schoolA.id}/suspend`, ctx.accountantToken, {})).status, 403);
  assert.equal((await req('DELETE', `/api/school/students/${ctx.studentA}`, ctx.accountantToken)).status, 403);
  assert.equal((await req('POST', '/api/school/students', ctx.accountantToken, {
    class_id: ctx.classA, section: 'A', roll_no: '77', name: 'Nope',
  })).status, 403);
  const accHead = await req('POST', '/api/school/fees/heads', ctx.accountantToken, { name: 'Accountant Head' });
  assert.equal(accHead.status, 201);
  const accSum = await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.accountantToken);
  assert.equal(accSum.status, 200);

  // Principal: reads everything, writes nothing.
  const prinStudents = await req('GET', '/api/school/students', ctx.principalToken);
  assert.equal(prinStudents.status, 200);
  assert.ok(prinStudents.data.students.some((s) => s.id === ctx.studentA));
  assert.equal((await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.principalToken)).status, 200);
  assert.equal((await req('GET', `/api/school/attendance?class_id=${ctx.classA}&date=2026-10-29`, ctx.principalToken)).status, 200);
  assert.equal((await req('POST', '/api/school/fees/payments', ctx.principalToken, {
    student_id: ctx.studentA, plan_id: ctx.classA, amount: 1,
  })).status, 403);
  assert.equal((await req('POST', '/api/school/students', ctx.principalToken, {
    class_id: ctx.classA, section: 'A', roll_no: '78', name: 'Nope',
  })).status, 403);
  assert.equal((await req('POST', '/api/school/fees/heads', ctx.principalToken, { name: 'Prin Head' })).status, 403);

  // Librarian: student/class read yes, fees fully blocked.
  assert.equal((await req('GET', '/api/school/students', ctx.librarianToken)).status, 200);
  assert.equal((await req('GET', '/api/school/classes', ctx.librarianToken)).status, 200);
  assert.equal((await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.librarianToken)).status, 403);
  assert.equal((await req('GET', `/api/school/fees/payments?student_id=${ctx.studentA}`, ctx.librarianToken)).status, 403);
  assert.equal((await req('POST', '/api/school/fees/heads', ctx.librarianToken, { name: 'Lib Head' })).status, 403);

  // Transport manager: student read yes, fees and attendance writes no.
  assert.equal((await req('GET', '/api/school/students', ctx.transportToken)).status, 200);
  assert.equal((await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.transportToken)).status, 403);
  assert.equal((await req('POST', '/api/school/attendance', ctx.transportToken, {
    student_id: ctx.studentA, date: '2026-11-01', status: 'P',
  })).status, 403);

  // Receptionist: fees blocked.
  assert.equal((await req('GET', `/api/school/fees/payments?student_id=${ctx.studentA}`, ctx.receptionistToken)).status, 403);
  assert.equal((await req('GET', '/api/school/students', ctx.receptionistToken)).status, 200);

  // HR manager: manages users, no fees.
  const hrMade = await req('POST', '/api/school/users', ctx.hrToken, {
    name: 'HR Made Teacher', email: 'hrmade@citymodel.test', password: 'password123', role: 'teacher',
  });
  assert.equal(hrMade.status, 201);
  assert.equal((await req('GET', '/api/school/users', ctx.hrToken)).status, 200);
  assert.equal((await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.hrToken)).status, 403);

  // School owner: same school powers as school_admin.
  const ownerClass = await req('POST', '/api/school/classes', ctx.ownerToken, { name: 'Owner Class' });
  assert.equal(ownerClass.status, 201);
  assert.equal((await req('DELETE', `/api/school/classes/${ownerClass.data.class.id}`, ctx.ownerToken)).status, 200);
  assert.equal((await req('GET', '/api/school/users', ctx.ownerToken)).status, 200);
});

test('phase1: duration packages seeded; plan CRUD is super-admin only', async () => {
  const list = await req('GET', '/api/admin/plans', ctx.superToken);
  assert.equal(list.status, 200);
  const byName = {};
  for (const p of list.data.plans) byName[p.name] = p;
  assert.deepEqual(
    ['12 Months', '24 Months', '36 Months', 'Lifetime'].map((n) => [Number(byName[n].price_pkr), byName[n].period_months]),
    [[5000, 12], [8000, 24], [12000, 36], [20000, null]]
  );
  ctx.plans = byName;

  // A school_admin is not a platform admin.
  assert.equal((await req('GET', '/api/admin/plans', ctx.adminA)).status, 403);
  assert.equal((await req('POST', '/api/admin/plans', ctx.adminA, {
    name: 'Sneaky', price_pkr: 1, period_months: 1,
  })).status, 403);
  assert.equal((await req('GET', '/api/admin/subscriptions', ctx.adminA)).status, 403);

  // Super admin: create, edit, delete an unused package.
  const made = await req('POST', '/api/admin/plans', ctx.superToken, {
    name: '6 Months', price_pkr: 3000, period_months: 6,
  });
  assert.equal(made.status, 201);
  const edited = await req('PATCH', `/api/admin/plans/${made.data.plan.id}`, ctx.superToken, { price_pkr: 3500 });
  assert.equal(edited.status, 200);
  assert.equal(Number(edited.data.plan.price_pkr), 3500);
  const del = await req('DELETE', `/api/admin/plans/${made.data.plan.id}`, ctx.superToken);
  assert.equal(del.status, 200);

  // Super admin's /me carries no subscription.
  const me = await req('GET', '/api/auth/me', ctx.superToken);
  assert.equal(me.data.subscription, null);
});

test('phase1: registration starts a 30-day free trial, exposed on /me', async () => {
  const r = await req('POST', '/api/auth/register-school', null, {
    school_name: 'Phase1 Alpha School',
    slug: 'phase1-alpha-school',
    admin_name: 'Alpha Admin',
    admin_email: 'admin@alpha.test',
    admin_password: 'password123',
  });
  assert.equal(r.status, 201);
  ctx.schoolC = r.data.school;
  ctx.adminC = r.data.token;

  const me = await req('GET', '/api/auth/me', ctx.adminC);
  assert.equal(me.status, 200);
  assert.equal(me.data.subscription.status, 'trial');
  assert.equal(me.data.subscription.plan_name, null);
  assert.equal(me.data.subscription.student_limit, null);
  const exp = new Date(me.data.subscription.expires_at).getTime();
  const days = (exp - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, `trial expiry should be ~30 days out, got ${days}`);
});

test('phase1: recording a payment extends expiry; Lifetime never expires', async () => {
  const before = await req('GET', `/api/admin/schools/${ctx.schoolC.id}/subscription`, ctx.superToken);
  assert.equal(before.status, 200);
  assert.equal(before.data.subscription.status, 'trial');
  const trialExpiry = new Date(before.data.subscription.expires_at).getTime();

  // Pay for 12 Months: expiry extends 12 months FROM the trial expiry
  // (renewing early never loses paid time); amount defaults to price.
  const pay = await req('POST', `/api/admin/schools/${ctx.schoolC.id}/subscription/payment`, ctx.superToken, {
    plan_id: ctx.plans['12 Months'].id, method: 'JazzCash',
  });
  assert.equal(pay.status, 201);
  assert.equal(Number(pay.data.payment.amount), 5000);
  assert.equal(pay.data.payment.period_months, 12);
  assert.equal(pay.data.subscription.status, 'active');
  assert.equal(pay.data.subscription.plan_name, '12 Months');
  const newExpiry = new Date(pay.data.subscription.expires_at).getTime();
  assert.ok(newExpiry > trialExpiry + 330 * 86400000, 'expiry extended by ~12 months');
  assert.ok(newExpiry < trialExpiry + 400 * 86400000, 'expiry not extended too far');

  // Pay for Lifetime: expiry cleared, status active.
  const life = await req('POST', `/api/admin/schools/${ctx.schoolC.id}/subscription/payment`, ctx.superToken, {
    plan_id: ctx.plans['Lifetime'].id,
  });
  assert.equal(life.status, 201);
  assert.equal(life.data.subscription.plan_name, 'Lifetime');
  assert.equal(life.data.subscription.expires_at, null);
  assert.equal(life.data.subscription.status, 'active');

  // The platform-wide list shows school C on Lifetime.
  const all = await req('GET', '/api/admin/subscriptions', ctx.superToken);
  const rowC = all.data.subscriptions.find((s) => s.school_id === ctx.schoolC.id);
  assert.equal(rowC.plan_name, 'Lifetime');
  assert.equal(rowC.expires_at, null);
});

test('phase1: assigning a package restarts its period from now', async () => {
  const r = await req('POST', `/api/admin/schools/${ctx.schoolB.id}/subscription/assign`, ctx.superToken, {
    plan_id: ctx.plans['24 Months'].id,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.subscription.plan_name, '24 Months');
  assert.equal(r.data.subscription.status, 'active');
  const exp = new Date(r.data.subscription.expires_at).getTime();
  assert.ok(exp > Date.now() + 690 * 86400000 && exp < Date.now() + 800 * 86400000);

  // School B keeps working normally.
  assert.equal((await req('GET', '/api/school/students', ctx.adminB)).status, 200);
});

test('phase1: student_limit blocks creation at the limit until raised/cleared', async () => {
  const cls = await req('POST', '/api/school/classes', ctx.adminC, { name: 'Class 1' });
  assert.equal(cls.status, 201);
  ctx.classC = cls.data.class.id;

  const set = await req('PATCH', `/api/admin/schools/${ctx.schoolC.id}/subscription`, ctx.superToken, { student_limit: 1 });
  assert.equal(set.status, 200);
  assert.equal(set.data.subscription.student_limit, 1);

  const s1 = await req('POST', '/api/school/students', ctx.adminC, {
    class_id: ctx.classC, section: 'A', roll_no: '1', name: 'First Kid',
  });
  assert.equal(s1.status, 201);
  const s2 = await req('POST', '/api/school/students', ctx.adminC, {
    class_id: ctx.classC, section: 'A', roll_no: '2', name: 'Second Kid',
  });
  assert.equal(s2.status, 403);
  assert.match(s2.data.error, /limit/i);

  // Clearing the limit (null = unlimited) lets the same create through.
  const cleared = await req('PATCH', `/api/admin/schools/${ctx.schoolC.id}/subscription`, ctx.superToken, { student_limit: null });
  assert.equal(cleared.data.subscription.student_limit, null);
  const s2b = await req('POST', '/api/school/students', ctx.adminC, {
    class_id: ctx.classC, section: 'A', roll_no: '2', name: 'Second Kid',
  });
  assert.equal(s2b.status, 201);
});

test('phase1: expired subscription blocks student creation; login and reads still work', async () => {
  await ownerPool.query(
    "UPDATE school_subscriptions SET expires_at = now() - interval '1 day' WHERE school_id = $1",
    [ctx.schoolC.id]
  );
  // Login still works…
  const token = await loginAs('phase1-alpha-school', 'admin@alpha.test');
  // …/me reports the effective status as expired…
  const me = await req('GET', '/api/auth/me', token);
  assert.equal(me.data.subscription.status, 'expired');
  // …reads still work…
  assert.equal((await req('GET', '/api/school/students', token)).status, 200);
  // …but creating a student is blocked with a clear error.
  const blocked = await req('POST', '/api/school/students', token, {
    class_id: ctx.classC, section: 'A', roll_no: '3', name: 'Third Kid',
  });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /expired/i);

  // Renewing (12 Months from now, since the old expiry is past) unblocks.
  const pay = await req('POST', `/api/admin/schools/${ctx.schoolC.id}/subscription/payment`, ctx.superToken, {
    plan_id: ctx.plans['12 Months'].id,
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.data.subscription.status, 'active');
  const ok = await req('POST', '/api/school/students', token, {
    class_id: ctx.classC, section: 'A', roll_no: '3', name: 'Third Kid',
  });
  assert.equal(ok.status, 201);
});

test('phase1: branding — own admin updates, public endpoint shows only public fields', async () => {
  // Defaults before any update.
  const pub0 = await req('GET', '/api/public/schools/city-model-school/branding');
  assert.equal(pub0.status, 200);
  assert.deepEqual(
    Object.keys(pub0.data.branding).sort(),
    ['display_name', 'logo_url', 'name', 'primary_color', 'tagline']
  );
  assert.equal(pub0.data.branding.primary_color, '#1d6fb8');
  assert.equal(pub0.data.branding.display_name, null);
  assert.equal(pub0.data.branding.phone, undefined);

  // Own admin updates; the colour is normalised to lowercase.
  const upd = await req('PUT', '/api/school/settings/branding', ctx.adminA, {
    display_name: 'City Model', primary_color: '#0A7D3B',
    tagline: 'Learn and Grow', logo_url: 'https://example.com/logo.png',
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.branding.primary_color, '#0a7d3b');

  const pub1 = await req('GET', '/api/public/schools/city-model-school/branding');
  assert.equal(pub1.data.branding.display_name, 'City Model');
  assert.equal(pub1.data.branding.tagline, 'Learn and Grow');
  assert.equal(pub1.data.branding.logo_url, 'https://example.com/logo.png');

  // Validation: bad colour and bad logo URL rejected.
  assert.equal((await req('PUT', '/api/school/settings/branding', ctx.adminA, { primary_color: 'green' })).status, 400);
  assert.equal((await req('PUT', '/api/school/settings/branding', ctx.adminA, { logo_url: 'ftp://x/y.png' })).status, 400);

  // Roles without settings:write cannot change branding.
  assert.equal((await req('PUT', '/api/school/settings/branding', ctx.parentToken, { display_name: 'Hax' })).status, 403);
  assert.equal((await req('PUT', '/api/school/settings/branding', ctx.teacherToken, { display_name: 'Hax' })).status, 403);

  // School B's admin updates B only; A's public branding is untouched.
  const updB = await req('PUT', '/api/school/settings/branding', ctx.adminB, { display_name: 'Town High' });
  assert.equal(updB.status, 200);
  const pubA2 = await req('GET', '/api/public/schools/city-model-school/branding');
  assert.equal(pubA2.data.branding.display_name, 'City Model');
  const pubB = await req('GET', '/api/public/schools/town-high-school/branding');
  assert.equal(pubB.data.branding.display_name, 'Town High');
  const ownB = await req('GET', '/api/school/settings/branding', ctx.adminB);
  assert.equal(ownB.data.branding.name, 'Town High School');

  // Unknown / malformed slugs: 404, no data.
  assert.equal((await req('GET', '/api/public/schools/no-such-school/branding')).status, 404);
  assert.equal((await req('GET', '/api/public/schools/BAD SLUG!/branding')).status, 404);
});

test('phase1: tenant isolation holds on the new subscription tables', async () => {
  // API layer: B's settings read returns B's school, never A's.
  const ownB = await req('GET', '/api/school/settings/branding', ctx.adminB);
  assert.equal(ownB.data.branding.display_name, 'Town High');

  // DB layer (RLS): a restricted connection set to tenant C sees only
  // C's subscription and C's payments; A's connection sees none of C's.
  const rlsPool = new Pool({
    connectionString: `postgres://${RLS_USER}:${RLS_PASS}@127.0.0.1:5432/school_saas_test`,
  });
  try {
    const cC = await rlsPool.connect();
    try {
      await cC.query('BEGIN');
      await cC.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ctx.schoolC.id]);
      const subs = await cC.query('SELECT school_id FROM school_subscriptions');
      assert.deepEqual(subs.rows.map((r) => r.school_id), [ctx.schoolC.id]);
      const pays = await cC.query('SELECT school_id FROM subscription_payments');
      assert.ok(pays.rows.length >= 2);
      assert.ok(pays.rows.every((r) => r.school_id === ctx.schoolC.id));
      await cC.query('ROLLBACK');
    } finally {
      cC.release();
    }
    const cA = await rlsPool.connect();
    try {
      await cA.query('BEGIN');
      await cA.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ctx.schoolA.id]);
      const cross = await cA.query('SELECT id FROM subscription_payments WHERE school_id = $1', [ctx.schoolC.id]);
      assert.equal(cross.rows.length, 0);
      await cA.query('ROLLBACK');
    } finally {
      cA.release();
    }
  } finally {
    await rlsPool.end();
  }
});

// ---------------------------------------------------------------------
// Phase 2 — students (fields, history, documents, import, promote),
// staff, subjects, sessions, dashboards.
// Phase 3 — bulk attendance + notifications, staff attendance, fee
// discounts / fines / vouchers / defaulters / receipts / reports,
// accounts (expenses, income, cashbook, profit & loss), CSV exports.
// ---------------------------------------------------------------------

async function reqText(url, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + url, { headers });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get('content-type') || '' };
}

const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

test('phase2: admission numbers, new student fields, history, filters', async () => {
  const s1 = await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA, section: 'A', roll_no: '51', name: 'New Fields Kid',
    guardian_name: 'Father Kid', guardian_phone: '03009998877',
    photo_url: 'https://example.com/kid.jpg',
    emergency_contact_name: 'Uncle Kid', emergency_contact_phone: '03001112233',
    previous_school: 'Old School', medical_notes: 'Asthma inhaler in bag',
  });
  assert.equal(s1.status, 201);
  assert.match(s1.data.student.admission_number, /^ADM-\d{4}-\d{4}$/);
  assert.equal(s1.data.student.photo_url, 'https://example.com/kid.jpg');
  assert.equal(s1.data.student.emergency_contact_phone, '03001112233');
  assert.equal(s1.data.student.previous_school, 'Old School');
  assert.equal(s1.data.student.medical_notes, 'Asthma inhaler in bag');
  ctx.studentNew = s1.data.student.id;
  const seq1 = Number(s1.data.student.admission_number.split('-')[2]);

  const s2 = await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA, section: 'A', roll_no: '52', name: 'Second New Kid',
  });
  assert.equal(s2.status, 201);
  assert.equal(Number(s2.data.student.admission_number.split('-')[2]), seq1 + 1);

  // Admission history row was written.
  const hist = await req('GET', `/api/school/students/${ctx.studentNew}/history`, ctx.adminA);
  assert.equal(hist.status, 200);
  assert.ok(hist.data.history.some((h) => h.event === 'admission'));

  // Filters: name search, class, section, status.
  const byQ = await req('GET', '/api/school/students?q=New%20Fields', ctx.adminA);
  assert.deepEqual(byQ.data.students.map((s) => s.id), [ctx.studentNew]);
  const bySection = await req('GET', `/api/school/students?class_id=${ctx.classA}&section=B`, ctx.adminA);
  assert.ok(!bySection.data.students.some((s) => s.id === ctx.studentNew));
  const byStatus = await req('GET', '/api/school/students?status=graduated', ctx.adminA);
  assert.equal(byStatus.data.students.length, 0);
  assert.equal((await req('GET', '/api/school/students?status=bogus', ctx.adminA)).status, 400);

  // New statuses accepted, bogus ones rejected.
  assert.equal((await req('POST', '/api/school/students', ctx.adminA, {
    class_id: ctx.classA, section: 'A', roll_no: '53', name: 'Bad Status', status: 'bogus',
  })).status, 400);
});

test('phase2: student status lifecycle writes history events', async () => {
  const grad = await req('POST', `/api/school/students/${ctx.studentNew}/status`, ctx.adminA, { status: 'graduated' });
  assert.equal(grad.status, 200);
  assert.equal(grad.data.student.status, 'graduated');
  assert.equal((await req('POST', `/api/school/students/${ctx.studentNew}/status`, ctx.adminA, { status: 'bogus' })).status, 400);
  const left = await req('POST', `/api/school/students/${ctx.studentNew}/status`, ctx.adminA, { status: 'left', note: 'Family moved' });
  assert.equal(left.status, 200);
  const hist = await req('GET', `/api/school/students/${ctx.studentNew}/history`, ctx.adminA);
  const events = hist.data.history.map((h) => h.event);
  assert.ok(events.includes('graduation'));
  assert.ok(events.includes('withdrawal'));
  // A parent of another child cannot read this history.
  assert.equal((await req('GET', `/api/school/students/${ctx.studentNew}/history`, ctx.parentToken)).status, 404);
});

test('phase2: student documents are metadata CRUD with isolation', async () => {
  const doc = await req('POST', `/api/school/students/${ctx.studentNew}/documents`, ctx.adminA, {
    name: 'Birth Certificate', doc_type: 'birth_certificate', url: 'https://example.com/bc.pdf',
  });
  assert.equal(doc.status, 201);
  const list = await req('GET', `/api/school/students/${ctx.studentNew}/documents`, ctx.adminA);
  assert.equal(list.data.documents.length, 1);
  assert.equal(list.data.documents[0].name, 'Birth Certificate');
  // Cross-school and unrelated-parent access is 404.
  assert.equal((await req('GET', `/api/school/students/${ctx.studentNew}/documents`, ctx.adminB)).status, 404);
  assert.equal((await req('GET', `/api/school/students/${ctx.studentNew}/documents`, ctx.parentToken)).status, 404);
  // A parent CAN read their own child's (empty) document list.
  assert.equal((await req('GET', `/api/school/students/${ctx.studentA}/documents`, ctx.parentToken)).status, 200);
  const del = await req('DELETE', `/api/school/students/${ctx.studentNew}/documents/${doc.data.document.id}`, ctx.adminA);
  assert.equal(del.status, 200);
  const after = await req('GET', `/api/school/students/${ctx.studentNew}/documents`, ctx.adminA);
  assert.equal(after.data.documents.length, 0);
});

test('phase2: CSV import imports valid rows and reports per-row errors', async () => {
  const csv = [
    'class_name,section,roll_no,name,guardian_name,guardian_phone',
    'Class 5,A,91,Import One,Imp Father,03010000001',
    'Class 6,A,91,Import Two,Imp Father,03010000002',
    'No Such Class,A,92,Bad Class Kid,,',
    'Class 5,A,91,Duplicate Roll Kid,,',
    'Class 5,A,93,,,',
  ].join('\n');
  const r = await req('POST', '/api/school/students/import', ctx.adminA, { csv });
  assert.equal(r.status, 200);
  assert.equal(r.data.imported, 2);
  assert.deepEqual(r.data.errors.map((e) => e.row), [4, 5, 6]);
  assert.match(r.data.errors[0].error, /Unknown class/);
  assert.match(r.data.errors[1].error, /roll number/i);
  // Imported students got admission numbers.
  const found = await req('GET', '/api/school/students?q=Import', ctx.adminA);
  assert.equal(found.data.students.length, 2);
  assert.ok(found.data.students.every((s) => /^ADM-/.test(s.admission_number)));
});

test('phase2: CSV import stops at the subscription student limit', async () => {
  const before = await req('GET', '/api/school/students', ctx.adminC);
  const activeCount = before.data.students.filter((s) => s.status === 'active').length;
  const set = await req('PATCH', `/api/admin/schools/${ctx.schoolC.id}/subscription`, ctx.superToken, {
    student_limit: activeCount + 1,
  });
  assert.equal(set.status, 200);
  const csv = [
    'class_name,section,roll_no,name',
    'Class 1,A,81,Limit One',
    'Class 1,A,82,Limit Two',
  ].join('\n');
  const r = await req('POST', '/api/school/students/import', ctx.adminC, { csv });
  assert.equal(r.status, 200);
  assert.equal(r.data.imported, 1);
  assert.equal(r.data.errors.length, 1);
  assert.match(r.data.errors[0].error, /limit/i);
  const cleared = await req('PATCH', `/api/admin/schools/${ctx.schoolC.id}/subscription`, ctx.superToken, { student_limit: null });
  assert.equal(cleared.data.subscription.student_limit, null);
});

test('phase2: bulk promotion moves students with history; roll clash blocks', async () => {
  const cls7 = await req('POST', '/api/school/classes', ctx.adminA, { name: 'Class 7' });
  assert.equal(cls7.status, 201);
  ctx.class7 = cls7.data.class.id;

  const beforeList = await req('GET', `/api/school/students?class_id=${ctx.classA6}`, ctx.adminA);
  const sara = beforeList.data.students.find((s) => s.name === 'Sara Six');
  assert.ok(sara);

  const promo = await req('POST', '/api/school/students/promote', ctx.adminA, {
    from_class_id: ctx.classA6, to_class_id: ctx.class7,
  });
  assert.equal(promo.status, 200);
  // Sara + Bilal (Stage 1) plus the CSV-imported student from the
  // import test — all three active Class 6 students move.
  assert.equal(promo.data.promoted, 3);
  const inSeven = await req('GET', `/api/school/students?class_id=${ctx.class7}`, ctx.adminA);
  assert.deepEqual(inSeven.data.students.map((s) => s.name).sort(), ['Bilal Six', 'Import Two', 'Sara Six']);
  const hist = await req('GET', `/api/school/students/${sara.id}/history`, ctx.adminA);
  assert.ok(hist.data.history.some((h) => h.event === 'promotion' && h.to_class_id === ctx.class7));

  // Clash: same roll in the target class blocks the whole promotion.
  const from = await req('POST', '/api/school/classes', ctx.adminA, { name: 'Clash From' });
  const to = await req('POST', '/api/school/classes', ctx.adminA, { name: 'Clash To' });
  await req('POST', '/api/school/students', ctx.adminA, {
    class_id: from.data.class.id, section: 'A', roll_no: '1', name: 'Clash Kid',
  });
  await req('POST', '/api/school/students', ctx.adminA, {
    class_id: to.data.class.id, section: 'A', roll_no: '1', name: 'Target Kid',
  });
  const blocked = await req('POST', '/api/school/students/promote', ctx.adminA, {
    from_class_id: from.data.class.id, to_class_id: to.data.class.id,
  });
  assert.equal(blocked.status, 409);
  const stillThere = await req('GET', `/api/school/students?class_id=${from.data.class.id}`, ctx.adminA);
  assert.equal(stillThere.data.students.length, 1);
});

test('phase2: staff profiles CRUD, user linking, role gates', async () => {
  const users = await req('GET', '/api/school/users', ctx.adminA);
  const teacherUser = users.data.users.find((u) => u.email === 'teacher@citymodel.test');
  assert.ok(teacherUser);
  ctx.teacherUserId = teacherUser.id;

  const made = await req('POST', '/api/school/staff', ctx.hrToken, {
    full_name: 'Fatima Teacher', user_id: teacherUser.id,
    designation: 'Senior Teacher', department: 'Science', qualifications: 'MSc Physics',
    experience_years: 6, joining_date: '2020-03-01', phone: '03020000001',
    salary_basic: 80000, salary_allowances: { transport: 5000 },
  });
  assert.equal(made.status, 201);
  assert.equal(Number(made.data.staff_member.salary_basic), 80000);
  assert.equal(made.data.staff_member.salary_allowances.transport, 5000);
  ctx.staffTeacher = made.data.staff_member.id;

  // One profile per login user.
  assert.equal((await req('POST', '/api/school/staff', ctx.hrToken, {
    full_name: 'Duplicate Link', user_id: teacherUser.id,
  })).status, 409);
  // Accountant and principal have no staff access.
  assert.equal((await req('POST', '/api/school/staff', ctx.accountantToken, { full_name: 'Nope' })).status, 403);
  assert.equal((await req('GET', '/api/school/staff', ctx.principalToken)).status, 403);
  // Cross-school: B cannot read A's profile.
  assert.equal((await req('GET', `/api/school/staff/${ctx.staffTeacher}`, ctx.adminB)).status, 404);
  const listB = await req('GET', '/api/school/staff', ctx.adminB);
  assert.ok(!listB.data.staff.some((s) => s.id === ctx.staffTeacher));

  const patched = await req('PATCH', `/api/school/staff/${ctx.staffTeacher}`, ctx.adminA, { salary_basic: 85000 });
  assert.equal(patched.status, 200);
  assert.equal(Number(patched.data.staff_member.salary_basic), 85000);

  // An unlinked staff member (no login) for later attendance tests.
  const peon = await req('POST', '/api/school/staff', ctx.adminA, {
    full_name: 'Gate Keeper', designation: 'Peon', salary_basic: 30000,
  });
  assert.equal(peon.status, 201);
  ctx.staffPeon = peon.data.staff_member.id;
});

test('phase2: subjects, class subjects and teacher assignments widen teacher scope', async () => {
  const math = await req('POST', '/api/school/subjects', ctx.adminA, { name: 'Mathematics' });
  assert.equal(math.status, 201);
  ctx.subjectMath = math.data.subject.id;
  assert.equal((await req('POST', '/api/school/subjects', ctx.adminA, { name: 'Mathematics' })).status, 409);
  assert.equal((await req('POST', '/api/school/subjects', ctx.teacherToken, { name: 'Nope' })).status, 403);

  const cs = await req('POST', '/api/school/subjects/class-subjects', ctx.adminA, {
    class_id: ctx.classA, subject_id: ctx.subjectMath,
  });
  assert.equal(cs.status, 201);
  const csList = await req('GET', `/api/school/subjects/class-subjects?class_id=${ctx.classA}`, ctx.adminA);
  assert.equal(csList.data.class_subjects.length, 1);
  assert.equal(csList.data.class_subjects[0].subject_name, 'Mathematics');

  // The teacher was NOT Class 5's class teacher; a subject assignment
  // makes Class 5 one of their assigned classes.
  const ts = await req('POST', '/api/school/subjects/teacher-subjects', ctx.adminA, {
    teacher_user_id: ctx.teacherUserId, subject_id: ctx.subjectMath, class_id: ctx.classA,
  });
  assert.equal(ts.status, 201);
  const teacherStudents = await req('GET', '/api/school/students', ctx.teacherToken);
  assert.ok(teacherStudents.data.students.some((s) => s.id === ctx.studentA));
  const teacherClasses = await req('GET', '/api/school/classes', ctx.teacherToken);
  assert.ok(teacherClasses.data.classes.some((c) => c.id === ctx.classA));
});

test('phase2: academic sessions — seed, create, one current, class session_id', async () => {
  const list = await req('GET', '/api/school/sessions', ctx.adminA);
  assert.equal(list.status, 200);
  const seeded = list.data.sessions.find((s) => s.name === '2026-27');
  assert.ok(seeded);
  assert.equal(seeded.is_current, true);

  const made = await req('POST', '/api/school/sessions', ctx.adminA, {
    name: '2027-28', starts_on: '2027-04-01', ends_on: '2028-03-31', is_current: true,
  });
  assert.equal(made.status, 201);
  assert.equal(made.data.session.is_current, true);
  const after = await req('GET', '/api/school/sessions', ctx.adminA);
  const currents = after.data.sessions.filter((s) => s.is_current);
  assert.equal(currents.length, 1);
  assert.equal(currents[0].name, '2027-28');
  const me = await req('GET', '/api/auth/me', ctx.adminA);
  assert.equal(me.data.school.session, '2027-28');
  assert.equal((await req('POST', '/api/school/sessions', ctx.adminA, { name: '2027-28' })).status, 409);

  // A class can carry the session; switching current back restores the label.
  const cls = await req('POST', '/api/school/classes', ctx.adminA, {
    name: 'Session Class', session_id: made.data.session.id,
  });
  assert.equal(cls.status, 201);
  assert.equal(cls.data.class.session_id, made.data.session.id);
  const back = await req('POST', `/api/school/sessions/${seeded.id}/set-current`, ctx.adminA, {});
  assert.equal(back.status, 200);
  const me2 = await req('GET', '/api/auth/me', ctx.adminA);
  assert.equal(me2.data.school.session, '2026-27');
});

test('phase2: dashboard numbers match seeded records exactly', async () => {
  const reg = await req('POST', '/api/auth/register-school', null, {
    school_name: 'Dashboard School', slug: 'phase2-dash-school',
    admin_name: 'Dash Admin', admin_email: 'admin@dash.test', admin_password: 'password123',
  });
  assert.equal(reg.status, 201);
  const adminD = reg.data.token;
  const cls = await req('POST', '/api/school/classes', adminD, { name: 'Dash 1' });
  const classD = cls.data.class.id;
  const ids = [];
  for (const [roll, name] of [['1', 'Dash One'], ['2', 'Dash Two'], ['3', 'Dash Three']]) {
    const st = await req('POST', '/api/school/students', adminD, {
      class_id: classD, section: 'A', roll_no: roll, name,
    });
    assert.equal(st.status, 201);
    ids.push(st.data.student.id);
  }
  const tUser = await req('POST', '/api/school/users', adminD, {
    name: 'Dash Teacher', email: 'teacher@dash.test', password: 'password123', role: 'teacher',
  });
  assert.equal(tUser.status, 201);
  await req('PATCH', `/api/school/classes/${classD}`, adminD, { teacher_id: tUser.data.user.id });
  const teacherD = await loginAs('phase2-dash-school', 'teacher@dash.test');

  const bulk = await req('POST', '/api/school/attendance/bulk', adminD, {
    class_id: classD, date: TODAY,
    entries: [
      { student_id: ids[0], status: 'present' },
      { student_id: ids[1], status: 'present' },
      { student_id: ids[2], status: 'absent' },
    ],
  });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.data.marked, 3);

  const head = await req('POST', '/api/school/fees/heads', adminD, { name: 'Tuition' });
  const plan = await req('POST', '/api/school/fees/plans', adminD, {
    class_id: classD, fee_head_id: head.data.fee_head.id, amount: 1000, due_date: '2099-01-01',
  });
  const pay = await req('POST', '/api/school/fees/payments', adminD, {
    student_id: ids[0], plan_id: plan.data.fee_plan.id, amount: 500,
  });
  assert.equal(pay.status, 201);

  const dash = await req('GET', '/api/school/dashboard', adminD);
  assert.equal(dash.status, 200);
  const d = dash.data.dashboard;
  assert.deepEqual(
    [d.totals.students, d.totals.teachers, d.totals.classes],
    [3, 1, 1]
  );
  assert.deepEqual(
    [d.attendance_today.present, d.attendance_today.absent, d.attendance_today.pct],
    [2, 1, 66.7]
  );
  assert.deepEqual(
    [d.fees.today_collection, d.fees.month_collection, d.fees.outstanding, d.fees.month_expenses],
    [500, 500, 2500, 0]
  );
  assert.equal(d.recent_admissions.length, 3);
  assert.deepEqual(d.upcoming_exams, []);

  const tDash = await req('GET', '/api/school/dashboard', teacherD);
  assert.equal(tDash.data.dashboard.classes.length, 1);
  assert.equal(tDash.data.dashboard.classes[0].student_count, 3);
  assert.equal(tDash.data.dashboard.classes[0].attendance_today.present, 2);

  // Parent dashboard: linked student + this month's attendance.
  const pUser = await req('POST', '/api/school/users', adminD, {
    name: 'Dash Parent', email: 'parent@dash.test', password: 'password123',
    role: 'parent', linked_student_id: ids[2],
  });
  assert.equal(pUser.status, 201);
  const parentD = await loginAs('phase2-dash-school', 'parent@dash.test');
  const pDash = await req('GET', '/api/school/dashboard', parentD);
  assert.equal(pDash.data.dashboard.student.name, 'Dash Three');
  assert.equal(pDash.data.dashboard.attendance_month.absent, 1);

  ctx.dash = { adminD, classD, planD: plan.data.fee_plan.id, studentIds: ids, teacherD, parentD };
});

test('phase3: bulk attendance, status words, parent notifications, reports', async () => {
  // Bulk sheet for Class 5 on a fresh date: Ali absent, section-B kid present.
  const bulk = await req('POST', '/api/school/attendance/bulk', ctx.adminA, {
    class_id: ctx.classA, date: '2026-11-02',
    entries: [
      { student_id: ctx.studentA, status: 'absent' },
      { student_id: ctx.studentA2, status: 'present' },
    ],
  });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.data.marked, 2);

  // An entry for a student of another class fails the whole sheet.
  const sevenList = await req('GET', `/api/school/students?class_id=${ctx.class7}`, ctx.adminA);
  const saraId = sevenList.data.students.find((s) => s.name === 'Sara Six').id;
  assert.equal((await req('POST', '/api/school/attendance/bulk', ctx.adminA, {
    class_id: ctx.classA, date: '2026-11-02',
    entries: [{ student_id: saraId, status: 'present' }],
  })).status, 400);

  // Ali present the next day (single mark, word status).
  const single = await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '2026-11-03', status: 'present',
  });
  assert.equal(single.status, 201);
  assert.equal(single.data.attendance.status, 'present');

  // Parent got BOTH notifications (absent + arrival); admin got none.
  const notes = await req('GET', '/api/school/notifications', ctx.parentToken);
  assert.equal(notes.status, 200);
  const types = notes.data.notifications.map((n) => n.type);
  assert.ok(types.includes('attendance_absent'));
  assert.ok(types.includes('attendance_present'));
  assert.ok(notes.data.unread_count >= 2);
  ctx.notifId = notes.data.notifications[0].id;
  const adminNotes = await req('GET', '/api/school/notifications', ctx.adminA);
  assert.ok(!adminNotes.data.notifications.some((n) => n.id === ctx.notifId));

  // Re-marking the same status creates NO duplicate notification.
  const countBefore = notes.data.notifications.length;
  await req('POST', '/api/school/attendance', ctx.adminA, {
    student_id: ctx.studentA, date: '2026-11-02', status: 'absent',
  });
  const notesAfter = await req('GET', '/api/school/notifications', ctx.parentToken);
  assert.equal(notesAfter.data.notifications.length, countBefore);

  // Mark read / read all.
  const one = await req('POST', `/api/school/notifications/${ctx.notifId}/read`, ctx.parentToken, {});
  assert.equal(one.status, 200);
  const all = await req('POST', '/api/school/notifications/read-all', ctx.parentToken, {});
  assert.equal(all.status, 200);
  const cleared = await req('GET', '/api/school/notifications?unread=1', ctx.parentToken);
  assert.equal(cleared.data.unread_count, 0);

  // Late / half_day marks, then the monthly report math.
  const bulk2 = await req('POST', '/api/school/attendance/bulk', ctx.adminA, {
    class_id: ctx.classA, date: '2026-11-04',
    entries: [
      { student_id: ctx.studentA, status: 'late' },
      { student_id: ctx.studentA2, status: 'half_day' },
    ],
  });
  assert.equal(bulk2.status, 201);
  const monthly = await req('GET', `/api/school/attendance/class-monthly?class_id=${ctx.classA}&month=2026-11`, ctx.adminA);
  assert.equal(monthly.status, 200);
  const aliRow = monthly.data.students.find((s) => s.student_id === ctx.studentA);
  assert.deepEqual([aliRow.present, aliRow.absent, aliRow.late, aliRow.pct], [1, 1, 1, 33.3]);
  const a2Row = monthly.data.students.find((s) => s.student_id === ctx.studentA2);
  assert.equal(a2Row.half_day, 1);

  const report = await req('GET', `/api/school/attendance/student-report?student_id=${ctx.studentA}&from=2026-11-01&to=2026-11-30`, ctx.adminA);
  assert.deepEqual(
    [report.data.report.present, report.data.report.absent, report.data.report.late, report.data.report.pct],
    [1, 1, 1, 33.3]
  );

  // Teacher (subject-assigned to Class 5 in Phase 2) may bulk-mark it,
  // but not Class 7, which they have no assignment in.
  const tBulk = await req('POST', '/api/school/attendance/bulk', ctx.teacherToken, {
    class_id: ctx.classA, date: '2026-11-05',
    entries: [{ student_id: ctx.studentA2, status: 'present' }],
  });
  assert.equal(tBulk.status, 201);
  const sevenStudents = await req('GET', `/api/school/students?class_id=${ctx.class7}`, ctx.adminA);
  assert.equal((await req('POST', '/api/school/attendance/bulk', ctx.teacherToken, {
    class_id: ctx.class7, date: '2026-11-05',
    entries: [{ student_id: sevenStudents.data.students[0].id, status: 'present' }],
  })).status, 403);

  // Monthly CSV export carries the students and the % column.
  const csv = await reqText(`/api/school/attendance/export.csv?class_id=${ctx.classA}&month=2026-11`, ctx.adminA);
  assert.equal(csv.status, 200);
  assert.match(csv.contentType, /text\/csv/);
  assert.match(csv.text, /attendance_pct/);
  assert.match(csv.text, /Ali Khan/);
});

test('phase3: staff attendance bulk marking and sheet', async () => {
  const bulk = await req('POST', '/api/school/staff-attendance/bulk', ctx.hrToken, {
    date: '2026-11-05',
    entries: [
      { staff_profile_id: ctx.staffTeacher, status: 'present', check_in: '08:00', check_out: '14:00' },
      { staff_profile_id: ctx.staffPeon, status: 'absent' },
    ],
  });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.data.marked, 2);
  const sheet = await req('GET', '/api/school/staff-attendance?date=2026-11-05', ctx.principalToken);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.data.staff_attendance.length, 2);
  const fatima = sheet.data.staff_attendance.find((r) => r.staff_profile_id === ctx.staffTeacher);
  assert.equal(fatima.status, 'present');
  assert.equal(fatima.check_in, '08:00:00');
  // Re-mark updates instead of duplicating.
  await req('POST', '/api/school/staff-attendance/bulk', ctx.hrToken, {
    date: '2026-11-05',
    entries: [{ staff_profile_id: ctx.staffPeon, status: 'late', check_in: '09:30' }],
  });
  const sheet2 = await req('GET', '/api/school/staff-attendance?date=2026-11-05', ctx.adminA);
  assert.equal(sheet2.data.staff_attendance.length, 2);
  assert.equal(sheet2.data.staff_attendance.find((r) => r.staff_profile_id === ctx.staffPeon).status, 'late');
  // Accountant cannot mark staff attendance.
  assert.equal((await req('POST', '/api/school/staff-attendance/bulk', ctx.accountantToken, {
    date: '2026-11-05', entries: [{ staff_profile_id: ctx.staffPeon, status: 'present' }],
  })).status, 403);
});

test('phase3: fee discounts change charges, cap payments, and flow into vouchers', async () => {
  const { adminD, classD, planD, studentIds } = ctx.dash;
  const [, d2] = studentIds;

  const disc = await req('POST', '/api/school/fees/discounts', adminD, {
    student_id: d2, discount_type: 'percent', value: 10, kind: 'scholarship', reason: 'Merit',
  });
  assert.equal(disc.status, 201);
  let sum = await req('GET', `/api/school/fees/summary?student_id=${d2}`, adminD);
  assert.deepEqual([sum.data.summary.total, sum.data.summary.pending], [900, 900]);

  const fixed = await req('POST', '/api/school/fees/discounts', adminD, {
    student_id: d2, discount_type: 'fixed', value: 100, kind: 'sibling',
  });
  assert.equal(fixed.status, 201);
  sum = await req('GET', `/api/school/fees/summary?student_id=${d2}`, adminD);
  assert.equal(sum.data.summary.total, 800);
  const delFixed = await req('DELETE', `/api/school/fees/discounts/${fixed.data.discount.id}`, adminD);
  assert.equal(delFixed.status, 200);
  sum = await req('GET', `/api/school/fees/summary?student_id=${d2}`, adminD);
  assert.equal(sum.data.summary.total, 900);

  // Payments are capped at the DISCOUNTED pending: 901 fails, 900 clears it.
  assert.equal((await req('POST', '/api/school/fees/payments', adminD, {
    student_id: d2, plan_id: planD, amount: 901,
  })).status, 400);
  const pay = await req('POST', '/api/school/fees/payments', adminD, {
    student_id: d2, plan_id: planD, amount: 900,
  });
  assert.equal(pay.status, 201);
  sum = await req('GET', `/api/school/fees/summary?student_id=${d2}`, adminD);
  assert.equal(sum.data.summary.pending, 0);

  // Vouchers snapshot the discounted charge per student.
  const gen = await req('POST', '/api/school/fees/vouchers/generate', adminD, {
    class_id: classD, period: MONTH,
  });
  assert.equal(gen.status, 201);
  assert.equal(gen.data.generated.created, 3);
  const again = await req('POST', '/api/school/fees/vouchers/generate', adminD, {
    class_id: classD, period: MONTH,
  });
  assert.equal(again.data.generated.created, 0);
  assert.equal(again.data.generated.skipped, 3);
  const vouchers = await req('GET', `/api/school/fees/vouchers?class_id=${classD}&period=${MONTH}`, adminD);
  assert.equal(vouchers.data.vouchers.length, 3);
  const v2 = vouchers.data.vouchers.find((v) => v.student_id === d2);
  assert.deepEqual([Number(v2.amount), Number(v2.discount_amount)], [900, 100]);
});

test('phase3: late fines (flat + per-day) and the defaulters list', async () => {
  const { adminD, classD, studentIds } = ctx.dash;
  const [d1, d2, d3] = studentIds;

  const set = await req('PUT', '/api/school/fees/settings', adminD, {
    late_fine_type: 'flat', late_fine_amount: 200, late_fine_grace_days: 0,
  });
  assert.equal(set.status, 200);
  const head = await req('POST', '/api/school/fees/heads', adminD, { name: 'Late Test' });
  const plan = await req('POST', '/api/school/fees/plans', adminD, {
    class_id: classD, fee_head_id: head.data.fee_head.id, amount: 500, due_date: daysAgo(5),
  });
  assert.equal(plan.status, 201);

  const sum = await req('GET', `/api/school/fees/summary?student_id=${d3}`, adminD);
  const lt = sum.data.summary.plans.find((p) => p.plan_id === plan.data.fee_plan.id);
  assert.deepEqual([lt.pending, lt.fine, lt.overdue], [500, 200, true]);
  assert.equal(sum.data.summary.fine_total, 200);

  // Defaulters: the Late Test plan charges the WHOLE class, so all
  // three students are defaulters on it (D1's tuition is not yet due
  // and D2's tuition is paid, but the late-test charge is unpaid).
  const defs = await req('GET', '/api/school/fees/defaulters', adminD);
  assert.equal(defs.data.defaulters.length, 3);
  const d3Row = defs.data.defaulters.find((d) => d.student_id === d3);
  assert.deepEqual(
    [d3Row.total_pending, d3Row.total_fine, d3Row.overdue_amount],
    [500, 200, 700]
  );
  // D2's scholarship discount applies to this plan too: 450 + 200.
  const d2Row = defs.data.defaulters.find((d) => d.student_id === studentIds[1]);
  assert.deepEqual([d2Row.total_pending, d2Row.overdue_amount], [450, 650]);

  // Per-day: 10/day x 5 days overdue = 50.
  await req('PUT', '/api/school/fees/settings', adminD, {
    late_fine_type: 'per_day', late_fine_amount: 10, late_fine_grace_days: 0,
  });
  const sum2 = await req('GET', `/api/school/fees/summary?student_id=${d3}`, adminD);
  const lt2 = sum2.data.summary.plans.find((p) => p.plan_id === plan.data.fee_plan.id);
  assert.equal(lt2.fine, 50);
  await req('PUT', '/api/school/fees/settings', adminD, {
    late_fine_type: 'flat', late_fine_amount: 200, late_fine_grace_days: 0,
  });
});

test('phase3: payment methods + reference, receipt, collection reports, CSV exports', async () => {
  const { adminD, planD, studentIds } = ctx.dash;
  const [d1] = studentIds;

  const pay = await req('POST', '/api/school/fees/payments', adminD, {
    student_id: d1, plan_id: planD, amount: 500, method: 'JazzCash', reference: 'TXN-123',
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.data.fee_payment.method, 'jazzcash');
  assert.equal(pay.data.fee_payment.reference, 'TXN-123');
  assert.equal((await req('POST', '/api/school/fees/payments', adminD, {
    student_id: d1, plan_id: planD, amount: 1, method: 'bitcoin',
  })).status, 400);

  // Printable receipt (HTML) for the payer's own school + parent.
  const receipt = await reqText(`/api/school/fees/payments/${pay.data.fee_payment.id}/receipt`, adminD);
  assert.equal(receipt.status, 200);
  assert.match(receipt.contentType, /text\/html/);
  assert.match(receipt.text, new RegExp(pay.data.fee_payment.receipt_no));
  assert.match(receipt.text, /Dashboard School/);
  const pUser = await req('POST', '/api/school/users', adminD, {
    name: 'D1 Parent', email: 'p1@dash.test', password: 'password123',
    role: 'parent', linked_student_id: d1,
  });
  assert.equal(pUser.status, 201);
  const parentD1 = await loginAs('phase2-dash-school', 'p1@dash.test');
  assert.equal((await reqText(`/api/school/fees/payments/${pay.data.fee_payment.id}/receipt`, parentD1)).status, 200);
  // ...but not a receipt for another student's payment.
  const other = await req('GET', `/api/school/fees/payments?student_id=${studentIds[1]}`, adminD);
  assert.equal((await reqText(`/api/school/fees/payments/${other.data.fee_payments[0].id}/receipt`, parentD1)).status, 404);

  // Collections report: 500 + 900 + 500 collected this month in school D.
  const coll = await req('GET', '/api/school/fees/reports/collections?group_by=month', adminD);
  const row = coll.data.collections.find((c) => c.period === MONTH);
  assert.deepEqual([row.total, row.payments], [1900, 3]);

  const collCsv = await reqText('/api/school/fees/collections.csv', adminD);
  assert.match(collCsv.text, /TXN-123/);
  assert.match(collCsv.text, /RCPT-/);
  const defCsv = await reqText('/api/school/fees/defaulters.csv', adminD);
  assert.match(defCsv.text, /Dash Three/);
  const stuCsv = await reqText('/api/school/students/export.csv', ctx.adminA);
  assert.equal(stuCsv.status, 200);
  assert.match(stuCsv.text, /admission_number/);
  assert.match(stuCsv.text, /Ali Khan/);
  assert.match(stuCsv.text, /ADM-\d{4}-\d{4}/);
});

test('phase3: accounts — categories, expenses, income, cashbook, profit & loss', async () => {
  const cats = await req('GET', '/api/school/accounts/categories', ctx.accountantToken);
  assert.equal(cats.status, 200);
  assert.ok(cats.data.categories.some((c) => c.name === 'Salaries'));
  assert.ok(cats.data.categories.length >= 7);
  const salaries = cats.data.categories.find((c) => c.name === 'Salaries');

  const made = await req('POST', '/api/school/accounts/categories', ctx.accountantToken, { name: 'Exam Printing' });
  assert.equal(made.status, 201);
  assert.equal((await req('POST', '/api/school/accounts/categories', ctx.accountantToken, { name: 'Exam Printing' })).status, 409);

  // A fixed August date keeps this test independent of the run date
  // (other tests' payments land on the real "today").
  const e1 = await req('POST', '/api/school/accounts/expenses', ctx.accountantToken, {
    category_id: salaries.id, amount: 5000, spent_on: '2026-08-15', note: 'Staff salaries',
  });
  assert.equal(e1.status, 201);
  assert.equal(e1.data.expense.category, 'Salaries');
  const e2 = await req('POST', '/api/school/accounts/expenses', ctx.accountantToken, {
    category: 'Utilities', amount: 1500, spent_on: '2026-08-15',
  });
  assert.equal(e2.status, 201);
  const inc = await req('POST', '/api/school/accounts/income', ctx.accountantToken, {
    category: 'Donation', amount: 2000, received_on: '2026-08-15',
  });
  assert.equal(inc.status, 201);

  // A fee payment ON 2026-08-15 (Ali's Exam plan still owes 2000).
  const examSummary = await req('GET', `/api/school/fees/summary?student_id=${ctx.studentA}`, ctx.adminA);
  const examPlan = examSummary.data.summary.plans.find((p) => p.fee_head_name === 'Exam');
  const feePay = await req('POST', '/api/school/fees/payments', ctx.adminA, {
    student_id: ctx.studentA, plan_id: examPlan.plan_id, amount: 300, paid_date: '2026-08-15',
  });
  assert.equal(feePay.status, 201);

  const book = await req('GET', '/api/school/accounts/cashbook?date=2026-08-15', ctx.accountantToken);
  assert.equal(book.status, 200);
  assert.deepEqual(
    [book.data.cashbook.totals.fee_income, book.data.cashbook.totals.other_income,
     book.data.cashbook.totals.expenses, book.data.cashbook.totals.net],
    [300, 2000, 6500, -4200]
  );

  const pl = await req('GET', '/api/school/accounts/profit-loss?from=2026-08-01&to=2026-08-31', ctx.accountantToken);
  assert.deepEqual(
    [pl.data.profit_loss.fee_income, pl.data.profit_loss.other_income,
     pl.data.profit_loss.total_expenses, pl.data.profit_loss.net],
    [300, 2000, 6500, -4200]
  );
  const byCat = Object.fromEntries(pl.data.profit_loss.expenses_by_category.map((r) => [r.category, r.total]));
  assert.deepEqual([byCat.Salaries, byCat.Utilities], [5000, 1500]);

  // Principal reads but cannot write; teacher has no accounts access.
  assert.equal((await req('GET', '/api/school/accounts/cashbook?date=2026-08-15', ctx.principalToken)).status, 200);
  assert.equal((await req('POST', '/api/school/accounts/expenses', ctx.principalToken, {
    category: 'X', amount: 1, spent_on: '2026-08-15',
  })).status, 403);
  assert.equal((await req('GET', '/api/school/accounts/categories', ctx.teacherToken)).status, 403);

  // Dashboard picks up this month's expenses for school A: one more
  // expense dated today is all that falls in the current month.
  const e3 = await req('POST', '/api/school/accounts/expenses', ctx.accountantToken, {
    category: 'Utilities', amount: 700, spent_on: TODAY,
  });
  assert.equal(e3.status, 201);
  const dash = await req('GET', '/api/school/dashboard', ctx.adminA);
  assert.equal(dash.data.dashboard.fees.month_expenses, 700);
});

test('phase3: tenant isolation on Phase 2/3 tables (API + RLS)', async () => {
  // API layer: B sees none of A's staff / expenses / notifications.
  const staffB = await req('GET', '/api/school/staff', ctx.adminB);
  assert.ok(!staffB.data.staff.some((s) => s.id === ctx.staffTeacher));
  assert.equal((await req('DELETE', `/api/school/accounts/expenses/${ctx.staffTeacher}`, ctx.adminB)).status, 404);
  const notesB = await req('GET', '/api/school/notifications', ctx.adminB);
  assert.ok(!notesB.data.notifications.some((n) => n.id === ctx.notifId));
  const expB = await req('GET', '/api/school/accounts/expenses', ctx.adminB);
  assert.equal(expB.data.expenses.length, 0);

  // DB layer (RLS).
  const rlsPool = new Pool({
    connectionString: `postgres://${RLS_USER}:${RLS_PASS}@127.0.0.1:5432/school_saas_test`,
  });
  try {
    const cA = await rlsPool.connect();
    try {
      await cA.query('BEGIN');
      await cA.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ctx.schoolA.id]);
      for (const table of ['staff_profiles', 'notifications', 'expense_records', 'student_documents', 'subjects', 'sessions']) {
        const r = await cA.query(`SELECT school_id FROM ${table}`);
        assert.ok(r.rows.every((row) => row.school_id === ctx.schoolA.id), `${table} leaks across tenants`);
      }
      const cross = await cA.query('SELECT id FROM notifications WHERE id = $1 AND school_id = $2', [ctx.notifId, ctx.schoolB.id]);
      assert.equal(cross.rows.length, 0);
      await cA.query('ROLLBACK');
    } finally {
      cA.release();
    }
    const c0 = await rlsPool.connect();
    try {
      const r = await c0.query('SELECT id FROM notifications');
      assert.equal(r.rows.length, 0);
      const r2 = await c0.query('SELECT id FROM staff_profiles');
      assert.equal(r2.rows.length, 0);
    } finally {
      c0.release();
    }
  } finally {
    await rlsPool.end();
  }
});

// ---------------------------------------------------------------------
// Phases 4–8 — exams/results, homework, timetable, portals, transport,
// library, inventory, HR (leaves + payroll), analytics, reports,
// audit. Fixtures live in a fresh school ("Phase School") so the
// numbers asserted here are exact and independent of earlier phases.
// ---------------------------------------------------------------------

test('phase4: setup — phase school with classes, subjects, students, teachers, parent', async () => {
  const reg = await req('POST', '/api/auth/register-school', null, {
    school_name: 'Phase School', slug: 'phase-school',
    admin_name: 'Phase Admin', admin_email: 'admin@phase.test', admin_password: 'password123',
  });
  assert.equal(reg.status, 201);
  const admin = reg.data.token;
  const c1 = await req('POST', '/api/school/classes', admin, { name: 'Phase 1' });
  const c2 = await req('POST', '/api/school/classes', admin, { name: 'Phase 2' });
  assert.equal(c1.status, 201);
  const math = await req('POST', '/api/school/subjects', admin, { name: 'Mathematics' });
  const eng = await req('POST', '/api/school/subjects', admin, { name: 'English' });
  const ids = {};
  for (const [key, cls, roll, name] of [
    ['e1', c1.data.class.id, '1', 'Exam One'],
    ['e2', c1.data.class.id, '2', 'Exam Two'],
    ['e3', c2.data.class.id, '1', 'Exam Three'],
  ]) {
    const st = await req('POST', '/api/school/students', admin, {
      class_id: cls, section: 'A', roll_no: roll, name,
    });
    assert.equal(st.status, 201);
    ids[key] = st.data.student.id;
  }
  const t1 = await req('POST', '/api/school/users', admin, {
    name: 'Phase Teacher One', email: 't1@phase.test', password: 'password123', role: 'teacher',
  });
  const t2 = await req('POST', '/api/school/users', admin, {
    name: 'Phase Teacher Two', email: 't2@phase.test', password: 'password123', role: 'teacher',
  });
  assert.equal(t1.status, 201);
  // T1 teaches Mathematics in Phase 1; T2 teaches English in Phase 2.
  await req('POST', '/api/school/subjects/teacher-subjects', admin, {
    teacher_user_id: t1.data.user.id, subject_id: math.data.subject.id, class_id: c1.data.class.id,
  });
  await req('POST', '/api/school/subjects/teacher-subjects', admin, {
    teacher_user_id: t2.data.user.id, subject_id: eng.data.subject.id, class_id: c2.data.class.id,
  });
  const parent = await req('POST', '/api/school/users', admin, {
    name: 'Phase Parent', email: 'parent@phase.test', password: 'password123',
    role: 'parent', linked_student_id: ids.e1,
  });
  assert.equal(parent.status, 201);
  ctx.px = {
    admin,
    schoolId: reg.data.school.id,
    class1: c1.data.class.id, class2: c2.data.class.id,
    math: math.data.subject.id, eng: eng.data.subject.id,
    e1: ids.e1, e2: ids.e2, e3: ids.e3,
    t1Id: t1.data.user.id, t2Id: t2.data.user.id,
    t1: await loginAs('phase-school', 't1@phase.test'),
    t2: await loginAs('phase-school', 't2@phase.test'),
    parent: await loginAs('phase-school', 'parent@phase.test'),
  };
});

test('phase4: terms, grading scale, exams, bulk marks — exact grades, GPA, positions', async () => {
  const P = ctx.px;
  // Terms are office writes: a teacher cannot create one.
  assert.equal((await req('POST', '/api/school/exams/terms', P.t1, { name: 'Mid Term' })).status, 403);
  const term = await req('POST', '/api/school/exams/terms', P.admin, { name: 'Mid Term' });
  assert.equal(term.status, 201);
  P.term = term.data.term.id;
  assert.equal(term.data.term.results_published, false);

  // Grading: defaults are served before any custom scale exists.
  const g0 = await req('GET', '/api/school/exams/grading', P.admin);
  assert.equal(g0.data.is_custom, false);
  assert.ok(g0.data.bands.some((b) => b.label === 'A+'));
  // Overlapping bands are rejected.
  assert.equal((await req('PUT', '/api/school/exams/grading', P.admin, {
    bands: [
      { label: 'A', min_pct: 80, max_pct: 100, grade_point: 4 },
      { label: 'B', min_pct: 70, max_pct: 85, grade_point: 3 },
    ],
  })).status, 400);
  const g1 = await req('PUT', '/api/school/exams/grading', P.admin, {
    bands: [
      { label: 'A+', min_pct: 85, max_pct: 100, grade_point: 4 },
      { label: 'A', min_pct: 75, max_pct: 84.99, grade_point: 3.5 },
      { label: 'B', min_pct: 60, max_pct: 74.99, grade_point: 3 },
      { label: 'C', min_pct: 50, max_pct: 59.99, grade_point: 2 },
      { label: 'F', min_pct: 0, max_pct: 49.99, grade_point: 0 },
    ],
  });
  assert.equal(g1.status, 200);
  assert.equal(g1.data.is_custom, true);

  const mathExam = await req('POST', '/api/school/exams', P.admin, {
    term_id: P.term, class_id: P.class1, subject_id: P.math, name: 'Paper 1', total_marks: 100,
  });
  assert.equal(mathExam.status, 201);
  P.mathExam = mathExam.data.exam.id;
  const engExam = await req('POST', '/api/school/exams', P.admin, {
    term_id: P.term, class_id: P.class1, subject_id: P.eng, name: 'Paper 1', total_marks: 50,
  });
  assert.equal(engExam.status, 201);
  P.engExam = engExam.data.exam.id;

  // Marks above the total and students of another class are rejected.
  assert.equal((await req('POST', `/api/school/exams/${P.mathExam}/marks/bulk`, P.admin, {
    entries: [{ student_id: P.e1, marks_obtained: 101 }],
  })).status, 400);
  assert.equal((await req('POST', `/api/school/exams/${P.mathExam}/marks/bulk`, P.admin, {
    entries: [{ student_id: P.e3, marks_obtained: 10 }],
  })).status, 400);

  // T1 teaches Mathematics in Phase 1 -> may enter its marks; T1 does
  // NOT teach English -> 403 there. The office enters English marks.
  const m1 = await req('POST', `/api/school/exams/${P.mathExam}/marks/bulk`, P.t1, {
    entries: [
      { student_id: P.e1, marks_obtained: 85 },
      { student_id: P.e2, marks_obtained: 70 },
    ],
  });
  assert.equal(m1.status, 201);
  assert.equal(m1.data.saved, 2);
  assert.equal((await req('POST', `/api/school/exams/${P.engExam}/marks/bulk`, P.t1, {
    entries: [{ student_id: P.e1, marks_obtained: 40 }],
  })).status, 403);
  const m2 = await req('POST', `/api/school/exams/${P.engExam}/marks/bulk`, P.admin, {
    entries: [
      { student_id: P.e1, marks_obtained: 40 },
      { student_id: P.e2, marks_obtained: 25 },
    ],
  });
  assert.equal(m2.status, 201);

  // E1: Math 85% -> A+ (4.0); English 80% -> A (3.5); overall
  // 125/150 = 83.33% -> A; GPA (4.0+3.5)/2 = 3.75; position 1.
  const r1 = await req('GET', `/api/school/exams/results/student/${P.e1}?term_id=${P.term}`, P.admin);
  assert.equal(r1.status, 200);
  assert.deepEqual(
    [r1.data.result.pct, r1.data.result.grade, r1.data.result.gpa, r1.data.result.position, r1.data.result.class_size],
    [83.33, 'A', 3.75, 1, 2]
  );
  // E2: Math 70% -> B (3.0); English 50% -> C (2.0); overall
  // 95/150 = 63.33% -> B; GPA 2.5; position 2.
  const r2 = await req('GET', `/api/school/exams/results/student/${P.e2}?term_id=${P.term}`, P.admin);
  assert.deepEqual(
    [r2.data.result.pct, r2.data.result.grade, r2.data.result.gpa, r2.data.result.position],
    [63.33, 'B', 2.5, 2]
  );

  const classRes = await req('GET', `/api/school/exams/results/class/${P.class1}?term_id=${P.term}`, P.admin);
  assert.deepEqual(classRes.data.results.map((r) => r.student.name), ['Exam One', 'Exam Two']);
  assert.deepEqual(
    [classRes.data.results[0].obtained, classRes.data.results[0].total, classRes.data.results[0].pct],
    [125, 150, 83.33]
  );
  const merit = await req('GET', `/api/school/exams/merit?term_id=${P.term}&class_id=${P.class1}`, P.admin);
  assert.equal(merit.data.merit[0].name, 'Exam One');
  assert.equal(merit.data.merit[0].rank, 1);

  const csv = await reqText(`/api/school/exams/results/export.csv?class_id=${P.class1}&term_id=${P.term}`, P.admin);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Exam One/);
  assert.match(csv.text, /83\.33/);

  const card = await reqText(`/api/school/exams/report-card/${P.e1}?term_id=${P.term}`, P.admin);
  assert.equal(card.status, 200);
  assert.match(card.text, /Report Card/);
  assert.match(card.text, /Exam One/);
  assert.match(card.text, /Mathematics/);
});

test('phase4: publication gate for parents + dashboard upcoming exams', async () => {
  const P = ctx.px;
  // The future exam lives in its OWN term so it cannot dilute the
  // Mid Term results asserted elsewhere (it has no marks yet).
  const term2 = await req('POST', '/api/school/exams/terms', P.admin, { name: 'Final Term' });
  assert.equal(term2.status, 201);
  P.term2 = term2.data.term.id;
  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const ex = await req('POST', '/api/school/exams', P.admin, {
    term_id: P.term2, class_id: P.class1, subject_id: P.math, name: 'Paper 2', exam_date: future, total_marks: 100,
  });
  assert.equal(ex.status, 201);

  const dash = await req('GET', '/api/school/dashboard', P.admin);
  assert.equal(dash.data.dashboard.upcoming_exams.length, 1);
  assert.equal(dash.data.dashboard.upcoming_exams[0].name, 'Paper 2');
  const pDash = await req('GET', '/api/school/dashboard', P.parent);
  assert.equal(pDash.data.dashboard.upcoming_exams.length, 1);

  // Before publication the parent sees nothing of the results.
  assert.equal((await req('GET', `/api/school/exams/results/student/${P.e1}?term_id=${P.term}`, P.parent)).status, 403);
  assert.equal((await reqText(`/api/school/exams/report-card/${P.e1}?term_id=${P.term}`, P.parent)).status, 403);
  // And never another child's result, published or not.
  assert.equal((await req('GET', `/api/school/exams/results/student/${P.e2}?term_id=${P.term}`, P.parent)).status, 404);

  const pub = await req('POST', `/api/school/exams/terms/${P.term}/publish`, P.admin, { published: true });
  assert.equal(pub.status, 200);
  assert.equal(pub.data.term.results_published, true);
  const after = await req('GET', `/api/school/exams/results/student/${P.e1}?term_id=${P.term}`, P.parent);
  assert.equal(after.status, 200);
  assert.equal(after.data.result.pct, 83.33);
});

test('phase5: homework lifecycle — assign, submit, late, check', async () => {
  const P = ctx.px;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // T2 teaches in Phase 2 only -> cannot assign homework to Phase 1.
  assert.equal((await req('POST', '/api/school/homework', P.t2, {
    class_id: P.class1, title: 'Nope',
  })).status, 403);

  const hw = await req('POST', '/api/school/homework', P.t1, {
    class_id: P.class1, subject_id: P.math, title: 'Algebra worksheet', due_date: tomorrow,
  });
  assert.equal(hw.status, 201);
  assert.equal(hw.data.submissions_created, 2); // Exam One + Exam Two
  P.hw1 = hw.data.homework.id;

  const parentList = await req('GET', '/api/school/homework', P.parent);
  const mine = parentList.data.homework.find((h) => h.id === P.hw1);
  assert.equal(mine.my_status, 'pending');

  const sub = await req('POST', `/api/school/homework/${P.hw1}/submit`, P.parent, { note: 'Done' });
  assert.equal(sub.status, 200);
  assert.equal(sub.data.submission.status, 'submitted');
  P.sub1 = sub.data.submission.id;

  const roster = await req('GET', `/api/school/homework/${P.hw1}/submissions`, P.t1);
  assert.equal(roster.data.submissions.find((s) => s.student_id === P.e1).status, 'submitted');
  assert.equal(roster.data.submissions.find((s) => s.student_id === P.e2).status, 'pending');

  const checked = await req('POST', `/api/school/homework/${P.hw1}/submissions/${P.sub1}/check`, P.t1, {
    feedback: 'Good work',
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.submission.status, 'checked');
  assert.equal(checked.data.submission.feedback, 'Good work');

  // Past-due homework submitted now is 'late', not 'submitted'.
  const hw2 = await req('POST', '/api/school/homework', P.admin, {
    class_id: P.class1, title: 'Old reading', due_date: yesterday,
  });
  assert.equal(hw2.status, 201);
  P.hw2 = hw2.data.homework.id;
  const late = await req('POST', `/api/school/homework/${P.hw2}/submit`, P.parent, {});
  assert.equal(late.data.submission.status, 'late');

  // A fresh homework stays pending for the portal test.
  const hw3 = await req('POST', '/api/school/homework', P.admin, {
    class_id: P.class1, title: 'Fresh essay', due_date: tomorrow,
  });
  P.hw3 = hw3.data.homework.id;
});

test('phase5: timetable slots with class / teacher / room conflict detection', async () => {
  const P = ctx.px;
  const s1 = await req('POST', '/api/school/timetable/slots', P.admin, {
    class_id: P.class1, weekday: 1, period_no: 1, subject_id: P.math,
    teacher_user_id: P.t1Id, starts_at: '08:00', ends_at: '08:45', room: 'Room 1',
  });
  assert.equal(s1.status, 201);
  // Same class + weekday + period -> 409.
  assert.equal((await req('POST', '/api/school/timetable/slots', P.admin, {
    class_id: P.class1, weekday: 1, period_no: 1, subject_id: P.eng,
  })).status, 409);
  // Same teacher, another class, same slot -> 409 (double-booked).
  assert.equal((await req('POST', '/api/school/timetable/slots', P.admin, {
    class_id: P.class2, weekday: 1, period_no: 1, teacher_user_id: P.t1Id,
  })).status, 409);
  // Same teacher, different period -> fine.
  assert.equal((await req('POST', '/api/school/timetable/slots', P.admin, {
    class_id: P.class2, weekday: 1, period_no: 2, teacher_user_id: P.t1Id,
    starts_at: '08:50', ends_at: '09:35',
  })).status, 201);
  // Room clash at the same time in another class -> 409.
  assert.equal((await req('POST', '/api/school/timetable/slots', P.admin, {
    class_id: P.class1, weekday: 1, period_no: 3, subject_id: P.eng, room: 'Room 9',
    starts_at: '10:00', ends_at: '10:45',
  })).status, 201);
  assert.equal((await req('POST', '/api/school/timetable/slots', P.admin, {
    class_id: P.class2, weekday: 1, period_no: 3, room: 'Room 9',
    starts_at: '10:15', ends_at: '11:00',
  })).status, 409);
  // Teachers cannot write the timetable.
  assert.equal((await req('POST', '/api/school/timetable/slots', P.t1, {
    class_id: P.class1, weekday: 2, period_no: 1,
  })).status, 403);

  const parentTt = await req('GET', `/api/school/timetable?class_id=${P.class1}`, P.parent);
  assert.ok(parentTt.data.slots.length >= 2);
  assert.ok(parentTt.data.slots.every((s) => s.class_id === P.class1));
  const t1Week = await req('GET', `/api/school/timetable/teacher/${P.t1Id}`, P.admin);
  assert.equal(t1Week.data.slots.length, 2);
});

test('phase5: portals aggregate real data for parent and teacher', async () => {
  const P = ctx.px;
  // Fees for Phase 1: plan 2000, Exam One pays 500.
  const head = await req('POST', '/api/school/fees/heads', P.admin, { name: 'Tuition' });
  const plan = await req('POST', '/api/school/fees/plans', P.admin, {
    class_id: P.class1, fee_head_id: head.data.fee_head.id, amount: 2000, due_date: '2099-01-01',
  });
  P.plan = plan.data.fee_plan.id;
  const pay = await req('POST', '/api/school/fees/payments', P.admin, {
    student_id: P.e1, plan_id: P.plan, amount: 500,
  });
  assert.equal(pay.status, 201);

  const bulk = await req('POST', '/api/school/attendance/bulk', P.admin, {
    class_id: P.class1, date: TODAY,
    entries: [
      { student_id: P.e1, status: 'present' },
      { student_id: P.e2, status: 'absent' },
    ],
  });
  assert.equal(bulk.status, 201);

  const portal = await req('GET', '/api/school/portal/me', P.parent);
  assert.equal(portal.status, 200);
  const p = portal.data.portal;
  assert.equal(p.student.name, 'Exam One');
  assert.deepEqual([p.fees.total, p.fees.paid, p.fees.pending], [2000, 500, 1500]);
  assert.equal(p.attendance.month.pct, 100);
  assert.deepEqual(p.homework_pending.map((h) => h.id), [P.hw3]);
  assert.equal(p.transport, null);
  assert.equal(p.library_loans.length, 0);
  assert.equal(p.results.length, 1);
  assert.equal(p.results[0].pct, 83.33);
  assert.equal(p.results[0].grade, 'A');
  assert.ok(p.timetable.length >= 2);

  // The parent portal is not for office accounts.
  assert.equal((await req('GET', '/api/school/portal/me', P.admin)).status, 403);

  const tp = await req('GET', '/api/school/portal/teacher', P.t1);
  assert.equal(tp.status, 200);
  assert.ok(tp.data.portal.classes.some((c) => c.id === P.class1));
  assert.ok(tp.data.portal.subjects.some((s) => s.subject_name === 'Mathematics'));
  // Exam Two's homework + Exam One's late submission are unchecked.
  assert.ok(tp.data.portal.homework_to_check >= 1);
  assert.ok(tp.data.portal.upcoming_exams.some((e) => e.name === 'Paper 2'));
});

test('phase6: transport — vehicles, routes, stops, assignments, manifest', async () => {
  const P = ctx.px;
  const tmUser = await req('POST', '/api/school/users', P.admin, {
    name: 'Transport Manager', email: 'tm@phase.test', password: 'password123', role: 'transport_manager',
  });
  assert.equal(tmUser.status, 201);
  const tm = await loginAs('phase-school', 'tm@phase.test');
  P.tm = tm;

  const veh = await req('POST', '/api/school/transport/vehicles', tm, {
    registration_no: 'LEA-123', vehicle_type: 'bus', capacity: 40,
    driver_name: 'Driver Dan', driver_phone: '03009998887',
  });
  assert.equal(veh.status, 201);
  P.vehicle = veh.data.vehicle.id;
  assert.equal((await req('POST', '/api/school/transport/vehicles', tm, {
    registration_no: 'LEA-123',
  })).status, 409);

  const route = await req('POST', '/api/school/transport/routes', tm, {
    name: 'Route A', vehicle_id: P.vehicle,
  });
  assert.equal(route.status, 201);
  P.route = route.data.route.id;
  const stop1 = await req('POST', `/api/school/transport/routes/${P.route}/stops`, tm, {
    stop_name: 'Main Chowk', sequence: 1, pickup_time: '07:00',
  });
  assert.equal(stop1.status, 201);
  P.stop1 = stop1.data.stop.id;
  const stop2 = await req('POST', `/api/school/transport/routes/${P.route}/stops`, tm, {
    stop_name: 'Bridge Stop', sequence: 2, pickup_time: '07:15',
  });
  assert.equal(stop2.status, 201);
  P.stop2 = stop2.data.stop.id;

  const a1 = await req('POST', '/api/school/transport/assignments', tm, {
    student_id: P.e1, route_id: P.route, stop_id: P.stop1, fee_amount: 1500,
  });
  assert.equal(a1.status, 201);
  P.assign1 = a1.data.assignment.id;
  const a2 = await req('POST', '/api/school/transport/assignments', tm, {
    student_id: P.e2, route_id: P.route, stop_id: P.stop2, fee_amount: 1500,
  });
  assert.equal(a2.status, 201);
  P.assign2 = a2.data.assignment.id;
  // One assignment per student.
  assert.equal((await req('POST', '/api/school/transport/assignments', tm, {
    student_id: P.e1, route_id: P.route,
  })).status, 409);
  // A stop of another route is rejected (stop2 belongs to Route A;
  // use Route B's stop against Route A).
  const routeB = await req('POST', '/api/school/transport/routes', tm, { name: 'Route B' });
  const stopB = await req('POST', `/api/school/transport/routes/${routeB.data.route.id}/stops`, tm, {
    stop_name: 'Far Stop', sequence: 1,
  });
  assert.equal((await req('POST', '/api/school/transport/assignments', tm, {
    student_id: P.e3, route_id: P.route, stop_id: stopB.data.stop.id,
  })).status, 400);

  const manifest = await req('GET', `/api/school/transport/manifest?route_id=${P.route}&date=${TODAY}`, tm);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.data.manifest.total, 2);
  assert.equal(manifest.data.manifest.stops[0].stop_name, 'Main Chowk');
  assert.equal(manifest.data.manifest.stops[0].students[0].name, 'Exam One');
  const marked = await req('POST', '/api/school/transport/manifest/mark', tm, {
    date: TODAY,
    entries: [
      { assignment_id: P.assign1, status: 'present' },
      { assignment_id: P.assign2, status: 'absent' },
    ],
  });
  assert.equal(marked.status, 201);
  const after = await req('GET', `/api/school/transport/manifest?route_id=${P.route}&date=${TODAY}`, tm);
  assert.equal(after.data.manifest.marked, 2);
  assert.equal(after.data.manifest.stops[0].students[0].status, 'present');

  // Parents see only their own child's assignment.
  const pList = await req('GET', '/api/school/transport/assignments', P.parent);
  assert.equal(pList.data.assignments.length, 1);
  assert.equal(pList.data.assignments[0].route_name, 'Route A');
  assert.equal(pList.data.assignments[0].stop_name, 'Main Chowk');
  // Teachers have no transport access at all.
  assert.equal((await req('GET', '/api/school/transport/vehicles', P.t1)).status, 403);

  // The parent portal now shows the transport assignment.
  const portal = await req('GET', '/api/school/portal/me', P.parent);
  assert.equal(portal.data.portal.transport.route_name, 'Route A');
  assert.equal(portal.data.portal.transport.driver_name, 'Driver Dan');
});

test('phase6: library — copies, issue/return, overdue fine reporting', async () => {
  const P = ctx.px;
  const libUser = await req('POST', '/api/school/users', P.admin, {
    name: 'Librarian', email: 'lib@phase.test', password: 'password123', role: 'librarian',
  });
  assert.equal(libUser.status, 201);
  const lib = await loginAs('phase-school', 'lib@phase.test');
  P.lib = lib;

  const book = await req('POST', '/api/school/library/books', lib, {
    title: 'Science Book', author: 'A. Writer', isbn: 'ISBN-1', copies_total: 2,
  });
  assert.equal(book.status, 201);
  P.book = book.data.book.id;
  assert.equal(book.data.book.copies_available, 2);
  // Teachers cannot add books.
  assert.equal((await req('POST', '/api/school/library/books', P.t1, { title: 'X' })).status, 403);

  const loan1 = await req('POST', '/api/school/library/loans', lib, {
    book_id: P.book, student_id: P.e1,
  });
  assert.equal(loan1.status, 201);
  P.loan1 = loan1.data.loan.id;
  const loan2 = await req('POST', '/api/school/library/loans', lib, {
    book_id: P.book, student_id: P.e2,
  });
  assert.equal(loan2.status, 201);
  const booksNow = await req('GET', '/api/school/library/books', lib);
  assert.equal(booksNow.data.books.find((b) => b.id === P.book).copies_available, 0);
  // No copies left -> 409.
  assert.equal((await req('POST', '/api/school/library/loans', lib, {
    book_id: P.book, student_id: P.e1,
  })).status, 409);

  // An overdue loan: due yesterday, returned today -> late + fine.
  const book2 = await req('POST', '/api/school/library/books', lib, {
    title: 'History Book', copies_total: 1,
  });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const loan3 = await req('POST', '/api/school/library/loans', lib, {
    book_id: book2.data.book.id, student_id: P.e1, due_on: yesterday,
  });
  assert.equal(loan3.status, 201);
  const overdue = await req('GET', '/api/school/library/loans?overdue=true', lib);
  assert.ok(overdue.data.loans.some((l) => l.id === loan3.data.loan.id && l.days_overdue >= 1));
  const ret3 = await req('POST', `/api/school/library/loans/${loan3.data.loan.id}/return`, lib, {});
  assert.equal(ret3.status, 200);
  assert.ok(ret3.data.days_late >= 1);
  assert.equal(ret3.data.fine, ret3.data.days_late * 10);

  const ret1 = await req('POST', `/api/school/library/loans/${P.loan1}/return`, lib, {});
  assert.equal(ret1.status, 200);
  assert.equal(ret1.data.days_late, 0);
  assert.equal((await req('POST', `/api/school/library/loans/${P.loan1}/return`, lib, {})).status, 409);
  const booksAfter = await req('GET', '/api/school/library/books', lib);
  assert.equal(booksAfter.data.books.find((b) => b.id === P.book).copies_available, 1);

  // Parents see only their own child's loans.
  const pLoans = await req('GET', '/api/school/library/loans', P.parent);
  assert.ok(pLoans.data.loans.length >= 2);
  assert.ok(pLoans.data.loans.every((l) => l.student_id === P.e1));
});

test('phase6: inventory — movements drive quantity and condition', async () => {
  const P = ctx.px;
  const cat = await req('POST', '/api/school/inventory/categories', P.admin, { name: 'Furniture' });
  assert.equal(cat.status, 201);
  const desk = await req('POST', '/api/school/inventory/items', P.admin, {
    name: 'Desk', category_id: cat.data.category.id, sku: 'DSK-1',
    quantity: 10, min_stock: 3, unit_cost: 5000,
  });
  assert.equal(desk.status, 201);
  P.desk = desk.data.item.id;
  assert.equal(desk.data.item.low_stock, false);
  const chair = await req('POST', '/api/school/inventory/items', P.admin, {
    name: 'Chair', quantity: 2, min_stock: 5,
  });
  assert.equal(chair.data.item.low_stock, true);

  const move = (body) => req('POST', `/api/school/inventory/items/${P.desk}/movements`, P.admin, body);
  let r = await move({ movement_type: 'out', quantity: 4 });
  assert.equal(r.data.item.quantity, 6);
  assert.equal((await move({ movement_type: 'out', quantity: 7 })).status, 400);
  r = await move({ movement_type: 'damage', quantity: 2, condition_after: 'damaged' });
  assert.deepEqual([r.data.item.quantity, r.data.item.condition], [4, 'damaged']);
  r = await move({ movement_type: 'repair', quantity: 0, condition_after: 'good' });
  assert.deepEqual([r.data.item.quantity, r.data.item.condition], [4, 'good']);
  r = await move({ movement_type: 'adjust', quantity: 20, note: 'Stock take' });
  assert.equal(r.data.item.quantity, 20);
  r = await move({ movement_type: 'in', quantity: 5 });
  assert.equal(r.data.item.quantity, 25);

  const moves = await req('GET', `/api/school/inventory/movements?item_id=${P.desk}`, P.admin);
  assert.equal(moves.data.movements.length, 6); // opening + out + damage + repair + adjust + in
  const low = await req('GET', '/api/school/inventory/items?low_stock=true', P.admin);
  assert.ok(low.data.items.some((i) => i.name === 'Chair'));
  assert.ok(!low.data.items.some((i) => i.name === 'Desk'));
  // Quantity cannot be PATCHed directly — movements only.
  assert.equal((await req('PATCH', `/api/school/inventory/items/${P.desk}`, P.admin, { quantity: 99 })).status, 400);
});

test('phase7: leave requests — self-service, HR decision, locks', async () => {
  const P = ctx.px;
  const prof = await req('POST', '/api/school/staff', P.admin, {
    user_id: P.t1Id, full_name: 'Phase Teacher One', designation: 'Teacher',
    salary_basic: 50000, salary_allowances: { transport: 5000, house: 10000 },
  });
  assert.equal(prof.status, 201);
  P.t1Profile = prof.data.staff_member.id;
  const peon = await req('POST', '/api/school/staff', P.admin, {
    full_name: 'Peon Pete', designation: 'Peon', salary_basic: 30000, salary_allowances: {},
  });
  assert.equal(peon.status, 201);
  P.peonProfile = peon.data.staff_member.id;

  const hrUser = await req('POST', '/api/school/users', P.admin, {
    name: 'HR Manager', email: 'hr@phase.test', password: 'password123', role: 'hr_manager',
  });
  assert.equal(hrUser.status, 201);
  const hr = await loginAs('phase-school', 'hr@phase.test');
  P.hr = hr;

  // Teacher requests leave for themself; the profile link is automatic.
  const lv = await req('POST', '/api/school/hr/leaves', P.t1, {
    leave_type: 'sick', from_date: '2026-11-10', to_date: '2026-11-11', reason: 'Flu',
  });
  assert.equal(lv.status, 201);
  assert.equal(lv.data.leave.staff_profile_id, P.t1Profile);
  assert.equal(lv.data.leave.status, 'pending');
  // A teacher cannot decide leave (no hr:write).
  assert.equal((await req('POST', `/api/school/hr/leaves/${lv.data.leave.id}/decide`, P.t1, {
    status: 'approved',
  })).status, 403);
  const decided = await req('POST', `/api/school/hr/leaves/${lv.data.leave.id}/decide`, hr, {
    status: 'approved', note: 'Get well',
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.leave.status, 'approved');
  // Decided leaves are locked.
  assert.equal((await req('POST', `/api/school/hr/leaves/${lv.data.leave.id}/decide`, hr, {
    status: 'rejected',
  })).status, 409);

  // HR creates for a profile without a login; teacher cancels own pending.
  const lv2 = await req('POST', '/api/school/hr/leaves', hr, {
    staff_profile_id: P.peonProfile, leave_type: 'casual',
    from_date: '2026-11-12', to_date: '2026-11-12',
  });
  assert.equal(lv2.status, 201);
  const lv3 = await req('POST', '/api/school/hr/leaves', P.t1, {
    leave_type: 'casual', from_date: '2026-11-20', to_date: '2026-11-20',
  });
  const cancelled = await req('POST', `/api/school/hr/leaves/${lv3.data.leave.id}/cancel`, P.t1, {});
  assert.equal(cancelled.data.leave.status, 'cancelled');

  // The teacher's own list never shows the peon's request.
  const own = await req('GET', '/api/school/hr/leaves', P.t1);
  assert.equal(own.data.leaves.length, 2);
  assert.ok(own.data.leaves.every((l) => l.staff_profile_id === P.t1Profile));
  const all = await req('GET', '/api/school/hr/leaves', hr);
  assert.equal(all.data.leaves.length, 3);
});

test('phase7: payroll — generate from salary structures, deductions, finalize locks', async () => {
  const P = ctx.px;
  const run = await req('POST', '/api/school/hr/payroll/runs', P.admin, { month: '2026-11' });
  assert.equal(run.status, 201);
  P.run = run.data.run.id;
  assert.equal((await req('POST', '/api/school/hr/payroll/runs', P.admin, { month: '2026-11' })).status, 409);
  // Cannot finalize an empty run.
  assert.equal((await req('POST', `/api/school/hr/payroll/runs/${P.run}/finalize`, P.admin, {})).status, 400);

  const gen = await req('POST', `/api/school/hr/payroll/runs/${P.run}/generate`, P.admin, {});
  assert.equal(gen.status, 201);
  assert.equal(gen.data.generated, 2); // teacher profile + peon profile
  assert.equal(gen.data.total_net, 95000); // 65000 + 30000

  const items = await req('GET', `/api/school/hr/payroll/runs/${P.run}/items`, P.admin);
  const t1Item = items.data.items.find((i) => i.staff_profile_id === P.t1Profile);
  assert.deepEqual([t1Item.basic, t1Item.allowances_total, t1Item.net], [50000, 15000, 65000]);
  P.t1Item = t1Item.id;
  const peonItem = items.data.items.find((i) => i.staff_profile_id === P.peonProfile);
  assert.equal(peonItem.net, 30000);

  const patched = await req('PATCH', `/api/school/hr/payroll/items/${P.t1Item}`, P.admin, {
    deductions: 5000,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.item.net, 60000);

  const slip = await reqText(`/api/school/hr/payroll/payslip/${P.t1Item}`, P.admin);
  assert.equal(slip.status, 200);
  assert.match(slip.text, /Phase Teacher One/);
  assert.match(slip.text, /Rs 60,000/);

  const fin = await req('POST', `/api/school/hr/payroll/runs/${P.run}/finalize`, P.admin, {});
  assert.equal(fin.status, 200);
  assert.equal(fin.data.run.status, 'finalized');
  // A finalized run is locked.
  assert.equal((await req('POST', `/api/school/hr/payroll/runs/${P.run}/generate`, P.admin, {})).status, 409);
  assert.equal((await req('PATCH', `/api/school/hr/payroll/items/${P.t1Item}`, P.admin, { deductions: 1 })).status, 409);
  assert.equal((await req('POST', `/api/school/hr/payroll/runs/${P.run}/finalize`, P.admin, {})).status, 409);
});

test('phase8: analytics overview and class analytics match the seeded records', async () => {
  const P = ctx.px;
  const r = await req('GET', '/api/school/analytics/overview', P.admin);
  assert.equal(r.status, 200);
  const a = r.data.analytics;
  assert.equal(a.enrollment.active_students, 3);
  assert.equal(a.enrollment.by_class.find((c) => c.class_name === 'Phase 1').students, 2);
  assert.equal(a.enrollment.by_class.find((c) => c.class_name === 'Phase 2').students, 1);
  // Only one payment exists in this school: Exam One's 500 against
  // 2 x 2000 of Phase 1 charges.
  assert.deepEqual(
    [a.fees.collected_total, a.fees.outstanding, a.fees.collection_rate_pct, a.fees.defaulters],
    [500, 3500, 12.5, 0]
  );
  const todayRow = a.attendance.trend[a.attendance.trend.length - 1];
  assert.equal(todayRow.date, TODAY);
  assert.equal(todayRow.pct, 50); // 1 present, 1 absent marked today
  // Teachers have no analytics access.
  assert.equal((await req('GET', '/api/school/analytics/overview', P.t1)).status, 403);

  const ca = await req('GET', `/api/school/analytics/class/${P.class1}`, P.admin);
  assert.equal(ca.status, 200);
  assert.equal(ca.data.class_analytics.strength, 2);
  assert.deepEqual(
    [ca.data.class_analytics.fees.charged, ca.data.class_analytics.fees.paid, ca.data.class_analytics.fees.pending],
    [4000, 500, 3500]
  );
  // (83.33 + 63.33) / 2 = 73.33
  assert.equal(ca.data.class_analytics.exams.average_pct, 73.33);
  assert.equal(ca.data.class_analytics.homework.assigned, 3);
});

test('phase8: report centre CSVs and the audit log', async () => {
  const P = ctx.px;
  const idx = await req('GET', '/api/school/reports', P.admin);
  assert.equal(idx.status, 200);
  assert.ok(idx.data.reports.length >= 8);

  const students = await reqText('/api/school/reports/students.csv', P.admin);
  assert.match(students.text, /Exam One/);
  assert.match(students.text, /Exam Three/);
  const fees = await reqText('/api/school/reports/fees.csv', P.admin);
  assert.match(fees.text, /Exam One/);
  assert.match(fees.text, /1500/);
  const examCsv = await reqText(`/api/school/reports/exam-results.csv?term_id=${P.term}&class_id=${P.class1}`, P.admin);
  assert.match(examCsv.text, /83\.33/);
  const payrollCsv = await reqText(`/api/school/reports/payroll.csv?run_id=${P.run}`, P.admin);
  assert.match(payrollCsv.text, /Phase Teacher One/);
  assert.match(payrollCsv.text, /60000/);
  const transportCsv = await reqText('/api/school/reports/transport.csv', P.admin);
  assert.match(transportCsv.text, /Route A/);
  const attCsv = await reqText(`/api/school/reports/attendance.csv?month=${MONTH}`, P.admin);
  assert.match(attCsv.text, /present/);

  // Audit: the key writes from this school's tests are all logged.
  const audit = await req('GET', '/api/school/reports/audit', P.admin);
  assert.equal(audit.status, 200);
  const actions = audit.data.audit_log.map((x) => x.action);
  for (const expected of ['student.create', 'user.create', 'fee.payment', 'exam_results.publish', 'payroll.finalize']) {
    assert.ok(actions.includes(expected), `audit log is missing ${expected}`);
  }
  const feeOnly = await req('GET', '/api/school/reports/audit?action=fee.payment', P.admin);
  assert.ok(feeOnly.data.audit_log.length >= 1);
  assert.ok(feeOnly.data.audit_log.every((x) => x.action === 'fee.payment'));
  assert.equal(feeOnly.data.audit_log[0].meta.amount, 500);

  // The subscription payment on school C (Phase 1) was audited too.
  const auditCsv = await reqText('/api/school/reports/audit.csv', P.admin);
  assert.equal(auditCsv.status, 200);
  assert.match(auditCsv.text, /fee\.payment/);

  // Accountant: exports yes, audit log no.
  const accUser = await req('POST', '/api/school/users', P.admin, {
    name: 'Phase Accountant', email: 'acc@phase.test', password: 'password123', role: 'accountant',
  });
  assert.equal(accUser.status, 201);
  const acc = await loginAs('phase-school', 'acc@phase.test');
  assert.equal((await reqText('/api/school/reports/fees.csv', acc)).status, 200);
  assert.equal((await req('GET', '/api/school/reports/audit', acc)).status, 403);
});

test('phase8: tenant isolation on all Phase 4-8 tables (API + RLS)', async () => {
  const P = ctx.px;
  // API layer: school B sees none of the phase school's data.
  assert.equal((await req('GET', '/api/school/exams/terms', ctx.adminB)).data.terms.length, 0);
  assert.equal((await req('GET', `/api/school/exams/${P.mathExam}/marks`, ctx.adminB)).status, 404);
  assert.equal((await req('GET', '/api/school/homework', ctx.adminB)).data.homework.length, 0);
  assert.equal((await req('GET', '/api/school/transport/routes', ctx.adminB)).data.routes.length, 0);
  assert.equal((await req('GET', '/api/school/library/books', ctx.adminB)).data.books.length, 0);
  assert.equal((await req('GET', '/api/school/inventory/items', ctx.adminB)).data.items.length, 0);
  assert.equal((await req('GET', '/api/school/hr/payroll/runs', ctx.adminB)).data.runs.length, 0);
  assert.equal((await req('GET', `/api/school/reports/audit`, ctx.adminB)).status, 200);
  const auditB = await req('GET', '/api/school/reports/audit', ctx.adminB);
  assert.ok(!auditB.data.audit_log.some((x) => x.entity_id === P.e1));

  // DB layer (RLS) on every new table.
  const rlsPool = new Pool({
    connectionString: `postgres://${RLS_USER}:${RLS_PASS}@127.0.0.1:5432/school_saas_test`,
  });
  try {
    const cP = await rlsPool.connect();
    try {
      await cP.query('BEGIN');
      await cP.query('SELECT set_config($1, $2, true)', ['app.tenant_id', P.schoolId]);
      for (const table of [
        'exam_terms', 'grade_bands', 'exams', 'exam_marks',
        'homework', 'homework_submissions', 'timetable_slots',
        'transport_vehicles', 'transport_routes', 'transport_stops',
        'transport_assignments', 'transport_attendance',
        'library_books', 'library_loans',
        'inventory_categories', 'inventory_items', 'inventory_movements',
        'leave_requests', 'payroll_runs', 'payroll_items', 'audit_log',
      ]) {
        const r = await cP.query(`SELECT school_id FROM ${table}`);
        assert.ok(r.rows.every((row) => row.school_id === P.schoolId), `${table} leaks across tenants`);
      }
      const cross = await cP.query('SELECT id FROM exams WHERE id = $1 AND school_id = $2', [P.mathExam, ctx.schoolB.id]);
      assert.equal(cross.rows.length, 0);
      await cP.query('ROLLBACK');
    } finally {
      cP.release();
    }
    const c0 = await rlsPool.connect();
    try {
      const r = await c0.query('SELECT id FROM exams');
      assert.equal(r.rows.length, 0);
      const r2 = await c0.query('SELECT id FROM audit_log');
      assert.equal(r2.rows.length, 0);
    } finally {
      c0.release();
    }
  } finally {
    await rlsPool.end();
  }
});
