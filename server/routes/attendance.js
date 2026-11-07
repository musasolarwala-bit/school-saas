'use strict';

// School Manager SaaS — attendance routes (Phase 3 completion).
// Statuses are full words: present / absent / late / half_day / leave
// (the legacy single letters P/A/L/T/H are still accepted as input
// aliases; Leave — and only Leave — is excluded from the %).
//   pct = (present + 0.5 * half_day) / (present + absent + late + half_day)
// Visibility (all scoped to the caller's school):
//   school_admin / school_owner -> every class of their school.
//   principal      -> read-only monitoring of every class.
//   teacher        -> only classes assigned to them (class teacher or
//                     subject teacher, lib/scope.js).
//   parent/student -> only their own linked student, via /summary.
// Marking needs the attendance:write capability (school_admin,
// school_owner, teacher) — corrections go through an admin/owner
// re-mark; the principal stays read-only per the Phase 1 matrix.
// Endpoints: POST / (one student), POST /bulk (whole class sheet in
// one transaction), GET / (class-day sheet), GET /summary,
// GET /student-report (date range), GET /class-monthly,
// GET /export.csv (class monthly sheet as CSV).
// Marking 'present' or 'absent' creates in-app notifications for the
// student's linked parent accounts (lib/notify.js) — on a fresh mark
// or a status change, never on an unchanged re-mark.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { teacherClassIds, linkedStudentId } = require('../lib/scope');
const { notifyParentsOfAttendance } = require('../lib/notify');
const { toCsv } = require('../lib/csv');
const { isUuid, isDateStr, isMonthStr } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

const ATT_COLS = 'a.id, a.school_id, a.student_id, a.class_id, a.date, a.status, a.marked_by, a.created_at, a.updated_at';
const INSERT_COLS = 'id, school_id, student_id, class_id, date, status, marked_by, created_at, updated_at';
const STATUSES = ['present', 'absent', 'late', 'half_day', 'leave'];
const ALIASES = { P: 'present', A: 'absent', L: 'leave', T: 'late', H: 'half_day' };
const SHEET_ROLES = ['school_admin', 'school_owner', 'teacher', 'principal'];

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Accepts a status word or a legacy letter; returns the word or null.
function normalizeStatus(v) {
  if (typeof v !== 'string') return null;
  if (STATUSES.includes(v)) return v;
  return ALIASES[v] || null;
}

function pctOf(counts) {
  const counted = counts.present + counts.absent + counts.late + counts.half_day;
  if (counted === 0) return null;
  const attended = counts.present + counts.half_day * 0.5;
  return Math.round((attended / counted) * 1000) / 10;
}

function emptyCounts() {
  return { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
}

// Student row of this school, or null. Throws 403 when a teacher
// tries to touch a student outside their assigned classes.
async function visibleStudent(client, req, studentId) {
  const { rows } = await client.query(
    'SELECT s.id, s.class_id, s.name FROM students s WHERE s.id = $1 AND s.school_id = $2',
    [studentId, req.schoolId]
  );
  if (rows.length === 0) return null;
  if (req.user.role === 'teacher') {
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    if (!ids.includes(rows[0].class_id)) {
      throw bad('Student is not in one of your classes', 403);
    }
  }
  return rows[0];
}

async function assertSheetAccess(client, req, classId) {
  const cls = await client.query(
    'SELECT id FROM classes WHERE id = $1 AND school_id = $2',
    [classId, req.schoolId]
  );
  if (cls.rows.length === 0) throw bad('Class not found', 404);
  if (req.user.role === 'teacher') {
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    if (!ids.includes(classId)) throw bad('Class is not assigned to you', 403);
  }
}

async function upsertMark(client, req, student, date, status) {
  const prev = await client.query(
    'SELECT status FROM attendance WHERE school_id = $1 AND student_id = $2 AND date = $3',
    [req.schoolId, student.id, date]
  );
  const previous = prev.rows.length > 0 ? prev.rows[0].status : null;
  const { rows } = await client.query(
    `INSERT INTO attendance (school_id, student_id, class_id, date, status, marked_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (school_id, student_id, date)
     DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by,
       class_id = EXCLUDED.class_id, updated_at = now()
     RETURNING ${INSERT_COLS}`,
    [req.schoolId, student.id, student.class_id, date, status, req.user.sub]
  );
  if (previous !== status) {
    await notifyParentsOfAttendance(client, req.schoolId, student, date, status);
  }
  return rows[0];
}

// POST /api/school/attendance — mark (or re-mark) one student's day.
router.post('/', requireCapability('attendance:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.student_id)) throw bad('student_id must be a UUID', 400);
  if (!isDateStr(b.date)) throw bad('date must be YYYY-MM-DD', 400);
  const status = normalizeStatus(b.status);
  if (!status) throw bad(`status must be one of ${STATUSES.join(', ')}`, 400);
  const student = await visibleStudent(client, req, b.student_id);
  if (!student) throw bad('Student not found', 404);
  const row = await upsertMark(client, req, student, b.date, status);
  return { attendance: row };
}, 201));

// POST /api/school/attendance/bulk — a whole class sheet in ONE
// transaction: { class_id, date, entries: [{ student_id, status }] }.
// Every entry's student must belong to the class.
router.post('/bulk', requireCapability('attendance:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!isDateStr(b.date)) throw bad('date must be YYYY-MM-DD', 400);
  if (!Array.isArray(b.entries) || b.entries.length === 0) {
    throw bad('entries must be a non-empty array', 400);
  }
  await assertSheetAccess(client, req, b.class_id);
  const classStudents = await client.query(
    'SELECT id, name FROM students WHERE school_id = $1 AND class_id = $2',
    [req.schoolId, b.class_id]
  );
  const byId = new Map(classStudents.rows.map((s) => [s.id, s]));
  const out = [];
  for (const e of b.entries) {
    if (!e || !isUuid(e.student_id)) throw bad('every entry needs a student_id', 400);
    const student = byId.get(e.student_id);
    if (!student) throw bad('An entry student does not belong to this class', 400);
    const status = normalizeStatus(e.status);
    if (!status) throw bad(`status must be one of ${STATUSES.join(', ')}`, 400);
    out.push(await upsertMark(client, req, { id: student.id, class_id: b.class_id, name: student.name }, b.date, status));
  }
  return { marked: out.length, attendance: out };
}, 201));

// GET /api/school/attendance?class_id=&date= — one class-day sheet.
router.get('/', withSchoolDb(async (req, client) => {
  if (!SHEET_ROLES.includes(req.user.role)) throw bad('Forbidden for this role', 403);
  if (!isUuid(req.query.class_id)) throw bad('class_id is required', 400);
  if (!isDateStr(req.query.date)) throw bad('date must be YYYY-MM-DD', 400);
  await assertSheetAccess(client, req, req.query.class_id);
  const { rows } = await client.query(
    `SELECT ${ATT_COLS}, s.name AS student_name, s.section, s.roll_no
     FROM attendance a JOIN students s ON s.id = a.student_id
     WHERE a.school_id = $1 AND a.class_id = $2 AND a.date = $3
     ORDER BY s.section, s.roll_no`,
    [req.schoolId, req.query.class_id, req.query.date]
  );
  return { attendance: rows };
}));

async function studentCounts(client, req, studentId, whereClause, params) {
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM attendance
     WHERE school_id = $1 AND student_id = $2 AND ${whereClause}
     GROUP BY status`,
    [req.schoolId, studentId, ...params]
  );
  const counts = emptyCounts();
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

async function assertStudentReadable(client, req, studentId) {
  if (req.user.role === 'parent' || req.user.role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (linked !== studentId) throw bad('Student not found', 404);
    return;
  }
  const student = await visibleStudent(client, req, studentId);
  if (!student) throw bad('Student not found', 404);
}

// GET /api/school/attendance/summary?student_id=&month=YYYY-MM
router.get('/summary', withSchoolDb(async (req, client) => {
  if (![...SHEET_ROLES, 'parent', 'student'].includes(req.user.role)) {
    throw bad('Forbidden for this role', 403);
  }
  if (!isUuid(req.query.student_id)) throw bad('student_id is required', 400);
  if (!isMonthStr(req.query.month)) throw bad('month must be YYYY-MM', 400);
  await assertStudentReadable(client, req, req.query.student_id);
  const counts = await studentCounts(
    client, req, req.query.student_id, "to_char(date, 'YYYY-MM') = $3", [req.query.month]
  );
  return {
    summary: {
      student_id: req.query.student_id,
      month: req.query.month,
      ...counts,
      pct: pctOf(counts),
    },
  };
}));

// GET /api/school/attendance/student-report?student_id=&from=&to=
router.get('/student-report', withSchoolDb(async (req, client) => {
  if (![...SHEET_ROLES, 'parent', 'student'].includes(req.user.role)) {
    throw bad('Forbidden for this role', 403);
  }
  if (!isUuid(req.query.student_id)) throw bad('student_id is required', 400);
  if (!isDateStr(req.query.from) || !isDateStr(req.query.to)) {
    throw bad('from and to must be YYYY-MM-DD', 400);
  }
  await assertStudentReadable(client, req, req.query.student_id);
  const counts = await studentCounts(
    client, req, req.query.student_id, 'date >= $3 AND date <= $4', [req.query.from, req.query.to]
  );
  return {
    report: {
      student_id: req.query.student_id,
      from: req.query.from,
      to: req.query.to,
      ...counts,
      pct: pctOf(counts),
    },
  };
}));

// Shared by /class-monthly and /export.csv.
async function classMonthly(client, req, classId, month) {
  await assertSheetAccess(client, req, classId);
  const students = await client.query(
    `SELECT id, name, section, roll_no FROM students
     WHERE school_id = $1 AND class_id = $2 ORDER BY section, roll_no`,
    [req.schoolId, classId]
  );
  const marks = await client.query(
    `SELECT student_id, status, COUNT(*)::int AS n FROM attendance
     WHERE school_id = $1 AND class_id = $2 AND to_char(date, 'YYYY-MM') = $3
     GROUP BY student_id, status`,
    [req.schoolId, classId, month]
  );
  const byStudent = new Map();
  for (const m of marks.rows) {
    if (!byStudent.has(m.student_id)) byStudent.set(m.student_id, emptyCounts());
    byStudent.get(m.student_id)[m.status] = m.n;
  }
  return students.rows.map((s) => {
    const counts = byStudent.get(s.id) || emptyCounts();
    return {
      student_id: s.id, student_name: s.name, section: s.section, roll_no: s.roll_no,
      ...counts, pct: pctOf(counts),
    };
  });
}

// GET /api/school/attendance/class-monthly?class_id=&month=YYYY-MM
router.get('/class-monthly', withSchoolDb(async (req, client) => {
  if (!SHEET_ROLES.includes(req.user.role)) throw bad('Forbidden for this role', 403);
  if (!isUuid(req.query.class_id)) throw bad('class_id is required', 400);
  if (!isMonthStr(req.query.month)) throw bad('month must be YYYY-MM', 400);
  const rows = await classMonthly(client, req, req.query.class_id, req.query.month);
  return { month: req.query.month, class_id: req.query.class_id, students: rows };
}));

// GET /api/school/attendance/export.csv?class_id=&month=YYYY-MM
router.get('/export.csv', withSchoolDb(async (req, client) => {
  if (!SHEET_ROLES.includes(req.user.role)) throw bad('Forbidden for this role', 403);
  if (!isUuid(req.query.class_id)) throw bad('class_id is required', 400);
  if (!isMonthStr(req.query.month)) throw bad('month must be YYYY-MM', 400);
  const rows = await classMonthly(client, req, req.query.class_id, req.query.month);
  const csv = toCsv(
    ['student', 'section', 'roll_no', 'present', 'absent', 'late', 'half_day', 'leave', 'attendance_pct'],
    rows.map((r) => [
      r.student_name, r.section, r.roll_no, r.present, r.absent, r.late,
      r.half_day, r.leave, r.pct === null ? '' : r.pct,
    ])
  );
  const res = req.res;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
  res.send(csv);
  return undefined;
}));

module.exports = router;
