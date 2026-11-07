'use strict';

// School Manager SaaS — homework (Phase 5).
// Assigning homework to a class creates one submission row per
// ACTIVE student of the class (status 'pending') in the same
// transaction, so teacher rosters and parent "pending homework"
// lists need no lazy creation. Students joining later get a pending
// row the first time the roster is read (see ensureSubmissions).
// Flow: pending -> submitted (on time) | late (after due_date) ->
// checked (teacher adds feedback). Parents/students submit only for
// their linked student; teachers work only in their assigned
// classes; office roles see the whole school.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isNonEmptyString, isDateStr, dateStr, todayStr } = require('../lib/validate');
const { teacherClassIds, linkedStudentId } = require('../lib/scope');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('homework:read'));

const HW_COLS = 'h.id, h.school_id, h.class_id, h.subject_id, h.teacher_user_id, h.title, h.description, '
  + 'h.due_date, h.created_at, h.updated_at, c.name AS class_name, s.name AS subject_name';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function schoolRow(client, req, table, id, label) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND school_id = $2`, [id, req.schoolId]
  );
  if (rows.length === 0) throw bad(`${label} not found`, 404);
  return rows[0];
}

async function assertTeacherClass(client, req, classId) {
  if (req.user.role !== 'teacher') return;
  const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
  if (!ids.includes(classId)) throw bad('This class is not assigned to you', 403);
}

// Backfill pending submission rows for active students of the class
// who do not have one yet (students admitted after assignment).
async function ensureSubmissions(client, req, hw) {
  await client.query(
    `INSERT INTO homework_submissions (school_id, homework_id, student_id)
     SELECT $1, $2, st.id FROM students st
     WHERE st.school_id = $1 AND st.class_id = $3 AND st.status = 'active'
     ON CONFLICT (school_id, homework_id, student_id) DO NOTHING`,
    [req.schoolId, hw.id, hw.class_id]
  );
}

router.get('/', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'h.school_id = $1';
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND h.class_id = $${params.length}`;
  }
  if (req.user.role === 'teacher') {
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    params.push(ids);
    where += ` AND h.class_id = ANY($${params.length}::uuid[])`;
  }
  let linked = null;
  if (req.user.role === 'parent' || req.user.role === 'student') {
    linked = await linkedStudentId(client, req.user);
    if (!linked) return { homework: [] };
    const st = await schoolRow(client, req, 'students', linked, 'Student');
    params.push(st.class_id);
    where += ` AND h.class_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${HW_COLS},
            (SELECT COUNT(*)::int FROM homework_submissions sub
             WHERE sub.homework_id = h.id AND sub.school_id = h.school_id) AS submission_count,
            (SELECT COUNT(*)::int FROM homework_submissions sub
             WHERE sub.homework_id = h.id AND sub.school_id = h.school_id
               AND sub.status IN ('submitted', 'late', 'checked')) AS submitted_count,
            (SELECT COUNT(*)::int FROM homework_submissions sub
             WHERE sub.homework_id = h.id AND sub.school_id = h.school_id
               AND sub.status = 'checked') AS checked_count
     FROM homework h
     JOIN classes c ON c.id = h.class_id
     LEFT JOIN subjects s ON s.id = h.subject_id
     WHERE ${where} ORDER BY h.due_date NULLS LAST, h.created_at DESC`,
    params
  );
  const out = [];
  for (const r of rows) {
    const item = { ...r, due_date: dateStr(r.due_date) };
    if (linked) {
      const sub = await client.query(
        'SELECT status FROM homework_submissions WHERE school_id = $1 AND homework_id = $2 AND student_id = $3',
        [req.schoolId, r.id, linked]
      );
      item.my_status = sub.rows.length > 0 ? sub.rows[0].status : 'pending';
    }
    out.push(item);
  }
  return { homework: out };
}));

router.post('/', requireCapability('homework:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!isNonEmptyString(b.title, 300)) throw bad('title is required', 400);
  if (b.subject_id !== undefined && b.subject_id !== null) {
    if (!isUuid(b.subject_id)) throw bad('subject_id must be a UUID', 400);
    await schoolRow(client, req, 'subjects', b.subject_id, 'Subject');
  }
  if (b.due_date !== undefined && b.due_date !== null && !isDateStr(b.due_date)) {
    throw bad('due_date must be YYYY-MM-DD', 400);
  }
  await schoolRow(client, req, 'classes', b.class_id, 'Class');
  await assertTeacherClass(client, req, b.class_id);
  const { rows } = await client.query(
    `INSERT INTO homework (school_id, class_id, subject_id, teacher_user_id, title, description, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $4) RETURNING id`,
    [
      req.schoolId, b.class_id, b.subject_id || null, req.user.sub,
      b.title.trim(), b.description || null, b.due_date || null,
    ]
  );
  const hw = await schoolRow(client, req, 'homework', rows[0].id, 'Homework');
  await ensureSubmissions(client, req, hw);
  const count = await client.query(
    'SELECT COUNT(*)::int AS n FROM homework_submissions WHERE school_id = $1 AND homework_id = $2',
    [req.schoolId, hw.id]
  );
  return { homework: { ...hw, due_date: dateStr(hw.due_date) }, submissions_created: count.rows[0].n };
}, 201));

router.get('/:id', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid homework id', 400);
  const hw = await schoolRow(client, req, 'homework', req.params.id, 'Homework');
  await assertTeacherClass(client, req, hw.class_id);
  if (req.user.role === 'parent' || req.user.role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    const st = linked ? await schoolRow(client, req, 'students', linked, 'Student') : null;
    if (!st || st.class_id !== hw.class_id) throw bad('Homework not found', 404);
  }
  return { homework: { ...hw, due_date: dateStr(hw.due_date) } };
}));

router.patch('/:id', requireCapability('homework:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid homework id', 400);
  const hw = await schoolRow(client, req, 'homework', req.params.id, 'Homework');
  await assertTeacherClass(client, req, hw.class_id);
  const b = req.body || {};
  const sets = ['updated_at = now()'];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.title !== undefined) {
    if (!isNonEmptyString(b.title, 300)) throw bad('title must be a non-empty string', 400);
    set('title', b.title.trim());
  }
  if (b.description !== undefined) set('description', b.description || null);
  if (b.due_date !== undefined) {
    if (b.due_date !== null && !isDateStr(b.due_date)) throw bad('due_date must be YYYY-MM-DD', 400);
    set('due_date', b.due_date || null);
  }
  if (sets.length === 1) throw bad('Nothing to update', 400);
  const { rows } = await client.query(
    `UPDATE homework SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING *`,
    vals
  );
  return { homework: { ...rows[0], due_date: dateStr(rows[0].due_date) } };
}));

router.delete('/:id', requireCapability('homework:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid homework id', 400);
  const hw = await schoolRow(client, req, 'homework', req.params.id, 'Homework');
  await assertTeacherClass(client, req, hw.class_id);
  await client.query('DELETE FROM homework WHERE school_id = $1 AND id = $2', [req.schoolId, req.params.id]);
  return { deleted: true };
}));

// Roster: every student of the class with their submission state.
router.get('/:id/submissions', withSchoolDb(async (req, client) => {
  if (req.user.role === 'parent' || req.user.role === 'student') {
    throw bad('Submission rosters are staff-only', 403);
  }
  if (!isUuid(req.params.id)) throw bad('Invalid homework id', 400);
  const hw = await schoolRow(client, req, 'homework', req.params.id, 'Homework');
  await assertTeacherClass(client, req, hw.class_id);
  await ensureSubmissions(client, req, hw);
  const { rows } = await client.query(
    `SELECT sub.id, sub.student_id, st.name, st.roll_no, st.section,
            sub.status, sub.submitted_at, sub.note, sub.feedback
     FROM homework_submissions sub
     JOIN students st ON st.id = sub.student_id
     WHERE sub.school_id = $1 AND sub.homework_id = $2
     ORDER BY st.section, st.roll_no, st.name`,
    [req.schoolId, req.params.id]
  );
  return { submissions: rows };
}));

// Submit (or re-submit) for one student. Parents/students submit for
// their linked child only; staff may record a submission on behalf.
router.post('/:id/submit', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid homework id', 400);
  const hw = await schoolRow(client, req, 'homework', req.params.id, 'Homework');
  const b = req.body || {};
  let studentId = b.student_id;
  if (req.user.role === 'parent' || req.user.role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (!linked) throw bad('No linked student for this account', 403);
    if (studentId !== undefined && studentId !== linked) throw bad('You can only submit for your own child', 403);
    studentId = linked;
  } else {
    if (!can(req.user.role, 'homework:write')) throw bad('Forbidden for this role', 403);
    await assertTeacherClass(client, req, hw.class_id);
  }
  if (!isUuid(studentId)) throw bad('student_id must be a UUID', 400);
  const st = await schoolRow(client, req, 'students', studentId, 'Student');
  if (st.class_id !== hw.class_id) throw bad('Student is not in this homework\'s class', 400);
  await ensureSubmissions(client, req, hw);
  const late = hw.due_date && dateStr(hw.due_date) < todayStr();
  const { rows } = await client.query(
    `UPDATE homework_submissions
     SET status = $4, submitted_at = now(), note = $5, updated_at = now()
     WHERE school_id = $1 AND homework_id = $2 AND student_id = $3
     RETURNING *`,
    [req.schoolId, req.params.id, studentId, late ? 'late' : 'submitted', b.note || null]
  );
  if (rows.length === 0) throw bad('Submission not found', 404);
  return { submission: rows[0] };
}));

// Teacher checks a submission (feedback + status 'checked').
router.post('/:id/submissions/:submissionId/check', requireCapability('homework:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id) || !isUuid(req.params.submissionId)) throw bad('Invalid id', 400);
  const hw = await schoolRow(client, req, 'homework', req.params.id, 'Homework');
  await assertTeacherClass(client, req, hw.class_id);
  const b = req.body || {};
  const { rows } = await client.query(
    `UPDATE homework_submissions
     SET status = 'checked', feedback = $4, checked_by = $5, updated_at = now()
     WHERE school_id = $1 AND homework_id = $2 AND id = $3
     RETURNING *`,
    [req.schoolId, req.params.id, req.params.submissionId, b.feedback || null, req.user.sub]
  );
  if (rows.length === 0) throw bad('Submission not found', 404);
  return { submission: rows[0] };
}));

module.exports = router;
