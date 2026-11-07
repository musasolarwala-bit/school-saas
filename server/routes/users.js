'use strict';

// School Manager SaaS — school user management.
// Every route is scoped to the caller's school (requireSchool sets
// req.schoolId and re-checks the school is active) and runs inside a
// tenant transaction (withSchoolDb). A caller can NEVER see or touch
// another school's users: all queries carry school_id = caller.
// Who may manage users is the users:manage capability (Phase 1
// matrix): school_admin, school_owner and hr_manager. Any school role
// except super_admin can be created here (super_admin accounts are
// platform-level and are seeded directly, never via this API).

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { hashPassword } = require('../lib/auth');
const { logAudit } = require('../lib/audit');
const { SCHOOL_ROLES } = require('../lib/permissions');
const { isEmail, isUuid, isNonEmptyString, checkPassword, validate } = require('../lib/validate');

const router = express.Router();
const PUBLIC_USER = 'id, school_id, name, email, role, linked_student_id, linked_teacher_id, active, created_at';
const CREATABLE_ROLES = SCHOOL_ROLES;

router.use(requireAuth, requireSchool, requireCapability('users:manage'));

// List all users of the caller's school (never password hashes).
router.get('/', withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    `SELECT ${PUBLIC_USER} FROM users WHERE school_id = $1 ORDER BY created_at ASC`,
    [req.schoolId]
  );
  return { users: rows };
}));

// Create a staff / parent / student account for this school.
router.post('/', withSchoolDb(async (req, client) => {
  const b = req.body || {};
  const errors = validate([
    [isNonEmptyString(b.name, 200), 'name is required'],
    [isEmail(b.email), 'email must be a valid email'],
    [!checkPassword(b.password), checkPassword(b.password) || ''],
    [CREATABLE_ROLES.includes(b.role), 'role must be a school role (not super_admin)'],
    [b.linked_student_id === undefined || isUuid(b.linked_student_id), 'linked_student_id must be a UUID'],
  ]);
  if (errors.length > 0) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }

  // A linked student must belong to this school.
  if (b.linked_student_id) {
    const s = await client.query(
      'SELECT id FROM students WHERE id = $1 AND school_id = $2',
      [b.linked_student_id, req.schoolId]
    );
    if (s.rows.length === 0) {
      const err = new Error('linked_student_id does not belong to this school');
      err.status = 400;
      throw err;
    }
  }

  const passwordHash = await hashPassword(b.password);
  try {
    const { rows } = await client.query(
      `INSERT INTO users (school_id, name, email, password_hash, role, linked_student_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PUBLIC_USER}`,
      [
        req.schoolId,
        b.name.trim(),
        b.email.trim().toLowerCase(),
        passwordHash,
        b.role,
        b.linked_student_id || null,
      ]
    );
    await logAudit(client, req, 'user.create', 'user', rows[0].id, {
      role: b.role, email: rows[0].email,
    });
    return { user: rows[0] };
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('That email is already used in this school');
      dup.status = 409;
      throw dup;
    }
    throw err;
  }
}, 201));

// Deactivate / reactivate a user of this school (never another school's).
router.patch('/:id', withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(req.params.id)) {
    const err = new Error('Invalid user id');
    err.status = 400;
    throw err;
  }
  if (typeof b.active !== 'boolean' && b.name === undefined) {
    const err = new Error('Nothing to update (send active and/or name)');
    err.status = 400;
    throw err;
  }
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  if (typeof b.active === 'boolean') {
    vals.push(b.active);
    sets.push(`active = $${vals.length}`);
  }
  if (b.name !== undefined) {
    if (!isNonEmptyString(b.name, 200)) {
      const err = new Error('name must be a non-empty string');
      err.status = 400;
      throw err;
    }
    vals.push(b.name.trim());
    sets.push(`name = $${vals.length}`);
  }
  const { rows } = await client.query(
    `UPDATE users SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING ${PUBLIC_USER}`,
    vals
  );
  if (rows.length === 0) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  if (typeof b.active === 'boolean') {
    await logAudit(client, req, b.active ? 'user.activate' : 'user.deactivate', 'user', rows[0].id, {
      email: rows[0].email, role: rows[0].role,
    });
  }
  return { user: rows[0] };
}));

module.exports = router;
