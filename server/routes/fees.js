'use strict';

// School Manager SaaS — fees routes (Stage 2, module 2).
// Mirrors the offline app: fee heads (Tuition, Admission, Transport,
// Exam, Library, ...), one plan per (class, head) charging that class,
// partial payments against a plan, overpayment rejected, and a per-
// student summary with total / paid / pending / overdue computed
// server-side (a plan is overdue when its due date has passed and
// money is still owed on it).
// Roles follow the Phase 1 capability matrix (lib/permissions.js):
// fee writes (heads, plans, recording payments) need fees:write —
// school_admin, school_owner, accountant. The principal reads fee
// configuration and summaries but writes nothing. Parent/student may
// read only their own linked child's summary and payments. Teachers,
// hr_manager, transport_manager, librarian and receptionist have no
// fees access at all (403), matching the offline app's Admin-only
// Fees screen for everyone but the money roles.
// Every query is scoped to the caller's school; cross-school ids
// return 404/400 with no existence leak, following the other routes.

const express = require('express');
const { requireAuth, requireSchool, requireRole, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isNonEmptyString, isDateStr, isMonthStr, dateStr } = require('../lib/validate');
const { studentCharges, getFeeSettings } = require('../lib/fees');
const { toCsv } = require('../lib/csv');
const { logAudit } = require('../lib/audit');

const router = express.Router();

router.use(requireAuth, requireSchool);

const HEAD_COLS = 'id, school_id, name, created_at';
const PLAN_COLS = 'p.id, p.school_id, p.class_id, p.fee_head_id, p.amount, p.due_date, p.created_at, h.name AS fee_head_name';
const PAY_COLS = 'id, school_id, student_id, plan_id, amount, method, reference, receipt_no, paid_date, recorded_by, created_at';
const METHODS = ['cash', 'bank_transfer', 'jazzcash', 'easypaisa', 'other'];

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isPositiveAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

// Payment methods are an enum (011). Input is forgiving about case
// and the common 'bank' spelling; anything else is rejected.
function normalizeMethod(v) {
  if (v === undefined || v === null || v === '') return 'cash';
  const m = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (m === 'bank') return 'bank_transfer';
  return METHODS.includes(m) ? m : null;
}

function escHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Student row of this school, or null.
async function schoolStudent(client, req, studentId) {
  const { rows } = await client.query(
    'SELECT id, class_id FROM students WHERE id = $1 AND school_id = $2',
    [studentId, req.schoolId]
  );
  return rows.length > 0 ? rows[0] : null;
}

// Parent/student may only touch their own linked student.
async function assertOwnStudent(client, req, studentId) {
  if (req.user.role !== 'parent' && req.user.role !== 'student') return;
  const { rows } = await client.query(
    'SELECT linked_student_id FROM users WHERE id = $1 AND school_id = $2',
    [req.user.sub, req.schoolId]
  );
  if (rows.length === 0 || rows[0].linked_student_id !== studentId) {
    throw bad('Student not found', 404);
  }
}

// ---- Fee heads (fees:write to change; principal may read) ----

const FEE_CONFIG_READ = requireRole('school_admin', 'school_owner', 'accountant', 'principal');

router.get('/heads', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    `SELECT ${HEAD_COLS} FROM fee_heads WHERE school_id = $1 ORDER BY name ASC`,
    [req.schoolId]
  );
  return { fee_heads: rows };
}));

router.post('/heads', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  try {
    const { rows } = await client.query(
      `INSERT INTO fee_heads (school_id, name) VALUES ($1, $2) RETURNING ${HEAD_COLS}`,
      [req.schoolId, b.name.trim()]
    );
    return { fee_head: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A fee head with that name already exists in this school', 409);
    throw err;
  }
}, 201));

// ---- Fee plans (fees:write to change; principal may read) ----

router.get('/plans', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  if (req.query.class_id !== undefined && !isUuid(req.query.class_id)) {
    throw bad('class_id must be a UUID', 400);
  }
  const params = [req.schoolId];
  let where = 'p.school_id = $1';
  if (req.query.class_id) {
    params.push(req.query.class_id);
    where += ` AND p.class_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${PLAN_COLS} FROM fee_plans p JOIN fee_heads h ON h.id = p.fee_head_id
     WHERE ${where} ORDER BY p.due_date NULLS LAST, h.name ASC`,
    params
  );
  return { fee_plans: rows };
}));

router.post('/plans', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!isUuid(b.fee_head_id)) throw bad('fee_head_id must be a UUID', 400);
  if (!isPositiveAmount(b.amount)) throw bad('amount must be greater than 0', 400);
  if (b.due_date !== undefined && b.due_date !== null && !isDateStr(b.due_date)) {
    throw bad('due_date must be YYYY-MM-DD', 400);
  }
  const cls = await client.query(
    'SELECT id FROM classes WHERE id = $1 AND school_id = $2',
    [b.class_id, req.schoolId]
  );
  if (cls.rows.length === 0) throw bad('Class not found', 404);
  const head = await client.query(
    'SELECT id FROM fee_heads WHERE id = $1 AND school_id = $2',
    [b.fee_head_id, req.schoolId]
  );
  if (head.rows.length === 0) throw bad('Fee head not found', 404);
  try {
    const { rows } = await client.query(
      `INSERT INTO fee_plans (school_id, class_id, fee_head_id, amount, due_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, school_id, class_id, fee_head_id, amount, due_date, created_at`,
      [req.schoolId, b.class_id, b.fee_head_id, b.amount, b.due_date || null]
    );
    return { fee_plan: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A plan for this class and fee head already exists', 409);
    throw err;
  }
}, 201));

// ---- Payments (fees:write to record; fees:read to view) ----

router.get('/payments', withSchoolDb(async (req, client) => {
  if (!isUuid(req.query.student_id)) throw bad('student_id is required', 400);
  if (!can(req.user.role, 'fees:read')) throw bad('Forbidden for this role', 403);
  await assertOwnStudent(client, req, req.query.student_id);
  const student = await schoolStudent(client, req, req.query.student_id);
  if (!student) throw bad('Student not found', 404);
  const { rows } = await client.query(
    `SELECT ${PAY_COLS} FROM fee_payments
     WHERE school_id = $1 AND student_id = $2 ORDER BY paid_date ASC, created_at ASC`,
    [req.schoolId, req.query.student_id]
  );
  return { fee_payments: rows };
}));

router.post('/payments', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.student_id)) throw bad('student_id must be a UUID', 400);
  if (!isUuid(b.plan_id)) throw bad('plan_id must be a UUID', 400);
  if (!isPositiveAmount(b.amount)) throw bad('amount must be greater than 0', 400);
  const method = normalizeMethod(b.method);
  if (!method) throw bad(`method must be one of ${METHODS.join(', ')}`, 400);
  if (b.reference !== undefined && b.reference !== null && !isNonEmptyString(b.reference, 200)) {
    throw bad('reference must be a non-empty string', 400);
  }
  if (b.paid_date !== undefined && b.paid_date !== null && !isDateStr(b.paid_date)) {
    throw bad('paid_date must be YYYY-MM-DD', 400);
  }
  const student = await schoolStudent(client, req, b.student_id);
  if (!student) throw bad('Student not found', 404);
  const planRes = await client.query(
    `SELECT id, class_id, amount FROM fee_plans WHERE id = $1 AND school_id = $2`,
    [b.plan_id, req.schoolId]
  );
  if (planRes.rows.length === 0) throw bad('Fee plan not found', 404);
  const plan = planRes.rows[0];
  if (plan.class_id !== student.class_id) {
    throw bad('Fee plan does not apply to this student\'s class', 400);
  }
  // Overpayment is rejected, exactly as in the offline app — against
  // the DISCOUNTED charge (Phase 3), so a discount lowers what can
  // still be collected on the plan.
  const charges = await studentCharges(client, req.schoolId, student);
  const planCharge = charges.plans.find((p) => p.plan_id === b.plan_id);
  const pending = planCharge ? planCharge.pending : 0;
  if (Number(b.amount) > pending) {
    throw bad(`Amount exceeds pending ${pending}`, 400);
  }
  const countRes = await client.query(
    'SELECT COUNT(*)::int AS n FROM fee_payments WHERE school_id = $1',
    [req.schoolId]
  );
  const receiptNo = 'RCPT-' + String(countRes.rows[0].n + 1).padStart(6, '0');
  const { rows } = await client.query(
    `INSERT INTO fee_payments
       (school_id, student_id, plan_id, amount, method, reference, receipt_no, paid_date, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${PAY_COLS}`,
    [
      req.schoolId, b.student_id, b.plan_id, b.amount,
      method,
      b.reference ? b.reference.trim() : null,
      receiptNo,
      b.paid_date || new Date().toISOString().slice(0, 10),
      req.user.sub,
    ]
  );
  await logAudit(client, req, 'fee.payment', 'fee_payment', rows[0].id, {
    student_id: b.student_id, plan_id: b.plan_id,
    amount: Number(b.amount), receipt_no: receiptNo, method,
  });
  return { fee_payment: rows[0] };
}, 201));

// ---- Per-student summary: total / paid / pending / overdue + per-plan breakdown ----
// Phase 3: computed by lib/fees.js studentCharges so discounts and
// late fines are included. `total` is the sum of CHARGES (plan amount
// minus discount); `overdue` sums pending + fine over overdue plans.

router.get('/summary', withSchoolDb(async (req, client) => {
  if (!isUuid(req.query.student_id)) throw bad('student_id is required', 400);
  if (!can(req.user.role, 'fees:read')) throw bad('Forbidden for this role', 403);
  await assertOwnStudent(client, req, req.query.student_id);
  const student = await schoolStudent(client, req, req.query.student_id);
  if (!student) throw bad('Student not found', 404);
  const charges = await studentCharges(client, req.schoolId, student);
  const plans = charges.plans.map((p) => ({
    plan_id: p.plan_id,
    fee_head_name: p.fee_head_name,
    amount: p.amount,
    discount: p.discount,
    paid: p.paid,
    pending: p.pending,
    due_date: p.due_date,
    overdue: p.overdue,
    fine: p.fine,
  }));
  return {
    summary: {
      student_id: req.query.student_id,
      total: charges.total,
      paid: charges.paid,
      pending: charges.pending,
      overdue: charges.overdue,
      fine_total: charges.fine_total,
      overdue_plan_count: charges.plans.filter((p) => p.overdue).length,
      plans,
    },
  };
}));

// ---- Fee settings: late-fine configuration (Phase 3) ----

router.get('/settings', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  const settings = await getFeeSettings(client, req.schoolId);
  return { settings };
}));

router.put('/settings', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!['none', 'flat', 'per_day'].includes(b.late_fine_type)) {
    throw bad('late_fine_type must be none, flat or per_day', 400);
  }
  const amount = Number(b.late_fine_amount);
  if (!Number.isFinite(amount) || amount < 0) throw bad('late_fine_amount must be a number >= 0', 400);
  const grace = b.late_fine_grace_days === undefined ? 0 : Number(b.late_fine_grace_days);
  if (!Number.isInteger(grace) || grace < 0) throw bad('late_fine_grace_days must be an integer >= 0', 400);
  const { rows } = await client.query(
    `INSERT INTO school_fee_settings (school_id, late_fine_type, late_fine_amount, late_fine_grace_days)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (school_id) DO UPDATE SET
       late_fine_type = EXCLUDED.late_fine_type,
       late_fine_amount = EXCLUDED.late_fine_amount,
       late_fine_grace_days = EXCLUDED.late_fine_grace_days,
       updated_at = now()
     RETURNING late_fine_type, late_fine_amount, late_fine_grace_days`,
    [req.schoolId, b.late_fine_type, amount, grace]
  );
  return {
    settings: {
      late_fine_type: rows[0].late_fine_type,
      late_fine_amount: Number(rows[0].late_fine_amount),
      late_fine_grace_days: rows[0].late_fine_grace_days,
    },
  };
}));

// ---- Student fee discounts (Phase 3) ----

const DISCOUNT_COLS = 'id, school_id, student_id, fee_head_id, discount_type, value, kind, reason, created_by, created_at';

router.get('/discounts', withSchoolDb(async (req, client) => {
  if (!can(req.user.role, 'fees:read')) throw bad('Forbidden for this role', 403);
  if (!isUuid(req.query.student_id)) throw bad('student_id is required', 400);
  await assertOwnStudent(client, req, req.query.student_id);
  const student = await schoolStudent(client, req, req.query.student_id);
  if (!student) throw bad('Student not found', 404);
  const { rows } = await client.query(
    `SELECT ${DISCOUNT_COLS} FROM student_fee_discounts
     WHERE school_id = $1 AND student_id = $2 ORDER BY created_at ASC`,
    [req.schoolId, req.query.student_id]
  );
  return { discounts: rows };
}));

router.post('/discounts', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.student_id)) throw bad('student_id must be a UUID', 400);
  if (b.fee_head_id !== undefined && b.fee_head_id !== null && !isUuid(b.fee_head_id)) {
    throw bad('fee_head_id must be a UUID or null', 400);
  }
  if (!['percent', 'fixed'].includes(b.discount_type)) {
    throw bad('discount_type must be percent or fixed', 400);
  }
  if (!isPositiveAmount(b.value)) throw bad('value must be greater than 0', 400);
  if (b.discount_type === 'percent' && Number(b.value) > 100) {
    throw bad('a percent discount cannot exceed 100', 400);
  }
  if (b.kind !== undefined && !['scholarship', 'sibling', 'concession', 'other'].includes(b.kind)) {
    throw bad('kind must be scholarship, sibling, concession or other', 400);
  }
  const student = await schoolStudent(client, req, b.student_id);
  if (!student) throw bad('Student not found', 404);
  if (b.fee_head_id) {
    const head = await client.query(
      'SELECT id FROM fee_heads WHERE id = $1 AND school_id = $2', [b.fee_head_id, req.schoolId]
    );
    if (head.rows.length === 0) throw bad('Fee head not found', 404);
  }
  const { rows } = await client.query(
    `INSERT INTO student_fee_discounts
       (school_id, student_id, fee_head_id, discount_type, value, kind, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DISCOUNT_COLS}`,
    [
      req.schoolId, b.student_id, b.fee_head_id || null, b.discount_type,
      b.value, b.kind || 'concession', b.reason || null, req.user.sub,
    ]
  );
  return { discount: rows[0] };
}, 201));

router.delete('/discounts/:id', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid discount id', 400);
  const { rows } = await client.query(
    'DELETE FROM student_fee_discounts WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Discount not found', 404);
  return { deleted: true };
}));

// ---- Vouchers: bulk generation for a class + period (Phase 3) ----

router.post('/vouchers/generate', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!isMonthStr(b.period)) throw bad('period must be YYYY-MM', 400);
  if (b.due_date !== undefined && b.due_date !== null && !isDateStr(b.due_date)) {
    throw bad('due_date must be YYYY-MM-DD', 400);
  }
  const cls = await client.query(
    'SELECT id FROM classes WHERE id = $1 AND school_id = $2', [b.class_id, req.schoolId]
  );
  if (cls.rows.length === 0) throw bad('Class not found', 404);
  const settings = await getFeeSettings(client, req.schoolId);
  const students = await client.query(
    "SELECT id, class_id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'",
    [req.schoolId, b.class_id]
  );
  let created = 0;
  let skipped = 0;
  let totalAmount = 0;
  for (const student of students.rows) {
    const charges = await studentCharges(client, req.schoolId, student, settings);
    for (const p of charges.plans) {
      const due = b.due_date || p.due_date;
      const { rowCount } = await client.query(
        `INSERT INTO fee_vouchers
           (school_id, student_id, plan_id, period, amount, discount_amount, fine_amount, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (school_id, student_id, plan_id, period) DO NOTHING`,
        [req.schoolId, student.id, p.plan_id, b.period, p.charge, p.discount, p.fine, due, req.user.sub]
      );
      if (rowCount > 0) {
        created++;
        totalAmount += p.charge + p.fine;
      } else {
        skipped++;
      }
    }
  }
  return { generated: { created, skipped, total_amount: totalAmount, period: b.period, class_id: b.class_id } };
}, 201));

router.get('/vouchers', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'v.school_id = $1';
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND p.class_id = $${params.length}`;
  }
  if (req.query.student_id !== undefined) {
    if (!isUuid(req.query.student_id)) throw bad('student_id must be a UUID', 400);
    params.push(req.query.student_id);
    where += ` AND v.student_id = $${params.length}`;
  }
  if (req.query.period !== undefined) {
    if (!isMonthStr(req.query.period)) throw bad('period must be YYYY-MM', 400);
    params.push(req.query.period);
    where += ` AND v.period = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT v.id, v.school_id, v.student_id, s.name AS student_name, v.plan_id,
            h.name AS fee_head_name, v.period, v.amount, v.discount_amount,
            v.fine_amount, v.due_date, v.created_at
     FROM fee_vouchers v
     JOIN fee_plans p ON p.id = v.plan_id
     JOIN fee_heads h ON h.id = p.fee_head_id
     JOIN students s ON s.id = v.student_id
     WHERE ${where} ORDER BY s.name, h.name`,
    params
  );
  return { vouchers: rows };
}));

// ---- Defaulters: students with overdue pending (Phase 3) ----

async function defaultersList(client, req) {
  const students = await client.query(
    `SELECT s.id, s.name, s.class_id, c.name AS class_name, s.section, s.roll_no
     FROM students s JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 AND s.status = 'active' ORDER BY s.name`,
    [req.schoolId]
  );
  const out = [];
  for (const s of students.rows) {
    const charges = await studentCharges(client, req.schoolId, s);
    const overduePlans = charges.plans.filter((p) => p.overdue);
    if (overduePlans.length === 0) continue;
    out.push({
      student_id: s.id,
      student_name: s.name,
      class_id: s.class_id,
      class_name: s.class_name,
      section: s.section,
      roll_no: s.roll_no,
      total_pending: overduePlans.reduce((a, p) => a + p.pending, 0),
      total_fine: overduePlans.reduce((a, p) => a + p.fine, 0),
      overdue_amount: overduePlans.reduce((a, p) => a + p.pending + p.fine, 0),
      plans: overduePlans.map((p) => ({
        plan_id: p.plan_id, fee_head_name: p.fee_head_name,
        pending: p.pending, fine: p.fine, due_date: p.due_date,
      })),
    });
  }
  out.sort((a, b) => b.overdue_amount - a.overdue_amount);
  return out;
}

router.get('/defaulters', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  return { defaulters: await defaultersList(client, req) };
}));

router.get('/defaulters.csv', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  const list = await defaultersList(client, req);
  const csv = toCsv(
    ['student', 'class', 'section', 'roll_no', 'total_pending', 'total_fine', 'overdue_amount'],
    list.map((d) => [
      d.student_name, d.class_name, d.section, d.roll_no,
      d.total_pending, d.total_fine, d.overdue_amount,
    ])
  );
  const res = req.res;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="defaulters.csv"');
  res.send(csv);
  return undefined;
}));

// ---- Collection reports + CSV (Phase 3) ----

router.get('/reports/collections', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  const groupBy = req.query.group_by || 'month';
  if (!['day', 'month', 'year'].includes(groupBy)) throw bad('group_by must be day, month or year', 400);
  const params = [req.schoolId];
  let where = 'school_id = $1';
  if (req.query.from !== undefined) {
    if (!isDateStr(req.query.from)) throw bad('from must be YYYY-MM-DD', 400);
    params.push(req.query.from);
    where += ` AND paid_date >= $${params.length}`;
  }
  if (req.query.to !== undefined) {
    if (!isDateStr(req.query.to)) throw bad('to must be YYYY-MM-DD', 400);
    params.push(req.query.to);
    where += ` AND paid_date <= $${params.length}`;
  }
  const trunc = groupBy === 'day' ? 'day' : groupBy === 'year' ? 'year' : 'month';
  const { rows } = await client.query(
    `SELECT to_char(date_trunc('${trunc}', paid_date), 'YYYY-MM-DD') AS period,
            COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS payments
     FROM fee_payments WHERE ${where}
     GROUP BY 1 ORDER BY 1 ASC`,
    params
  );
  return {
    collections: rows.map((r) => ({
      period: groupBy === 'year' ? r.period.slice(0, 4) : groupBy === 'month' ? r.period.slice(0, 7) : r.period,
      total: Number(r.total),
      payments: r.payments,
    })),
  };
}));

router.get('/collections.csv', FEE_CONFIG_READ, withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'fp.school_id = $1';
  if (req.query.from !== undefined) {
    if (!isDateStr(req.query.from)) throw bad('from must be YYYY-MM-DD', 400);
    params.push(req.query.from);
    where += ` AND fp.paid_date >= $${params.length}`;
  }
  if (req.query.to !== undefined) {
    if (!isDateStr(req.query.to)) throw bad('to must be YYYY-MM-DD', 400);
    params.push(req.query.to);
    where += ` AND fp.paid_date <= $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT fp.receipt_no, fp.paid_date, s.name AS student_name, c.name AS class_name,
            h.name AS fee_head_name, fp.amount, fp.method, fp.reference
     FROM fee_payments fp
     JOIN students s ON s.id = fp.student_id
     JOIN classes c ON c.id = s.class_id
     JOIN fee_plans p ON p.id = fp.plan_id
     JOIN fee_heads h ON h.id = p.fee_head_id
     WHERE ${where} ORDER BY fp.paid_date ASC, fp.created_at ASC`,
    params
  );
  const csv = toCsv(
    ['receipt_no', 'paid_date', 'student', 'class', 'fee_head', 'amount', 'method', 'reference'],
    rows.map((r) => [
      r.receipt_no, dateStr(r.paid_date), r.student_name, r.class_name,
      r.fee_head_name, r.amount, r.method, r.reference,
    ])
  );
  const res = req.res;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="collections.csv"');
  res.send(csv);
  return undefined;
}));

// ---- Printable HTML receipt for one payment (Phase 3) ----

router.get('/payments/:id/receipt', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid payment id', 400);
  if (!can(req.user.role, 'fees:read')) throw bad('Forbidden for this role', 403);
  const { rows } = await client.query(
    `SELECT fp.*, s.name AS student_name, s.roll_no, s.section,
            c.name AS class_name, h.name AS fee_head_name,
            sc.name AS school_name, sc.display_name AS school_display_name,
            sc.primary_color AS school_color, u.name AS recorded_by_name
     FROM fee_payments fp
     JOIN students s ON s.id = fp.student_id
     JOIN classes c ON c.id = s.class_id
     JOIN fee_plans p ON p.id = fp.plan_id
     JOIN fee_heads h ON h.id = p.fee_head_id
     JOIN schools sc ON sc.id = fp.school_id
     LEFT JOIN users u ON u.id = fp.recorded_by
     WHERE fp.school_id = $1 AND fp.id = $2`,
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Payment not found', 404);
  const pay = rows[0];
  await assertOwnStudent(client, req, pay.student_id);
  const schoolName = pay.school_display_name || pay.school_name;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Receipt ${escHtml(pay.receipt_no)}</title>
<style>body{font-family:system-ui,sans-serif;margin:40px;color:#1F2937}
.head{border-bottom:3px solid ${escHtml(pay.school_color || '#1d6fb8')};padding-bottom:8px;margin-bottom:16px}
table{border-collapse:collapse}td{padding:6px 14px 6px 0;font-size:15px}
.k{color:#6B7280}@media print{button{display:none}}</style></head>
<body>
<div class="head"><h1>${escHtml(schoolName)}</h1><p>Fee Payment Receipt</p></div>
<table>
<tr><td class="k">Receipt No</td><td><strong>${escHtml(pay.receipt_no)}</strong></td></tr>
<tr><td class="k">Date</td><td>${escHtml(dateStr(pay.paid_date))}</td></tr>
<tr><td class="k">Student</td><td>${escHtml(pay.student_name)}</td></tr>
<tr><td class="k">Class</td><td>${escHtml(pay.class_name)} — Section ${escHtml(pay.section)}, Roll ${escHtml(pay.roll_no)}</td></tr>
<tr><td class="k">Fee Head</td><td>${escHtml(pay.fee_head_name)}</td></tr>
<tr><td class="k">Amount</td><td><strong>Rs ${Number(pay.amount).toLocaleString('en-US')}</strong></td></tr>
<tr><td class="k">Method</td><td>${escHtml(pay.method)}${pay.reference ? ' — Ref: ' + escHtml(pay.reference) : ''}</td></tr>
<tr><td class="k">Received By</td><td>${escHtml(pay.recorded_by_name || '')}</td></tr>
</table>
<p><button onclick="window.print()">Print</button></p>
</body></html>`;
  const res = req.res;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
  return undefined;
}));

module.exports = router;
