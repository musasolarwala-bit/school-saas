'use strict';

// School Manager SaaS — staff profiles (Phase 2).
// The HR record for teachers and non-teaching staff: contact details,
// qualifications, joining date, department / designation and the
// salary structure (basic + allowances JSON). A profile may link to
// a login user of the same school (users.id) — classes.teacher_id
// keeps pointing at the teacher's USER row, unchanged.
// All routes need the users:manage capability (school_admin,
// school_owner, hr_manager) — staff data is HR data.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isUuid, isNonEmptyString, isDateStr } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('users:manage'));

const STAFF_COLS = 'id, school_id, user_id, full_name, phone, email, cnic, qualifications, '
  + 'experience_years, joining_date, department, designation, salary_basic, salary_allowances, '
  + 'status, created_at, updated_at';
const STAFF_STATUSES = ['active', 'resigned', 'terminated'];

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function assertLinkedUser(client, req, userId) {
  if (!userId) return;
  if (!isUuid(userId)) throw bad('user_id must be a UUID', 400);
  const u = await client.query(
    'SELECT id FROM users WHERE id = $1 AND school_id = $2',
    [userId, req.schoolId]
  );
  if (u.rows.length === 0) throw bad('user_id does not belong to this school', 400);
}

function validateSalary(b) {
  if (b.salary_basic !== undefined) {
    const n = Number(b.salary_basic);
    if (!Number.isFinite(n) || n < 0) throw bad('salary_basic must be a number >= 0', 400);
  }
  if (b.salary_allowances !== undefined) {
    if (typeof b.salary_allowances !== 'object' || b.salary_allowances === null || Array.isArray(b.salary_allowances)) {
      throw bad('salary_allowances must be an object like {"transport": 2000}', 400);
    }
    for (const v of Object.values(b.salary_allowances)) {
      if (!Number.isFinite(Number(v)) || Number(v) < 0) {
        throw bad('salary_allowances values must be numbers >= 0', 400);
      }
    }
  }
}

router.get('/', withSchoolDb(async (req, client) => {
  const q = req.query || {};
  const params = [req.schoolId];
  let where = 'school_id = $1';
  if (q.status) {
    if (!STAFF_STATUSES.includes(q.status)) throw bad('status filter is invalid', 400);
    params.push(q.status);
    where += ` AND status = $${params.length}`;
  }
  if (q.department) {
    params.push(String(q.department).trim());
    where += ` AND department = $${params.length}`;
  }
  if (q.q) {
    params.push(`%${String(q.q).trim()}%`);
    where += ` AND full_name ILIKE $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${STAFF_COLS} FROM staff_profiles WHERE ${where} ORDER BY full_name ASC`,
    params
  );
  return { staff: rows };
}));

router.get('/:id', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid staff id', 400);
  const { rows } = await client.query(
    `SELECT ${STAFF_COLS} FROM staff_profiles WHERE school_id = $1 AND id = $2`,
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Staff profile not found', 404);
  return { staff_member: rows[0] };
}));

router.post('/', withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.full_name, 200)) throw bad('full_name is required', 400);
  if (b.joining_date !== undefined && b.joining_date !== null && !isDateStr(b.joining_date)) {
    throw bad('joining_date must be YYYY-MM-DD', 400);
  }
  if (b.status !== undefined && !STAFF_STATUSES.includes(b.status)) {
    throw bad(`status must be one of ${STAFF_STATUSES.join(', ')}`, 400);
  }
  validateSalary(b);
  await assertLinkedUser(client, req, b.user_id || null);
  try {
    const { rows } = await client.query(
      `INSERT INTO staff_profiles
         (school_id, user_id, full_name, phone, email, cnic, qualifications,
          experience_years, joining_date, department, designation,
          salary_basic, salary_allowances, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${STAFF_COLS}`,
      [
        req.schoolId, b.user_id || null, b.full_name.trim(),
        b.phone || null, b.email || null, b.cnic || null, b.qualifications || null,
        b.experience_years !== undefined ? b.experience_years : null,
        b.joining_date || null, b.department || null, b.designation || null,
        b.salary_basic !== undefined ? Number(b.salary_basic) : 0,
        JSON.stringify(b.salary_allowances || {}),
        b.status || 'active',
      ]
    );
    return { staff_member: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('That user is already linked to a staff profile', 409);
    throw err;
  }
}, 201));

router.patch('/:id', withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(req.params.id)) throw bad('Invalid staff id', 400);
  validateSalary(b);
  if (b.user_id !== undefined) await assertLinkedUser(client, req, b.user_id);
  if (b.status !== undefined && !STAFF_STATUSES.includes(b.status)) {
    throw bad(`status must be one of ${STAFF_STATUSES.join(', ')}`, 400);
  }
  if (b.joining_date !== undefined && b.joining_date !== null && !isDateStr(b.joining_date)) {
    throw bad('joining_date must be YYYY-MM-DD', 400);
  }
  const sets = ['updated_at = now()'];
  const vals = [req.schoolId, req.params.id];
  const set = (field, value) => {
    vals.push(value);
    sets.push(`${field} = $${vals.length}`);
  };
  if (b.full_name !== undefined) {
    if (!isNonEmptyString(b.full_name, 200)) throw bad('full_name must be a non-empty string', 400);
    set('full_name', b.full_name.trim());
  }
  for (const f of ['phone', 'email', 'cnic', 'qualifications', 'department', 'designation']) {
    if (b[f] !== undefined) set(f, b[f] || null);
  }
  if (b.experience_years !== undefined) set('experience_years', b.experience_years);
  if (b.joining_date !== undefined) set('joining_date', b.joining_date || null);
  if (b.user_id !== undefined) set('user_id', b.user_id || null);
  if (b.status !== undefined) set('status', b.status);
  if (b.salary_basic !== undefined) set('salary_basic', Number(b.salary_basic));
  if (b.salary_allowances !== undefined) set('salary_allowances', JSON.stringify(b.salary_allowances));
  if (sets.length === 1) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE staff_profiles SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING ${STAFF_COLS}`,
      vals
    );
    if (rows.length === 0) throw bad('Staff profile not found', 404);
    return { staff_member: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('That user is already linked to a staff profile', 409);
    throw err;
  }
}));

router.delete('/:id', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid staff id', 400);
  const { rows } = await client.query(
    'DELETE FROM staff_profiles WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Staff profile not found', 404);
  return { deleted: true };
}));

module.exports = router;
