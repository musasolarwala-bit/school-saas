'use strict';

// School Manager SaaS — exams & results (Phase 4).
// exam_terms group exams; a term's results_published flag is the
// publication gate (parents/students see results only after the
// office publishes). Exams belong to a class + subject with a total;
// marks are entered in bulk per exam. Grades, GPA and class positions
// are computed from marks at read time (lib/grades.js) against the
// school's configurable grade_bands.
//
// Roles: terms, grading scale and publication are office writes
// (school_admin / school_owner). Teachers create exams and enter
// marks ONLY for their assigned classes and the subjects they teach
// there (or classes they are class teacher of). Parents/students see
// their linked child's PUBLISHED results and report card.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isNonEmptyString, isDateStr, dateStr } = require('../lib/validate');
const { teacherClassIds, linkedStudentId } = require('../lib/scope');
const { getBands, studentTermResult, classPositions } = require('../lib/grades');
const { logAudit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');

const router = express.Router();

router.use(requireAuth, requireSchool);

const TERM_COLS = 'id, school_id, session_id, name, starts_on, ends_on, results_published, published_at, created_at';
const EXAM_COLS = 'e.id, e.school_id, e.term_id, e.class_id, e.subject_id, e.name, e.exam_date, e.total_marks, e.created_at, '
  + 'c.name AS class_name, s.name AS subject_name, t.name AS term_name';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function escHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isOffice(req) {
  return req.user.role === 'school_admin' || req.user.role === 'school_owner';
}

function assertOfficeWrite(req) {
  if (!isOffice(req)) throw bad('Only school admin / owner can do this', 403);
}

async function schoolRow(client, req, table, id, label) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND school_id = $2`, [id, req.schoolId]
  );
  if (rows.length === 0) throw bad(`${label} not found`, 404);
  return rows[0];
}

// Teacher scope: the class is one of their assigned classes.
async function assertTeacherClass(client, req, classId) {
  if (req.user.role !== 'teacher') return;
  const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
  if (!ids.includes(classId)) throw bad('This class is not assigned to you', 403);
}

// Teacher marks-entry scope: class teacher of the exam's class, or a
// teacher_subjects row for (teacher, exam subject, exam class).
async function assertCanEnterMarks(client, req, exam) {
  if (req.user.role !== 'teacher') return;
  const cls = await client.query(
    'SELECT teacher_id FROM classes WHERE school_id = $1 AND id = $2',
    [req.schoolId, exam.class_id]
  );
  if (cls.rows.length > 0 && cls.rows[0].teacher_id === req.user.sub) return;
  const ts = await client.query(
    `SELECT id FROM teacher_subjects
     WHERE school_id = $1 AND teacher_user_id = $2 AND subject_id = $3 AND class_id = $4`,
    [req.schoolId, req.user.sub, exam.subject_id, exam.class_id]
  );
  if (ts.rows.length === 0) {
    throw bad('You do not teach this subject in this class', 403);
  }
}

// Publication + ownership gate shared by result reads.
async function loadStudentForResult(client, req, studentId) {
  const student = await schoolRow(client, req, 'students', studentId, 'Student');
  const role = req.user.role;
  if (role === 'parent' || role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (linked !== studentId) throw bad('Student not found', 404);
  } else if (role === 'teacher') {
    await assertTeacherClass(client, req, student.class_id);
  } else if (!can(role, 'exams:read')) {
    throw bad('Forbidden for this role', 403);
  }
  return student;
}

function assertPublishedForPortal(req, result) {
  if ((req.user.role === 'parent' || req.user.role === 'student') && !result.term.results_published) {
    throw bad('Results for this term are not published yet', 403);
  }
}

// ---------------- Terms ----------------

router.get('/terms', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    `SELECT ${TERM_COLS} FROM exam_terms WHERE school_id = $1 ORDER BY created_at DESC`,
    [req.schoolId]
  );
  return { terms: rows };
}));

router.post('/terms', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  assertOfficeWrite(req);
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  if (b.starts_on !== undefined && b.starts_on !== null && !isDateStr(b.starts_on)) throw bad('starts_on must be YYYY-MM-DD', 400);
  if (b.ends_on !== undefined && b.ends_on !== null && !isDateStr(b.ends_on)) throw bad('ends_on must be YYYY-MM-DD', 400);
  if (b.session_id !== undefined && b.session_id !== null) {
    if (!isUuid(b.session_id)) throw bad('session_id must be a UUID', 400);
    await schoolRow(client, req, 'sessions', b.session_id, 'Session');
  }
  try {
    const { rows } = await client.query(
      `INSERT INTO exam_terms (school_id, session_id, name, starts_on, ends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${TERM_COLS}`,
      [req.schoolId, b.session_id || null, b.name.trim(), b.starts_on || null, b.ends_on || null, req.user.sub]
    );
    return { term: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A term with that name already exists in this school', 409);
    throw err;
  }
}, 201));

router.patch('/terms/:id', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  assertOfficeWrite(req);
  if (!isUuid(req.params.id)) throw bad('Invalid term id', 400);
  const b = req.body || {};
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.name !== undefined) {
    if (!isNonEmptyString(b.name, 200)) throw bad('name must be a non-empty string', 400);
    set('name', b.name.trim());
  }
  for (const f of ['starts_on', 'ends_on']) {
    if (b[f] !== undefined) {
      if (b[f] !== null && !isDateStr(b[f])) throw bad(`${f} must be YYYY-MM-DD`, 400);
      set(f, b[f] || null);
    }
  }
  if (sets.length === 0) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE exam_terms SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING ${TERM_COLS}`,
      vals
    );
    if (rows.length === 0) throw bad('Term not found', 404);
    return { term: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A term with that name already exists in this school', 409);
    throw err;
  }
}));

router.delete('/terms/:id', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  assertOfficeWrite(req);
  if (!isUuid(req.params.id)) throw bad('Invalid term id', 400);
  const { rows } = await client.query(
    'DELETE FROM exam_terms WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Term not found', 404);
  return { deleted: true };
}));

// Publish / unpublish a term's results — the gate parents see.
router.post('/terms/:id/publish', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  assertOfficeWrite(req);
  if (!isUuid(req.params.id)) throw bad('Invalid term id', 400);
  const published = !req.body || req.body.published !== false;
  const { rows } = await client.query(
    `UPDATE exam_terms
     SET results_published = $3, published_at = CASE WHEN $3 THEN now() ELSE published_at END
     WHERE school_id = $1 AND id = $2 RETURNING ${TERM_COLS}`,
    [req.schoolId, req.params.id, published]
  );
  if (rows.length === 0) throw bad('Term not found', 404);
  await logAudit(client, req, published ? 'exam_results.publish' : 'exam_results.unpublish',
    'exam_term', req.params.id, { term: rows[0].name });
  return { term: rows[0] };
}));

// ---------------- Grading scale ----------------

router.get('/grading', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  const bands = await getBands(client, req.schoolId);
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM grade_bands WHERE school_id = $1', [req.schoolId]
  );
  return { bands, is_custom: rows[0].n > 0 };
}));

// Replace the whole scale in one call. Bands may have gaps but must
// never overlap.
router.put('/grading', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  assertOfficeWrite(req);
  const bands = (req.body || {}).bands;
  if (!Array.isArray(bands) || bands.length === 0) throw bad('bands must be a non-empty array', 400);
  const clean = bands.map((b) => {
    if (!b || !isNonEmptyString(b.label, 20)) throw bad('every band needs a label', 400);
    const min = Number(b.min_pct);
    const max = Number(b.max_pct);
    const gp = Number(b.grade_point === undefined ? 0 : b.grade_point);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 100 || min > max) {
      throw bad('band percentages must satisfy 0 <= min_pct <= max_pct <= 100', 400);
    }
    if (!Number.isFinite(gp) || gp < 0) throw bad('grade_point must be a number >= 0', 400);
    return { label: b.label.trim(), min_pct: min, max_pct: max, grade_point: gp };
  });
  const sorted = [...clean].sort((a, b) => a.min_pct - b.min_pct);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min_pct <= sorted[i - 1].max_pct) {
      throw bad(`Grade bands overlap: ${sorted[i - 1].label} and ${sorted[i].label}`, 400);
    }
  }
  if (new Set(clean.map((b) => b.label)).size !== clean.length) throw bad('Grade band labels must be unique', 400);
  await client.query('DELETE FROM grade_bands WHERE school_id = $1', [req.schoolId]);
  for (const b of clean) {
    await client.query(
      'INSERT INTO grade_bands (school_id, label, min_pct, max_pct, grade_point) VALUES ($1, $2, $3, $4, $5)',
      [req.schoolId, b.label, b.min_pct, b.max_pct, b.grade_point]
    );
  }
  return { bands: await getBands(client, req.schoolId), is_custom: true };
}));

// ---------------- Exams ----------------

router.get('/', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'e.school_id = $1';
  if (req.query.term_id !== undefined) {
    if (!isUuid(req.query.term_id)) throw bad('term_id must be a UUID', 400);
    params.push(req.query.term_id);
    where += ` AND e.term_id = $${params.length}`;
  }
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND e.class_id = $${params.length}`;
  }
  if (req.user.role === 'teacher') {
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    params.push(ids);
    where += ` AND e.class_id = ANY($${params.length}::uuid[])`;
  }
  if (req.user.role === 'parent' || req.user.role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (!linked) return { exams: [] };
    const st = await schoolRow(client, req, 'students', linked, 'Student');
    params.push(st.class_id);
    where += ` AND e.class_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${EXAM_COLS} FROM exams e
     JOIN classes c ON c.id = e.class_id
     JOIN subjects s ON s.id = e.subject_id
     JOIN exam_terms t ON t.id = e.term_id
     WHERE ${where} ORDER BY e.exam_date NULLS LAST, c.name, s.name`,
    params
  );
  return { exams: rows.map((r) => ({ ...r, total_marks: Number(r.total_marks), exam_date: dateStr(r.exam_date) })) };
}));

router.post('/', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.term_id)) throw bad('term_id must be a UUID', 400);
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!isUuid(b.subject_id)) throw bad('subject_id must be a UUID', 400);
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  const total = Number(b.total_marks);
  if (!Number.isFinite(total) || total <= 0) throw bad('total_marks must be a number > 0', 400);
  if (b.exam_date !== undefined && b.exam_date !== null && !isDateStr(b.exam_date)) {
    throw bad('exam_date must be YYYY-MM-DD', 400);
  }
  await schoolRow(client, req, 'exam_terms', b.term_id, 'Term');
  await schoolRow(client, req, 'classes', b.class_id, 'Class');
  await schoolRow(client, req, 'subjects', b.subject_id, 'Subject');
  if (req.user.role === 'teacher') {
    // A teacher creates exams only where they could enter marks.
    await assertCanEnterMarks(client, req, { class_id: b.class_id, subject_id: b.subject_id });
  }
  try {
    const { rows } = await client.query(
      `INSERT INTO exams (school_id, term_id, class_id, subject_id, name, exam_date, total_marks, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.schoolId, b.term_id, b.class_id, b.subject_id, b.name.trim(), b.exam_date || null, total, req.user.sub]
    );
    const full = await client.query(
      `SELECT ${EXAM_COLS} FROM exams e
       JOIN classes c ON c.id = e.class_id JOIN subjects s ON s.id = e.subject_id
       JOIN exam_terms t ON t.id = e.term_id WHERE e.school_id = $1 AND e.id = $2`,
      [req.schoolId, rows[0].id]
    );
    return { exam: { ...full.rows[0], total_marks: Number(full.rows[0].total_marks), exam_date: dateStr(full.rows[0].exam_date) } };
  } catch (err) {
    if (err.code === '23505') throw bad('An exam with that name already exists for this term, class and subject', 409);
    throw err;
  }
}, 201));

router.patch('/:id', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid exam id', 400);
  const exam = await schoolRow(client, req, 'exams', req.params.id, 'Exam');
  await assertCanEnterMarks(client, req, exam);
  const b = req.body || {};
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.name !== undefined) {
    if (!isNonEmptyString(b.name, 200)) throw bad('name must be a non-empty string', 400);
    set('name', b.name.trim());
  }
  if (b.exam_date !== undefined) {
    if (b.exam_date !== null && !isDateStr(b.exam_date)) throw bad('exam_date must be YYYY-MM-DD', 400);
    set('exam_date', b.exam_date || null);
  }
  if (b.total_marks !== undefined) {
    const total = Number(b.total_marks);
    if (!Number.isFinite(total) || total <= 0) throw bad('total_marks must be a number > 0', 400);
    // Never shrink the total below marks already entered.
    const mx = await client.query(
      'SELECT COALESCE(MAX(marks_obtained), 0) AS m FROM exam_marks WHERE school_id = $1 AND exam_id = $2',
      [req.schoolId, req.params.id]
    );
    if (total < Number(mx.rows[0].m)) throw bad('total_marks is below marks already entered', 400);
    set('total_marks', total);
  }
  if (sets.length === 0) throw bad('Nothing to update', 400);
  const { rows } = await client.query(
    `UPDATE exams SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING id, name, exam_date, total_marks`,
    vals
  );
  return { exam: { ...rows[0], total_marks: Number(rows[0].total_marks), exam_date: dateStr(rows[0].exam_date) } };
}));

router.delete('/:id', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid exam id', 400);
  const exam = await schoolRow(client, req, 'exams', req.params.id, 'Exam');
  if (req.user.role === 'teacher') await assertCanEnterMarks(client, req, exam);
  await client.query('DELETE FROM exams WHERE school_id = $1 AND id = $2', [req.schoolId, req.params.id]);
  return { deleted: true };
}));

// ---------------- Marks ----------------

// Roster for one exam: every active student of the class + their mark.
router.get('/:id/marks', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  if (req.user.role === 'parent' || req.user.role === 'student') {
    throw bad('Mark sheets are staff-only; see your published results', 403);
  }
  if (!isUuid(req.params.id)) throw bad('Invalid exam id', 400);
  const exam = await schoolRow(client, req, 'exams', req.params.id, 'Exam');
  await assertTeacherClass(client, req, exam.class_id);
  const { rows } = await client.query(
    `SELECT st.id AS student_id, st.name, st.roll_no, st.section,
            m.marks_obtained, m.remarks
     FROM students st
     LEFT JOIN exam_marks m ON m.student_id = st.id AND m.exam_id = $2 AND m.school_id = $1
     WHERE st.school_id = $1 AND st.class_id = $3 AND st.status = 'active'
     ORDER BY st.section, st.roll_no, st.name`,
    [req.schoolId, req.params.id, exam.class_id]
  );
  return {
    exam: { id: exam.id, name: exam.name, total_marks: Number(exam.total_marks) },
    marks: rows.map((r) => ({
      ...r,
      marks_obtained: r.marks_obtained === null ? null : Number(r.marks_obtained),
    })),
  };
}));

// Bulk marks entry: the whole sheet in one transaction. Any invalid
// entry (student of another class, marks above the total) rejects
// the whole sheet so a class never ends up half-entered by accident.
router.post('/:id/marks/bulk', requireCapability('exams:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid exam id', 400);
  const exam = await schoolRow(client, req, 'exams', req.params.id, 'Exam');
  await assertCanEnterMarks(client, req, exam);
  const entries = (req.body || {}).entries;
  if (!Array.isArray(entries) || entries.length === 0) throw bad('entries must be a non-empty array', 400);
  const total = Number(exam.total_marks);
  let saved = 0;
  for (const e of entries) {
    if (!e || !isUuid(e.student_id)) throw bad('every entry needs a student_id', 400);
    const marks = Number(e.marks_obtained);
    if (!Number.isFinite(marks) || marks < 0) throw bad('marks_obtained must be a number >= 0', 400);
    if (marks > total) throw bad(`marks_obtained cannot exceed the exam total (${total})`, 400);
    const st = await client.query(
      "SELECT id FROM students WHERE school_id = $1 AND id = $2 AND class_id = $3 AND status = 'active'",
      [req.schoolId, e.student_id, exam.class_id]
    );
    if (st.rows.length === 0) throw bad('an entry names a student who is not an active member of this class', 400);
    await client.query(
      `INSERT INTO exam_marks (school_id, exam_id, student_id, marks_obtained, remarks, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (school_id, exam_id, student_id)
       DO UPDATE SET marks_obtained = EXCLUDED.marks_obtained,
                     remarks = EXCLUDED.remarks, entered_by = EXCLUDED.entered_by,
                     updated_at = now()`,
      [req.schoolId, req.params.id, e.student_id, marks, e.remarks || null, req.user.sub]
    );
    saved += 1;
  }
  return { saved };
}, 201));

// ---------------- Results ----------------

async function resolveTerm(client, req) {
  const termId = req.query.term_id;
  if (termId !== undefined) {
    if (!isUuid(termId)) throw bad('term_id must be a UUID', 400);
    return schoolRow(client, req, 'exam_terms', termId, 'Term');
  }
  const { rows } = await client.query(
    'SELECT * FROM exam_terms WHERE school_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.schoolId]
  );
  if (rows.length === 0) throw bad('No exam term exists yet', 404);
  return rows[0];
}

router.get('/results/student/:studentId', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.studentId)) throw bad('Invalid student id', 400);
  const student = await loadStudentForResult(client, req, req.params.studentId);
  const term = await resolveTerm(client, req);
  const bands = await getBands(client, req.schoolId);
  const result = await studentTermResult(client, req.schoolId, student, term.id, bands);
  assertPublishedForPortal(req, result);
  const positions = await classPositions(client, req.schoolId, student.class_id, term.id, bands);
  const mine = positions.get(student.id);
  return {
    result: {
      student: { id: student.id, name: student.name, roll_no: student.roll_no, section: student.section },
      ...result,
      position: mine ? mine.position : null,
      class_size: mine ? mine.class_size : null,
    },
  };
}));

router.get('/results/class/:classId', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  if (req.user.role === 'parent' || req.user.role === 'student') {
    throw bad('Class results are staff-only', 403);
  }
  if (!isUuid(req.params.classId)) throw bad('Invalid class id', 400);
  await schoolRow(client, req, 'classes', req.params.classId, 'Class');
  await assertTeacherClass(client, req, req.params.classId);
  const term = await resolveTerm(client, req);
  const bands = await getBands(client, req.schoolId);
  const { rows } = await client.query(
    "SELECT id, name, roll_no, section, class_id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active' ORDER BY section, roll_no, name",
    [req.schoolId, req.params.classId]
  );
  const positions = await classPositions(client, req.schoolId, req.params.classId, term.id, bands);
  const out = [];
  for (const st of rows) {
    const r = await studentTermResult(client, req.schoolId, st, term.id, bands);
    const pos = positions.get(st.id);
    out.push({
      student: { id: st.id, name: st.name, roll_no: st.roll_no, section: st.section },
      total: r.total, obtained: r.obtained, pct: r.pct, grade: r.grade, gpa: r.gpa,
      position: pos ? pos.position : null,
    });
  }
  out.sort((a, b) => (a.position || 999) - (b.position || 999));
  return { term: { id: term.id, name: term.name, results_published: term.results_published }, results: out };
}));

// Merit list: with class_id, that class's ranking; without, the
// school-wide ranking across classes for the term (office roles).
router.get('/merit', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  if (req.user.role === 'parent' || req.user.role === 'student') {
    throw bad('Merit lists are staff-only', 403);
  }
  const term = await resolveTerm(client, req);
  const bands = await getBands(client, req.schoolId);
  let classIds;
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    await schoolRow(client, req, 'classes', req.query.class_id, 'Class');
    await assertTeacherClass(client, req, req.query.class_id);
    classIds = [req.query.class_id];
  } else {
    if (req.user.role === 'teacher') {
      classIds = await teacherClassIds(client, req.schoolId, req.user.sub);
    } else {
      const { rows } = await client.query('SELECT id FROM classes WHERE school_id = $1', [req.schoolId]);
      classIds = rows.map((r) => r.id);
    }
  }
  const entries = [];
  for (const classId of classIds) {
    const { rows } = await client.query(
      `SELECT st.id, st.name, st.roll_no, st.section, c.name AS class_name
       FROM students st JOIN classes c ON c.id = st.class_id
       WHERE st.school_id = $1 AND st.class_id = $2 AND st.status = 'active'`,
      [req.schoolId, classId]
    );
    for (const st of rows) {
      const r = await studentTermResult(client, req.schoolId, { id: st.id, class_id: classId }, term.id, bands);
      if (r && r.total > 0) {
        entries.push({
          student_id: st.id, name: st.name, roll_no: st.roll_no, section: st.section,
          class_id: classId, class_name: st.class_name,
          total: r.total, obtained: r.obtained, pct: r.pct, grade: r.grade, gpa: r.gpa,
        });
      }
    }
  }
  entries.sort((a, b) => b.pct - a.pct || b.obtained - a.obtained);
  return {
    term: { id: term.id, name: term.name },
    merit: entries.slice(0, 100).map((e, i) => ({ rank: i + 1, ...e })),
  };
}));

// Class results CSV (same numbers as /results/class).
router.get('/results/export.csv', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  if (req.user.role === 'parent' || req.user.role === 'student') {
    throw bad('Class results are staff-only', 403);
  }
  if (!isUuid(req.query.class_id)) throw bad('class_id query parameter is required', 400);
  await schoolRow(client, req, 'classes', req.query.class_id, 'Class');
  await assertTeacherClass(client, req, req.query.class_id);
  const term = await resolveTerm(client, req);
  const bands = await getBands(client, req.schoolId);
  const positions = await classPositions(client, req.schoolId, req.query.class_id, term.id, bands);
  const { rows } = await client.query(
    "SELECT id, name, roll_no, section, class_id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'",
    [req.schoolId, req.query.class_id]
  );
  const csvRows = [];
  for (const st of rows) {
    const r = await studentTermResult(client, req.schoolId, st, term.id, bands);
    const pos = positions.get(st.id);
    csvRows.push([st.name, st.section, st.roll_no, r.obtained, r.total, r.pct, r.grade, r.gpa, pos ? pos.position : '']);
  }
  csvRows.sort((a, b) => (a[8] || 999) - (b[8] || 999));
  const res = req.res;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(toCsv(['student', 'section', 'roll_no', 'obtained', 'total', 'percentage', 'grade', 'gpa', 'position'], csvRows));
  return undefined;
}));

// Printable HTML report card (browser print -> PDF), same style and
// publication gate as the fee receipt.
router.get('/report-card/:studentId', requireCapability('exams:read'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.studentId)) throw bad('Invalid student id', 400);
  const student = await loadStudentForResult(client, req, req.params.studentId);
  const term = await resolveTerm(client, req);
  const bands = await getBands(client, req.schoolId);
  const result = await studentTermResult(client, req.schoolId, student, term.id, bands);
  assertPublishedForPortal(req, result);
  const positions = await classPositions(client, req.schoolId, student.class_id, term.id, bands);
  const mine = positions.get(student.id);
  const meta = await client.query(
    `SELECT sc.name AS school_name, sc.display_name, sc.primary_color, c.name AS class_name
     FROM schools sc, classes c WHERE sc.id = $1 AND c.id = $2`,
    [req.schoolId, student.class_id]
  );
  const m = meta.rows[0];
  const schoolName = m.display_name || m.school_name;
  const subjectRows = result.subjects.map((s) =>
    `<tr><td>${escHtml(s.subject_name)}</td><td>${s.obtained}</td><td>${s.total}</td><td>${s.pct}%</td><td><strong>${escHtml(s.grade)}</strong></td><td>${s.grade_point}</td></tr>`
  ).join('');
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Report Card — ${escHtml(student.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:40px;color:#1F2937}
.head{border-bottom:3px solid ${escHtml(m.primary_color || '#1d6fb8')};padding-bottom:8px;margin-bottom:16px}
table{border-collapse:collapse;width:100%}td,th{padding:6px 10px;font-size:14px;border-bottom:1px solid #E5E7EB;text-align:left}
.k{color:#6B7280}@media print{button{display:none}}</style></head>
<body>
<div class="head"><h1>${escHtml(schoolName)}</h1><p>Report Card — ${escHtml(result.term.name)}</p></div>
<table>
<tr><td class="k">Student</td><td><strong>${escHtml(student.name)}</strong></td><td class="k">Class</td><td>${escHtml(m.class_name)} — Section ${escHtml(student.section)}, Roll ${escHtml(student.roll_no)}</td></tr>
<tr><td class="k">Admission No</td><td>${escHtml(student.admission_number || '')}</td><td class="k">Position</td><td>${mine ? mine.position + ' of ' + mine.class_size : '—'}</td></tr>
</table>
<h3>Subjects</h3>
<table><thead><tr><th>Subject</th><th>Obtained</th><th>Total</th><th>%</th><th>Grade</th><th>Points</th></tr></thead>
<tbody>${subjectRows || '<tr><td colspan="6">No exams in this term yet</td></tr>'}</tbody></table>
<table>
<tr><td class="k">Grand total</td><td><strong>${result.obtained} / ${result.total}</strong></td><td class="k">Percentage</td><td><strong>${result.pct}%</strong></td></tr>
<tr><td class="k">Overall grade</td><td><strong>${escHtml(result.grade)}</strong></td><td class="k">GPA</td><td><strong>${result.gpa}</strong></td></tr>
</table>
<p><button onclick="window.print()">Print</button></p>
</body></html>`;
  const res = req.res;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
  return undefined;
}));

module.exports = router;
