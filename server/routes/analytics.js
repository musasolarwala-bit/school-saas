'use strict';

// School Manager SaaS — analytics (Phase 8).
// Every number here is an aggregate over the school's REAL tables at
// request time — enrollment, attendance, fee collection, class
// performance. There is no ML model and no prediction anywhere in
// this module: trends are plain historical series, stated as such.
// Roles: analytics:read = school_admin, school_owner, principal.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isUuid, dateStr } = require('../lib/validate');
const { studentCharges, schoolOutstanding } = require('../lib/fees');
const { getBands, studentTermResult } = require('../lib/grades');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('analytics:read'));

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

router.get('/overview', withSchoolDb(async (req, client) => {
  const sid = req.schoolId;

  const byClass = await client.query(
    `SELECT c.id AS class_id, c.name AS class_name, COUNT(s.id)::int AS students
     FROM classes c
     LEFT JOIN students s ON s.class_id = c.id AND s.school_id = c.school_id AND s.status = 'active'
     WHERE c.school_id = $1 GROUP BY c.id, c.name ORDER BY c.name`,
    [sid]
  );
  const totals = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE school_id = $1 AND status = 'active') AS active_students,
       (SELECT COUNT(*)::int FROM students WHERE school_id = $1) AS all_students,
       (SELECT COUNT(*)::int FROM users WHERE school_id = $1 AND role = 'teacher' AND active = true) AS teachers,
       (SELECT COUNT(*)::int FROM staff_profiles WHERE school_id = $1 AND status = 'active') AS active_staff,
       (SELECT COUNT(*)::int FROM classes WHERE school_id = $1) AS classes`,
    [sid]
  );
  const t = totals.rows[0];

  // Enrollment trend: admissions per month, last 6 months (real
  // created_at months; months without admissions report 0).
  const adm = await client.query(
    `SELECT to_char(created_at, 'YYYY-MM') AS month, COUNT(*)::int AS n
     FROM students WHERE school_id = $1
       AND created_at >= date_trunc('month', CURRENT_DATE) - interval '5 months'
     GROUP BY month ORDER BY month`,
    [sid]
  );
  const admMap = new Map(adm.rows.map((r) => [r.month, r.n]));
  const enrollmentTrend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    enrollmentTrend.push({ month: key, admissions: admMap.get(key) || 0 });
  }

  // Attendance trend: last 14 days, per-day status counts + %.
  const att = await client.query(
    `SELECT date, status, COUNT(*)::int AS n FROM attendance
     WHERE school_id = $1 AND date >= CURRENT_DATE - 13
     GROUP BY date, status ORDER BY date`,
    [sid]
  );
  const byDate = new Map();
  for (const r of att.rows) {
    const key = dateStr(r.date);
    if (!byDate.has(key)) byDate.set(key, { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 });
    byDate.get(key)[r.status] = r.n;
  }
  const attendanceTrend = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const c = byDate.get(key) || { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
    const counted = c.present + c.absent + c.late + c.half_day;
    attendanceTrend.push({
      date: key, ...c,
      pct: counted === 0 ? null : round2(((c.present + c.half_day * 0.5) / counted) * 100),
    });
  }

  // Fees: collected (all time + this month), outstanding, and the
  // collection rate = collected / (collected + outstanding).
  const fees = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS collected_total,
            COALESCE(SUM(amount) FILTER (WHERE paid_date >= date_trunc('month', CURRENT_DATE)::date), 0) AS collected_month
     FROM fee_payments WHERE school_id = $1`,
    [sid]
  );
  const collected = Number(fees.rows[0].collected_total);
  const outstanding = await schoolOutstanding(client, sid);
  const denom = collected + outstanding;

  // Defaulters: active students with an overdue pending balance
  // (same per-student math as the fees module).
  const actives = await client.query(
    "SELECT id, class_id FROM students WHERE school_id = $1 AND status = 'active'",
    [sid]
  );
  let defaulters = 0;
  for (const s of actives.rows) {
    const ch = await studentCharges(client, sid, s);
    if (ch.plans.some((p) => p.overdue)) defaulters += 1;
  }

  // Fee collection trend: payments per month, last 6 months.
  const coll = await client.query(
    `SELECT to_char(paid_date, 'YYYY-MM') AS month, COALESCE(SUM(amount), 0) AS total
     FROM fee_payments WHERE school_id = $1
       AND paid_date >= date_trunc('month', CURRENT_DATE)::date - interval '5 months'
     GROUP BY month ORDER BY month`,
    [sid]
  );
  const collMap = new Map(coll.rows.map((r) => [r.month, Number(r.total)]));
  const collectionTrend = enrollmentTrend.map((e) => ({
    month: e.month, collected: collMap.get(e.month) || 0,
  }));

  return {
    analytics: {
      enrollment: {
        active_students: t.active_students,
        all_students: t.all_students,
        teachers: t.teachers,
        active_staff: t.active_staff,
        classes: t.classes,
        teacher_student_ratio: t.teachers > 0 ? round2(t.active_students / t.teachers) : null,
        by_class: byClass.rows,
        trend: enrollmentTrend,
      },
      attendance: { trend: attendanceTrend },
      fees: {
        collected_total: collected,
        collected_this_month: Number(fees.rows[0].collected_month),
        outstanding,
        collection_rate_pct: denom > 0 ? round2((collected / denom) * 100) : null,
        defaulters,
        trend: collectionTrend,
      },
    },
  };
}));

// One class in depth: strength, 30-day attendance, fee position and
// the average result % of the most recent term that has exams for
// the class (null when the class has no exams yet).
router.get('/class/:id', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid class id', 400);
  const cls = await client.query(
    'SELECT id, name FROM classes WHERE school_id = $1 AND id = $2',
    [req.schoolId, req.params.id]
  );
  if (cls.rows.length === 0) throw bad('Class not found', 404);
  const students = await client.query(
    "SELECT id, class_id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'",
    [req.schoolId, req.params.id]
  );
  const att = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM attendance
     WHERE school_id = $1 AND class_id = $2 AND date >= CURRENT_DATE - 29
     GROUP BY status`,
    [req.schoolId, req.params.id]
  );
  const counts = { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
  for (const r of att.rows) counts[r.status] = r.n;
  const counted = counts.present + counts.absent + counts.late + counts.half_day;
  const attPct = counted === 0 ? null
    : round2(((counts.present + counts.half_day * 0.5) / counted) * 100);

  let charged = 0;
  let paid = 0;
  let pending = 0;
  for (const s of students.rows) {
    const ch = await studentCharges(client, req.schoolId, s);
    charged += ch.total;
    paid += ch.paid;
    pending += ch.pending;
  }

  // Most recent term that actually has marks for this class (a term
  // with only scheduled, unmarked exams has no result to average).
  const termRes = await client.query(
    `SELECT t.id, t.name FROM exam_terms t
     WHERE t.school_id = $1 AND EXISTS (
       SELECT 1 FROM exams e
       JOIN exam_marks m ON m.exam_id = e.id AND m.school_id = e.school_id
       WHERE e.term_id = t.id AND e.school_id = t.school_id AND e.class_id = $2
     )
     ORDER BY t.created_at DESC LIMIT 1`,
    [req.schoolId, req.params.id]
  );
  let examAvg = null;
  if (termRes.rows.length > 0 && students.rows.length > 0) {
    const bands = await getBands(client, req.schoolId);
    let sum = 0;
    let n = 0;
    for (const s of students.rows) {
      const r = await studentTermResult(client, req.schoolId, s, termRes.rows[0].id, bands);
      if (r && r.total > 0) { sum += r.pct; n += 1; }
    }
    examAvg = {
      term: { id: termRes.rows[0].id, name: termRes.rows[0].name },
      average_pct: n > 0 ? round2(sum / n) : null,
      students_with_results: n,
    };
  }

  const hw = await client.query(
    `SELECT COUNT(*)::int AS assigned,
            (SELECT COUNT(*)::int FROM homework_submissions sub
             JOIN homework h2 ON h2.id = sub.homework_id
             WHERE h2.school_id = $1 AND h2.class_id = $2 AND sub.status = 'checked') AS checked
     FROM homework WHERE school_id = $1 AND class_id = $2`,
    [req.schoolId, req.params.id]
  );

  return {
    class_analytics: {
      class: cls.rows[0],
      strength: students.rows.length,
      attendance_30d: { ...counts, pct: attPct },
      fees: { charged: round2(charged), paid: round2(paid), pending: round2(pending) },
      exams: examAvg,
      homework: { assigned: hw.rows[0].assigned, submissions_checked: hw.rows[0].checked },
    },
  };
}));

module.exports = router;
