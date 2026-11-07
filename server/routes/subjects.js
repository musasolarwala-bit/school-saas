'use strict';

// School Manager SaaS — subjects and assignments (Phase 2).
// subjects: the school's subject list. class_subjects: which subjects
// a class studies. teacher_subjects: which teacher teaches which
// subject in which class — a teacher_subjects row also makes the
// class one of the teacher's "assigned classes" (lib/scope.js), so
// subject teachers can mark that class's attendance.
// Reads need classes:read (teacher included); writes classes:write
// (school_admin / school_owner).

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isNonEmptyString } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertRead(req) {
  if (!can(req.user.role, 'classes:read') && req.user.role !== 'teacher') {
    throw bad('Forbidden for this role', 403);
  }
}

async function schoolRow(client, req, table, id, label) {
  const { rows } = await client.query(
    `SELECT id FROM ${table} WHERE id = $1 AND school_id = $2`, [id, req.schoolId]
  );
  if (rows.length === 0) throw bad(`${label} not found`, 404);
  return rows[0];
}

router.get('/', withSchoolDb(async (req, client) => {
  assertRead(req);
  const { rows } = await client.query(
    'SELECT id, school_id, name, created_at FROM subjects WHERE school_id = $1 ORDER BY name ASC',
    [req.schoolId]
  );
  return { subjects: rows };
}));

router.post('/', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  try {
    const { rows } = await client.query(
      'INSERT INTO subjects (school_id, name) VALUES ($1, $2) RETURNING id, school_id, name, created_at',
      [req.schoolId, b.name.trim()]
    );
    return { subject: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A subject with that name already exists in this school', 409);
    throw err;
  }
}, 201));

router.delete('/:id', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid subject id', 400);
  const { rows } = await client.query(
    'DELETE FROM subjects WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Subject not found', 404);
  return { deleted: true };
}));

// ---- Class <-> subject ----

router.get('/class-subjects', withSchoolDb(async (req, client) => {
  assertRead(req);
  const params = [req.schoolId];
  let where = 'cs.school_id = $1';
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND cs.class_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT cs.id, cs.school_id, cs.class_id, c.name AS class_name,
            cs.subject_id, s.name AS subject_name, cs.created_at
     FROM class_subjects cs
     JOIN classes c ON c.id = cs.class_id
     JOIN subjects s ON s.id = cs.subject_id
     WHERE ${where} ORDER BY c.name, s.name`,
    params
  );
  return { class_subjects: rows };
}));

router.post('/class-subjects', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!isUuid(b.subject_id)) throw bad('subject_id must be a UUID', 400);
  await schoolRow(client, req, 'classes', b.class_id, 'Class');
  await schoolRow(client, req, 'subjects', b.subject_id, 'Subject');
  try {
    const { rows } = await client.query(
      `INSERT INTO class_subjects (school_id, class_id, subject_id) VALUES ($1, $2, $3)
       RETURNING id, school_id, class_id, subject_id, created_at`,
      [req.schoolId, b.class_id, b.subject_id]
    );
    return { class_subject: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('That subject is already assigned to this class', 409);
    throw err;
  }
}, 201));

router.delete('/class-subjects/:id', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid id', 400);
  const { rows } = await client.query(
    'DELETE FROM class_subjects WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Assignment not found', 404);
  return { deleted: true };
}));

// ---- Teacher <-> subject <-> class ----

router.get('/teacher-subjects', withSchoolDb(async (req, client) => {
  assertRead(req);
  const params = [req.schoolId];
  let where = 'ts.school_id = $1';
  if (req.query.teacher_user_id !== undefined) {
    if (!isUuid(req.query.teacher_user_id)) throw bad('teacher_user_id must be a UUID', 400);
    params.push(req.query.teacher_user_id);
    where += ` AND ts.teacher_user_id = $${params.length}`;
  }
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND ts.class_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ts.id, ts.school_id, ts.teacher_user_id, u.name AS teacher_name,
            ts.subject_id, s.name AS subject_name,
            ts.class_id, c.name AS class_name, ts.created_at
     FROM teacher_subjects ts
     JOIN users u ON u.id = ts.teacher_user_id
     JOIN subjects s ON s.id = ts.subject_id
     JOIN classes c ON c.id = ts.class_id
     WHERE ${where} ORDER BY u.name, c.name, s.name`,
    params
  );
  return { teacher_subjects: rows };
}));

router.post('/teacher-subjects', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.teacher_user_id)) throw bad('teacher_user_id must be a UUID', 400);
  if (!isUuid(b.subject_id)) throw bad('subject_id must be a UUID', 400);
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  const t = await client.query(
    "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'teacher'",
    [b.teacher_user_id, req.schoolId]
  );
  if (t.rows.length === 0) throw bad('teacher_user_id is not a teacher of this school', 400);
  await schoolRow(client, req, 'subjects', b.subject_id, 'Subject');
  await schoolRow(client, req, 'classes', b.class_id, 'Class');
  try {
    const { rows } = await client.query(
      `INSERT INTO teacher_subjects (school_id, teacher_user_id, subject_id, class_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, school_id, teacher_user_id, subject_id, class_id, created_at`,
      [req.schoolId, b.teacher_user_id, b.subject_id, b.class_id]
    );
    return { teacher_subject: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('That teacher is already assigned to this subject and class', 409);
    throw err;
  }
}, 201));

router.delete('/teacher-subjects/:id', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid id', 400);
  const { rows } = await client.query(
    'DELETE FROM teacher_subjects WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Assignment not found', 404);
  return { deleted: true };
}));

module.exports = router;
