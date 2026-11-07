'use strict';

// School Manager SaaS — class routes.
// Visibility: roles holding classes:read (school_admin, school_owner,
// principal, transport_manager, librarian, receptionist) see all
// classes of their school; a teacher sees only classes assigned to
// them (classes.teacher_id = their user id); parents/students may not
// list classes (they reach their class through their own student
// record). Writes need the classes:write capability (school_admin /
// school_owner), always scoped to the caller's school.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { teacherClassIds } = require('../lib/scope');
const { isUuid, isNonEmptyString } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

const CLASS_COLS = 'id, school_id, name, teacher_id, session_id, created_at';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.get('/', withSchoolDb(async (req, client) => {
  if (req.user.role === 'teacher') {
    // Assigned classes = class teacher of, plus classes they teach a
    // subject in (Phase 2, lib/scope.js).
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    if (ids.length === 0) return { classes: [] };
    const { rows } = await client.query(
      `SELECT ${CLASS_COLS} FROM classes WHERE school_id = $1 AND id = ANY($2) ORDER BY name ASC`,
      [req.schoolId, ids]
    );
    return { classes: rows };
  }
  if (can(req.user.role, 'classes:read')) {
    const { rows } = await client.query(
      `SELECT ${CLASS_COLS} FROM classes WHERE school_id = $1 ORDER BY name ASC`,
      [req.schoolId]
    );
    return { classes: rows };
  }
  throw bad('Forbidden for this role', 403);
}));

router.post('/', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  if (b.teacher_id !== undefined && b.teacher_id !== null && !isUuid(b.teacher_id)) {
    throw bad('teacher_id must be a UUID', 400);
  }
  if (b.teacher_id) {
    const t = await client.query(
      "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'teacher'",
      [b.teacher_id, req.schoolId]
    );
    if (t.rows.length === 0) throw bad('teacher_id is not a teacher of this school', 400);
  }
  if (b.session_id !== undefined && b.session_id !== null) {
    if (!isUuid(b.session_id)) throw bad('session_id must be a UUID', 400);
    const s = await client.query(
      'SELECT id FROM sessions WHERE id = $1 AND school_id = $2',
      [b.session_id, req.schoolId]
    );
    if (s.rows.length === 0) throw bad('session_id does not belong to this school', 400);
  }
  try {
    const { rows } = await client.query(
      `INSERT INTO classes (school_id, name, teacher_id, session_id) VALUES ($1, $2, $3, $4) RETURNING ${CLASS_COLS}`,
      [req.schoolId, b.name.trim(), b.teacher_id || null, b.session_id || null]
    );
    return { class: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A class with that name already exists in this school', 409);
    throw err;
  }
}, 201));

router.patch('/:id', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(req.params.id)) throw bad('Invalid class id', 400);
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  if (b.name !== undefined) {
    if (!isNonEmptyString(b.name, 200)) throw bad('name must be a non-empty string', 400);
    vals.push(b.name.trim());
    sets.push(`name = $${vals.length}`);
  }
  if (b.teacher_id !== undefined) {
    if (b.teacher_id !== null && !isUuid(b.teacher_id)) throw bad('teacher_id must be a UUID', 400);
    if (b.teacher_id) {
      const t = await client.query(
        "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'teacher'",
        [b.teacher_id, req.schoolId]
      );
      if (t.rows.length === 0) throw bad('teacher_id is not a teacher of this school', 400);
    }
    vals.push(b.teacher_id);
    sets.push(`teacher_id = $${vals.length}`);
  }
  if (b.session_id !== undefined) {
    if (b.session_id !== null && !isUuid(b.session_id)) throw bad('session_id must be a UUID', 400);
    if (b.session_id) {
      const s = await client.query(
        'SELECT id FROM sessions WHERE id = $1 AND school_id = $2',
        [b.session_id, req.schoolId]
      );
      if (s.rows.length === 0) throw bad('session_id does not belong to this school', 400);
    }
    vals.push(b.session_id);
    sets.push(`session_id = $${vals.length}`);
  }
  if (sets.length === 0) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE classes SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING ${CLASS_COLS}`,
      vals
    );
    if (rows.length === 0) throw bad('Class not found', 404);
    return { class: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A class with that name already exists in this school', 409);
    throw err;
  }
}));

router.delete('/:id', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid class id', 400);
  const students = await client.query(
    'SELECT COUNT(*)::int AS n FROM students WHERE school_id = $1 AND class_id = $2',
    [req.schoolId, req.params.id]
  );
  if (students.rows[0].n > 0) {
    throw bad('Cannot delete a class that still has students', 409);
  }
  const { rows } = await client.query(
    'DELETE FROM classes WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Class not found', 404);
  return { deleted: true };
}));

module.exports = router;
