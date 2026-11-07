'use strict';

// School Manager SaaS — staff attendance (Phase 3).
// One row per staff profile per day, same status words as student
// attendance. Bulk marking takes a whole day's sheet in one call.
// Managed by the users:manage capability (school_admin, school_owner,
// hr_manager); the principal may read the sheet.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isUuid, isDateStr } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

const COLS = 'sa.id, sa.school_id, sa.staff_profile_id, sp.full_name AS staff_name, '
  + 'sa.date, sa.status, sa.check_in, sa.check_out, sa.marked_by, sa.created_at, sa.updated_at';
const STATUSES = ['present', 'absent', 'late', 'half_day', 'leave'];
const ALIASES = { P: 'present', A: 'absent', L: 'leave', T: 'late', H: 'half_day' };
const READ_ROLES = ['school_admin', 'school_owner', 'hr_manager', 'principal'];

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeStatus(v) {
  if (typeof v !== 'string') return null;
  if (STATUSES.includes(v)) return v;
  return ALIASES[v] || null;
}

function isTimeStr(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
}

// POST /api/school/staff-attendance/bulk
// { date, entries: [{ staff_profile_id, status, check_in?, check_out? }] }
router.post('/bulk', requireCapability('users:manage'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isDateStr(b.date)) throw bad('date must be YYYY-MM-DD', 400);
  if (!Array.isArray(b.entries) || b.entries.length === 0) {
    throw bad('entries must be a non-empty array', 400);
  }
  const staffRes = await client.query(
    'SELECT id FROM staff_profiles WHERE school_id = $1', [req.schoolId]
  );
  const valid = new Set(staffRes.rows.map((r) => r.id));
  const out = [];
  for (const e of b.entries) {
    if (!e || !isUuid(e.staff_profile_id) || !valid.has(e.staff_profile_id)) {
      throw bad('An entry staff_profile_id does not belong to this school', 400);
    }
    const status = normalizeStatus(e.status);
    if (!status) throw bad(`status must be one of ${STATUSES.join(', ')}`, 400);
    if (e.check_in !== undefined && e.check_in !== null && !isTimeStr(e.check_in)) {
      throw bad('check_in must be HH:MM', 400);
    }
    if (e.check_out !== undefined && e.check_out !== null && !isTimeStr(e.check_out)) {
      throw bad('check_out must be HH:MM', 400);
    }
    const { rows } = await client.query(
      `INSERT INTO staff_attendance (school_id, staff_profile_id, date, status, check_in, check_out, marked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (school_id, staff_profile_id, date)
       DO UPDATE SET status = EXCLUDED.status, check_in = EXCLUDED.check_in,
         check_out = EXCLUDED.check_out, marked_by = EXCLUDED.marked_by, updated_at = now()
       RETURNING id`,
      [req.schoolId, e.staff_profile_id, b.date, status, e.check_in || null, e.check_out || null, req.user.sub]
    );
    out.push(rows[0].id);
  }
  return { marked: out.length };
}, 201));

// GET /api/school/staff-attendance?date=YYYY-MM-DD
router.get('/', withSchoolDb(async (req, client) => {
  if (!READ_ROLES.includes(req.user.role)) throw bad('Forbidden for this role', 403);
  if (!isDateStr(req.query.date)) throw bad('date must be YYYY-MM-DD', 400);
  const { rows } = await client.query(
    `SELECT ${COLS} FROM staff_attendance sa
     JOIN staff_profiles sp ON sp.id = sa.staff_profile_id
     WHERE sa.school_id = $1 AND sa.date = $2 ORDER BY sp.full_name ASC`,
    [req.schoolId, req.query.date]
  );
  return { staff_attendance: rows };
}));

module.exports = router;
