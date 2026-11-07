'use strict';

// School Manager SaaS — role-aware dashboard (Phase 2).
// GET /api/school/dashboard — every number is a REAL database figure
// for the caller's school, computed at request time:
//   admin / owner / principal / accountant (and other staff roles):
//     totals (active students, teacher accounts, active staff
//     profiles, classes), today's attendance, today's + this month's
//     fee collection, outstanding fees (charges - discounts -
//     payments, lib/fees.js), this month's expenses, the 5 most
//     recent admissions, upcoming_exams (Phase 4: the next exams
//     from the exams table, exam_date >= today).
//   teacher: their assigned classes with student counts and today's
//     attendance state per class.
//   parent / student: their linked student's record + this month's
//     attendance summary (unchanged behaviour, just packaged here).

const express = require('express');
const { requireAuth, requireSchool, withSchoolDb } = require('../lib/middleware');
const { teacherClassIds, linkedStudentId } = require('../lib/scope');
const { schoolOutstanding } = require('../lib/fees');
const { todayStr, dateStr } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

function emptyCounts() {
  return { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
}

function pctOf(counts) {
  const counted = counts.present + counts.absent + counts.late + counts.half_day;
  if (counted === 0) return null;
  return Math.round(((counts.present + counts.half_day * 0.5) / counted) * 1000) / 10;
}

async function countsFor(client, schoolId, extraWhere, params) {
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM attendance
     WHERE school_id = $1 AND date = CURRENT_DATE ${extraWhere}
     GROUP BY status`,
    [schoolId, ...params]
  );
  const counts = emptyCounts();
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

async function adminDashboard(client, req) {
  const schoolId = req.schoolId;
  const totals = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE school_id = $1 AND status = 'active') AS students,
       (SELECT COUNT(*)::int FROM users WHERE school_id = $1 AND role = 'teacher' AND active = true) AS teachers,
       (SELECT COUNT(*)::int FROM staff_profiles WHERE school_id = $1 AND status = 'active') AS staff,
       (SELECT COUNT(*)::int FROM classes WHERE school_id = $1) AS classes`,
    [schoolId]
  );
  const attendanceToday = await countsFor(client, schoolId, '', []);
  const fees = await client.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE paid_date = CURRENT_DATE), 0) AS today_collection,
       COALESCE(SUM(amount) FILTER (WHERE paid_date >= date_trunc('month', CURRENT_DATE)::date), 0) AS month_collection
     FROM fee_payments WHERE school_id = $1`,
    [schoolId]
  );
  const expenses = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS month_expenses FROM expense_records
     WHERE school_id = $1 AND spent_on >= date_trunc('month', CURRENT_DATE)::date`,
    [schoolId]
  );
  const recent = await client.query(
    `SELECT s.id, s.name, s.admission_number, c.name AS class_name, s.section, s.roll_no, s.created_at
     FROM students s JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 ORDER BY s.created_at DESC, s.id DESC LIMIT 5`,
    [schoolId]
  );
  const upcoming = await upcomingExams(client, schoolId, null);
  return {
    role: req.user.role,
    totals: totals.rows[0],
    attendance_today: { ...attendanceToday, pct: pctOf(attendanceToday) },
    fees: {
      today_collection: Number(fees.rows[0].today_collection),
      month_collection: Number(fees.rows[0].month_collection),
      outstanding: await schoolOutstanding(client, schoolId),
      month_expenses: Number(expenses.rows[0].month_expenses),
    },
    recent_admissions: recent.rows,
    upcoming_exams: upcoming,
  };
}

// Next 5 scheduled exams (exam_date >= today), optionally limited to
// a set of classes (teacher view). Real rows from the Phase 4 exams
// table; [] when nothing is scheduled.
async function upcomingExams(client, schoolId, classIds) {
  const params = [schoolId];
  let where = 'e.school_id = $1 AND e.exam_date >= CURRENT_DATE';
  if (classIds) {
    params.push(classIds);
    where += ` AND e.class_id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await client.query(
    `SELECT e.id, e.name, e.exam_date, e.total_marks, c.name AS class_name, s.name AS subject_name
     FROM exams e
     JOIN classes c ON c.id = e.class_id
     JOIN subjects s ON s.id = e.subject_id
     WHERE ${where} ORDER BY e.exam_date ASC LIMIT 5`,
    params
  );
  return rows.map((r) => ({ ...r, exam_date: dateStr(r.exam_date), total_marks: Number(r.total_marks) }));
}

async function teacherDashboard(client, req) {
  const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
  const classes = [];
  for (const id of ids) {
    const cls = await client.query(
      'SELECT id, name FROM classes WHERE school_id = $1 AND id = $2',
      [req.schoolId, id]
    );
    if (cls.rows.length === 0) continue;
    const n = await client.query(
      "SELECT COUNT(*)::int AS n FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'",
      [req.schoolId, id]
    );
    const counts = await countsFor(client, req.schoolId, 'AND class_id = $2', [id]);
    classes.push({
      id, name: cls.rows[0].name, student_count: n.rows[0].n,
      attendance_today: { ...counts, pct: pctOf(counts) },
    });
  }
  classes.sort((a, b) => a.name.localeCompare(b.name));
  return { role: 'teacher', classes, upcoming_exams: await upcomingExams(client, req.schoolId, ids) };
}

async function linkedDashboard(client, req) {
  const linked = await linkedStudentId(client, req.user);
  if (!linked) return { role: req.user.role, student: null, upcoming_exams: [] };  const { rows } = await client.query(
    `SELECT s.id, s.name, s.admission_number, s.section, s.roll_no, s.status,
            c.name AS class_name
     FROM students s JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 AND s.id = $2`,
    [req.schoolId, linked]
  );
  const month = todayStr().slice(0, 7);
  const att = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM attendance
     WHERE school_id = $1 AND student_id = $2 AND to_char(date, 'YYYY-MM') = $3
     GROUP BY status`,
    [req.schoolId, linked, month]
  );
  const counts = emptyCounts();
  for (const r of att.rows) counts[r.status] = r.n;
  const classId = rows.length > 0 ? await client.query(
    'SELECT class_id FROM students WHERE school_id = $1 AND id = $2', [req.schoolId, linked]
  ) : null;
  return {
    role: req.user.role,
    student: rows.length > 0 ? rows[0] : null,
    attendance_month: { month, ...counts, pct: pctOf(counts) },
    upcoming_exams: classId && classId.rows.length > 0
      ? await upcomingExams(client, req.schoolId, [classId.rows[0].class_id])
      : [],
  };
}

router.get('/', withSchoolDb(async (req, client) => {
  const role = req.user.role;
  if (role === 'teacher') return { dashboard: await teacherDashboard(client, req) };
  if (role === 'parent' || role === 'student') return { dashboard: await linkedDashboard(client, req) };
  return { dashboard: await adminDashboard(client, req) };
}));

module.exports = router;
