'use strict';

// School Manager SaaS — report centre + audit log (Phase 8).
// One place for the school's exports. Every export is CSV (the
// standing decision: CSV opens directly in Excel; no XLSX library is
// bundled) except printable documents (report card, payslip, fee
// receipt) which live in their own modules as HTML.
//   GET /api/school/reports                 index of available reports
//   GET /api/school/reports/students.csv    ?class_id&status
//   GET /api/school/reports/attendance.csv  ?month&class_id
//   GET /api/school/reports/fees.csv        per-student fee summary
//   GET /api/school/reports/exam-results.csv?term_id&class_id
//   GET /api/school/reports/payroll.csv     ?run_id
//   GET /api/school/reports/transport.csv   ?route_id
//   GET /api/school/reports/audit           audit log (JSON, audit:read)
//   GET /api/school/reports/audit.csv       audit log export
// Reports need reports:read (admin, owner, principal, accountant);
// the audit endpoints additionally need audit:read (admin, owner,
// principal) — so the accountant gets exports but not the audit log.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isMonthStr, dateStr } = require('../lib/validate');
const { toCsv } = require('../lib/csv');
const { studentCharges } = require('../lib/fees');
const { getBands, studentTermResult, classPositions } = require('../lib/grades');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('reports:read'));

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendCsv(req, headers, rows) {
  const res = req.res;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(toCsv(headers, rows));
  return undefined;
}

async function schoolRow(client, req, table, id, label) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND school_id = $2`, [id, req.schoolId]
  );
  if (rows.length === 0) throw bad(`${label} not found`, 404);
  return rows[0];
}

router.get('/', withSchoolDb(async () => ({
  reports: [
    { key: 'students', path: '/api/school/reports/students.csv', description: 'Student list (filters: class_id, status)' },
    { key: 'attendance', path: '/api/school/reports/attendance.csv', description: 'Monthly attendance sheet (month=YYYY-MM, optional class_id)' },
    { key: 'fees', path: '/api/school/reports/fees.csv', description: 'Per-student fee summary: charged / paid / pending' },
    { key: 'exam-results', path: '/api/school/reports/exam-results.csv', description: 'Class results for a term (term_id, class_id)' },
    { key: 'payroll', path: '/api/school/reports/payroll.csv', description: 'Payroll run items (run_id)' },
    { key: 'transport', path: '/api/school/reports/transport.csv', description: 'Transport assignments (optional route_id)' },
    { key: 'audit', path: '/api/school/reports/audit', description: 'Audit log JSON (needs audit:read)' },
    { key: 'audit-csv', path: '/api/school/reports/audit.csv', description: 'Audit log CSV (needs audit:read)' },
  ],
})));

router.get('/students.csv', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 's.school_id = $1';
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND s.class_id = $${params.length}`;
  }
  if (req.query.status !== undefined) {
    if (!['active', 'left', 'graduated', 'transferred'].includes(req.query.status)) throw bad('status filter is invalid', 400);
    params.push(req.query.status);
    where += ` AND s.status = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT s.admission_number, s.name, c.name AS class_name, s.section, s.roll_no,
            s.guardian_name, s.guardian_phone, s.status
     FROM students s JOIN classes c ON c.id = s.class_id
     WHERE ${where} ORDER BY c.name, s.section, s.roll_no, s.name`,
    params
  );
  return sendCsv(req,
    ['admission_number', 'name', 'class', 'section', 'roll_no', 'guardian_name', 'guardian_phone', 'status'],
    rows.map((r) => [r.admission_number, r.name, r.class_name, r.section, r.roll_no, r.guardian_name, r.guardian_phone, r.status]));
}));

router.get('/attendance.csv', withSchoolDb(async (req, client) => {
  if (!isMonthStr(req.query.month)) throw bad('month query parameter (YYYY-MM) is required', 400);
  const params = [req.schoolId, req.query.month];
  let where = 'a.school_id = $1 AND to_char(a.date, \'YYYY-MM\') = $2';
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND a.class_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT a.date, s.name AS student_name, s.roll_no, c.name AS class_name, a.status
     FROM attendance a
     JOIN students s ON s.id = a.student_id
     JOIN classes c ON c.id = a.class_id
     WHERE ${where} ORDER BY a.date, c.name, s.roll_no`,
    params
  );
  return sendCsv(req,
    ['date', 'student', 'roll_no', 'class', 'status'],
    rows.map((r) => [dateStr(r.date), r.student_name, r.roll_no, r.class_name, r.status]));
}));

router.get('/fees.csv', withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    `SELECT s.id, s.name, s.roll_no, s.section, c.name AS class_name, s.class_id
     FROM students s JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 AND s.status = 'active' ORDER BY c.name, s.section, s.roll_no`,
    [req.schoolId]
  );
  const out = [];
  for (const s of rows) {
    const ch = await studentCharges(client, req.schoolId, s);
    out.push([s.name, s.class_name, s.section, s.roll_no, ch.total, ch.paid, ch.pending, ch.fine_total]);
  }
  return sendCsv(req,
    ['student', 'class', 'section', 'roll_no', 'charged', 'paid', 'pending', 'fine'],
    out);
}));

router.get('/exam-results.csv', withSchoolDb(async (req, client) => {
  if (!isUuid(req.query.class_id)) throw bad('class_id query parameter is required', 400);
  await schoolRow(client, req, 'classes', req.query.class_id, 'Class');
  let term;
  if (req.query.term_id !== undefined) {
    if (!isUuid(req.query.term_id)) throw bad('term_id must be a UUID', 400);
    term = await schoolRow(client, req, 'exam_terms', req.query.term_id, 'Term');
  } else {
    const t = await client.query(
      'SELECT * FROM exam_terms WHERE school_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.schoolId]
    );
    if (t.rows.length === 0) throw bad('No exam term exists yet', 404);
    term = t.rows[0];
  }
  const bands = await getBands(client, req.schoolId);
  const positions = await classPositions(client, req.schoolId, req.query.class_id, term.id, bands);
  const { rows } = await client.query(
    "SELECT id, name, roll_no, section, class_id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'",
    [req.schoolId, req.query.class_id]
  );
  const out = [];
  for (const st of rows) {
    const r = await studentTermResult(client, req.schoolId, st, term.id, bands);
    const pos = positions.get(st.id);
    out.push([st.name, st.section, st.roll_no, r.obtained, r.total, r.pct, r.grade, r.gpa, pos ? pos.position : '']);
  }
  out.sort((a, b) => (a[8] || 999) - (b[8] || 999));
  return sendCsv(req,
    ['student', 'section', 'roll_no', 'obtained', 'total', 'percentage', 'grade', 'gpa', 'position'],
    out);
}));

router.get('/payroll.csv', withSchoolDb(async (req, client) => {
  if (!isUuid(req.query.run_id)) throw bad('run_id query parameter is required', 400);
  await schoolRow(client, req, 'payroll_runs', req.query.run_id, 'Payroll run');
  const { rows } = await client.query(
    `SELECT sp.full_name, sp.designation, i.basic, i.allowances_total, i.deductions, i.net
     FROM payroll_items i JOIN staff_profiles sp ON sp.id = i.staff_profile_id
     WHERE i.school_id = $1 AND i.run_id = $2 ORDER BY sp.full_name`,
    [req.schoolId, req.query.run_id]
  );
  return sendCsv(req,
    ['staff', 'designation', 'basic', 'allowances', 'deductions', 'net'],
    rows.map((r) => [r.full_name, r.designation, Number(r.basic), Number(r.allowances_total), Number(r.deductions), Number(r.net)]));
}));

router.get('/transport.csv', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'a.school_id = $1';
  if (req.query.route_id !== undefined) {
    if (!isUuid(req.query.route_id)) throw bad('route_id must be a UUID', 400);
    params.push(req.query.route_id);
    where += ` AND a.route_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT s.name AS student_name, c.name AS class_name, s.section, s.roll_no,
            r.name AS route_name, st.stop_name, a.fee_amount, a.status
     FROM transport_assignments a
     JOIN students s ON s.id = a.student_id
     JOIN classes c ON c.id = s.class_id
     JOIN transport_routes r ON r.id = a.route_id
     LEFT JOIN transport_stops st ON st.id = a.stop_id
     WHERE ${where} ORDER BY r.name, st.sequence NULLS LAST, s.name`,
    params
  );
  return sendCsv(req,
    ['student', 'class', 'section', 'roll_no', 'route', 'stop', 'fee_amount', 'status'],
    rows.map((r) => [r.student_name, r.class_name, r.section, r.roll_no, r.route_name, r.stop_name, Number(r.fee_amount), r.status]));
}));

// ---------------- Audit log ----------------

async function auditRows(client, req) {
  const params = [req.schoolId];
  let where = 'a.school_id = $1';
  if (req.query.action !== undefined) {
    params.push(String(req.query.action));
    where += ` AND a.action = $${params.length}`;
  }
  if (req.query.entity_type !== undefined) {
    params.push(String(req.query.entity_type));
    where += ` AND a.entity_type = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.meta, a.created_at,
            a.actor_role, u.name AS actor_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${where} ORDER BY a.created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

router.get('/audit', withSchoolDb(async (req, client) => {
  if (!can(req.user.role, 'audit:read')) throw bad('Forbidden for this role', 403);
  const rows = await auditRows(client, req);
  return { audit_log: rows };
}));

router.get('/audit.csv', withSchoolDb(async (req, client) => {
  if (!can(req.user.role, 'audit:read')) throw bad('Forbidden for this role', 403);
  const rows = await auditRows(client, req);
  return sendCsv(req,
    ['created_at', 'actor', 'actor_role', 'action', 'entity_type', 'entity_id'],
    rows.map((r) => [new Date(r.created_at).toISOString(), r.actor_name || '', r.actor_role || '', r.action, r.entity_type || '', r.entity_id || '']));
}));

module.exports = router;
