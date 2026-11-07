'use strict';

// School Manager SaaS — deeper portals (Phase 5).
// The Phase 2 dashboard answers "what are today's numbers"; these
// endpoints answer "show me MY school life" in one call each:
//   GET /api/school/portal/me      parent / student portal: the
//     linked student's profile, attendance, fee position, homework
//     still pending, PUBLISHED results, class timetable, transport
//     assignment, active library loans and recent notifications.
//   GET /api/school/portal/teacher teacher portal: my classes and
//     subjects, today's timetable slots, homework waiting to be
//     checked, today's attendance state, upcoming exams.
// Everything is computed from the real tables at request time and
// scoped exactly like the module routes (linked student / assigned
// classes); the Phase 4 publication gate applies to results here too.

const express = require('express');
const { requireAuth, requireSchool, withSchoolDb } = require('../lib/middleware');
const { dateStr, todayStr } = require('../lib/validate');
const { teacherClassIds, linkedStudentId } = require('../lib/scope');
const { studentCharges } = require('../lib/fees');
const { getBands, studentTermResult, classPositions } = require('../lib/grades');

const router = express.Router();

router.use(requireAuth, requireSchool);

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function pctOf(counts) {
  const counted = counts.present + counts.absent + counts.late + counts.half_day;
  if (counted === 0) return null;
  return Math.round(((counts.present + counts.half_day * 0.5) / counted) * 1000) / 10;
}

async function attendanceCounts(client, schoolId, studentId, monthPrefix) {
  const params = [schoolId, studentId];
  let where = 'school_id = $1 AND student_id = $2';
  if (monthPrefix) {
    params.push(monthPrefix);
    where += ` AND to_char(date, 'YYYY-MM') = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM attendance WHERE ${where} GROUP BY status`,
    params
  );
  const counts = { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return { ...counts, pct: pctOf(counts) };
}

// ---------------- Parent / student portal ----------------

router.get('/me', withSchoolDb(async (req, client) => {
  if (req.user.role !== 'parent' && req.user.role !== 'student') {
    throw bad('This portal is for parent and student accounts', 403);
  }
  const linked = await linkedStudentId(client, req.user);
  if (!linked) return { portal: { student: null } };
  const { rows } = await client.query(
    `SELECT s.*, c.name AS class_name, c.id AS cls_id FROM students s
     JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 AND s.id = $2`,
    [req.schoolId, linked]
  );
  if (rows.length === 0) return { portal: { student: null } };
  const student = rows[0];
  const month = todayStr().slice(0, 7);

  const [attMonth, attOverall, charges] = await Promise.all([
    attendanceCounts(client, req.schoolId, linked, month),
    attendanceCounts(client, req.schoolId, linked, null),
    studentCharges(client, req.schoolId, student),
  ]);

  // Homework of the class with MY submission state; pending first.
  const hw = await client.query(
    `SELECT h.id, h.title, h.description, h.due_date, s.name AS subject_name,
            COALESCE(sub.status, 'pending') AS my_status
     FROM homework h
     LEFT JOIN subjects s ON s.id = h.subject_id
     LEFT JOIN homework_submissions sub
       ON sub.homework_id = h.id AND sub.school_id = h.school_id AND sub.student_id = $2
     WHERE h.school_id = $1 AND h.class_id = $3
     ORDER BY h.due_date DESC NULLS LAST LIMIT 50`,
    [req.schoolId, linked, student.class_id]
  );
  const homework = hw.rows.map((r) => ({ ...r, due_date: dateStr(r.due_date) }));
  // 'late' means submitted late — only never-submitted rows pend.
  const homeworkPending = homework.filter((h) => h.my_status === 'pending');

  // Results: published terms only, newest first.
  const bands = await getBands(client, req.schoolId);
  const terms = await client.query(
    `SELECT id, name FROM exam_terms
     WHERE school_id = $1 AND results_published = true ORDER BY created_at DESC`,
    [req.schoolId]
  );
  const results = [];
  for (const t of terms.rows) {
    const r = await studentTermResult(client, req.schoolId, student, t.id, bands);
    const positions = await classPositions(client, req.schoolId, student.class_id, t.id, bands);
    const mine = positions.get(student.id);
    results.push({
      term: { id: t.id, name: t.name },
      total: r.total, obtained: r.obtained, pct: r.pct, grade: r.grade, gpa: r.gpa,
      position: mine ? mine.position : null, class_size: mine ? mine.class_size : null,
      subjects: r.subjects.map((s) => ({
        subject_name: s.subject_name, obtained: s.obtained, total: s.total,
        pct: s.pct, grade: s.grade,
      })),
    });
  }

  const tt = await client.query(
    `SELECT ts.weekday, ts.period_no, ts.starts_at, ts.ends_at, ts.room, s.name AS subject_name, u.name AS teacher_name
     FROM timetable_slots ts
     LEFT JOIN subjects s ON s.id = ts.subject_id
     LEFT JOIN users u ON u.id = ts.teacher_user_id
     WHERE ts.school_id = $1 AND ts.class_id = $2
     ORDER BY ts.weekday, ts.period_no`,
    [req.schoolId, student.class_id]
  );

  const transport = await client.query(
    `SELECT a.id, a.fee_amount, a.status, r.name AS route_name, st.stop_name,
            st.pickup_time, v.registration_no, v.driver_name, v.driver_phone
     FROM transport_assignments a
     JOIN transport_routes r ON r.id = a.route_id
     LEFT JOIN transport_stops st ON st.id = a.stop_id
     LEFT JOIN transport_vehicles v ON v.id = r.vehicle_id
     WHERE a.school_id = $1 AND a.student_id = $2`,
    [req.schoolId, linked]
  );

  const loans = await client.query(
    `SELECT l.id, l.due_on, l.issued_on, bk.title AS book_title
     FROM library_loans l JOIN library_books bk ON bk.id = l.book_id
     WHERE l.school_id = $1 AND l.student_id = $2 AND l.returned_on IS NULL
     ORDER BY l.due_on`,
    [req.schoolId, linked]
  );

  const notes = await client.query(
    `SELECT id, type, title, body, is_read, created_at FROM notifications
     WHERE school_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 5`,
    [req.schoolId, req.user.sub]
  );
  const unread = await client.query(
    'SELECT COUNT(*)::int AS n FROM notifications WHERE school_id = $1 AND user_id = $2 AND is_read = false',
    [req.schoolId, req.user.sub]
  );

  return {
    portal: {
      student: {
        id: student.id, name: student.name, admission_number: student.admission_number,
        class_name: student.class_name, section: student.section, roll_no: student.roll_no,
        status: student.status,
      },
      attendance: { month: { month, ...attMonth }, overall: attOverall },
      fees: {
        total: charges.total, paid: charges.paid, pending: charges.pending,
        overdue: charges.overdue, fine: charges.fine_total,
      },
      homework,
      homework_pending: homeworkPending,
      results,
      timetable: tt.rows.map((r) => ({
        ...r,
        starts_at: r.starts_at ? String(r.starts_at).slice(0, 5) : null,
        ends_at: r.ends_at ? String(r.ends_at).slice(0, 5) : null,
      })),
      transport: transport.rows.length > 0
        ? {
          ...transport.rows[0],
          fee_amount: Number(transport.rows[0].fee_amount),
          pickup_time: transport.rows[0].pickup_time ? String(transport.rows[0].pickup_time).slice(0, 5) : null,
        }
        : null,
      library_loans: loans.rows.map((r) => ({
        ...r, due_on: dateStr(r.due_on), issued_on: dateStr(r.issued_on),
      })),
      notifications: notes.rows,
      unread_notifications: unread.rows[0].n,
    },
  };
}));

// ---------------- Teacher portal ----------------

router.get('/teacher', withSchoolDb(async (req, client) => {
  if (req.user.role !== 'teacher') throw bad('This portal is for teacher accounts', 403);
  const classIds = await teacherClassIds(client, req.schoolId, req.user.sub);
  const classes = [];
  for (const id of classIds) {
    const cls = await client.query(
      'SELECT id, name FROM classes WHERE school_id = $1 AND id = $2', [req.schoolId, id]
    );
    if (cls.rows.length === 0) continue;
    const n = await client.query(
      "SELECT COUNT(*)::int AS n FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'",
      [req.schoolId, id]
    );
    const att = await client.query(
      `SELECT status, COUNT(*)::int AS n FROM attendance
       WHERE school_id = $1 AND class_id = $2 AND date = CURRENT_DATE GROUP BY status`,
      [req.schoolId, id]
    );
    const counts = { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
    for (const r of att.rows) counts[r.status] = r.n;
    classes.push({
      id, name: cls.rows[0].name, student_count: n.rows[0].n,
      attendance_today: { ...counts, pct: pctOf(counts) },
    });
  }
  classes.sort((a, b) => a.name.localeCompare(b.name));

  const subjects = await client.query(
    `SELECT ts.subject_id, s.name AS subject_name, ts.class_id, c.name AS class_name
     FROM teacher_subjects ts
     JOIN subjects s ON s.id = ts.subject_id
     JOIN classes c ON c.id = ts.class_id
     WHERE ts.school_id = $1 AND ts.teacher_user_id = $2
     ORDER BY c.name, s.name`,
    [req.schoolId, req.user.sub]
  );

  // JS getDay(): 0 = Sunday .. 6 = Saturday -> our 1 = Mon .. 7 = Sun.
  const jsDay = new Date().getDay();
  const weekday = jsDay === 0 ? 7 : jsDay;
  const todaySlots = await client.query(
    `SELECT ts.period_no, ts.starts_at, ts.ends_at, ts.room, c.name AS class_name, s.name AS subject_name
     FROM timetable_slots ts
     JOIN classes c ON c.id = ts.class_id
     LEFT JOIN subjects s ON s.id = ts.subject_id
     WHERE ts.school_id = $1 AND ts.weekday = $2
       AND (ts.teacher_user_id = $3 OR ts.class_id = ANY($4::uuid[]))
     ORDER BY ts.period_no`,
    [req.schoolId, weekday, req.user.sub, classIds]
  );

  const toCheck = await client.query(
    `SELECT COUNT(*)::int AS n FROM homework_submissions sub
     JOIN homework h ON h.id = sub.homework_id
     WHERE sub.school_id = $1 AND sub.status IN ('submitted', 'late')
       AND h.class_id = ANY($2::uuid[])`,
    [req.schoolId, classIds]
  );

  const upcoming = await client.query(
    `SELECT e.id, e.name, e.exam_date, e.total_marks, c.name AS class_name, s.name AS subject_name
     FROM exams e
     JOIN classes c ON c.id = e.class_id
     JOIN subjects s ON s.id = e.subject_id
     WHERE e.school_id = $1 AND e.class_id = ANY($2::uuid[]) AND e.exam_date >= CURRENT_DATE
     ORDER BY e.exam_date LIMIT 5`,
    [req.schoolId, classIds]
  );

  return {
    portal: {
      classes,
      subjects: subjects.rows,
      today: {
        weekday,
        timetable: todaySlots.rows.map((r) => ({
          ...r,
          starts_at: r.starts_at ? String(r.starts_at).slice(0, 5) : null,
          ends_at: r.ends_at ? String(r.ends_at).slice(0, 5) : null,
        })),
      },
      homework_to_check: toCheck.rows[0].n,
      upcoming_exams: upcoming.rows.map((r) => ({
        ...r, exam_date: dateStr(r.exam_date), total_marks: Number(r.total_marks),
      })),
    },
  };
}));

module.exports = router;
