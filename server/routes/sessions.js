'use strict';

// School Manager SaaS — academic sessions (Phase 2).
// A session is a school year (e.g. 2026-27) with optional start/end
// dates. Exactly one session per school is "current"; setting a new
// current session unsets the old one and refreshes the school's
// legacy `session` label (schools.session) so older screens stay
// truthful. Classes carry a session_id (routes/classes.js).
// Reads: classes:read roles + teacher. Writes: classes:write.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isNonEmptyString, isDateStr } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

const SESSION_COLS = 'id, school_id, name, starts_on, ends_on, is_current, created_at';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function setCurrent(client, req, sessionId, name) {
  await client.query(
    'UPDATE sessions SET is_current = false WHERE school_id = $1 AND is_current = true',
    [req.schoolId]
  );
  await client.query(
    'UPDATE sessions SET is_current = true WHERE school_id = $1 AND id = $2',
    [req.schoolId, sessionId]
  );
  await client.query('UPDATE schools SET session = $1 WHERE id = $2', [name, req.schoolId]);
}

router.get('/', withSchoolDb(async (req, client) => {
  if (!can(req.user.role, 'classes:read') && req.user.role !== 'teacher') {
    throw bad('Forbidden for this role', 403);
  }
  const { rows } = await client.query(
    `SELECT ${SESSION_COLS} FROM sessions WHERE school_id = $1 ORDER BY created_at ASC`,
    [req.schoolId]
  );
  return { sessions: rows };
}));

router.post('/', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 100)) throw bad('name is required (e.g. 2026-27)', 400);
  if (b.starts_on !== undefined && b.starts_on !== null && !isDateStr(b.starts_on)) {
    throw bad('starts_on must be YYYY-MM-DD', 400);
  }
  if (b.ends_on !== undefined && b.ends_on !== null && !isDateStr(b.ends_on)) {
    throw bad('ends_on must be YYYY-MM-DD', 400);
  }
  try {
    const { rows } = await client.query(
      `INSERT INTO sessions (school_id, name, starts_on, ends_on, is_current)
       VALUES ($1, $2, $3, $4, false) RETURNING ${SESSION_COLS}`,
      [req.schoolId, b.name.trim(), b.starts_on || null, b.ends_on || null]
    );
    if (b.is_current === true) {
      await setCurrent(client, req, rows[0].id, rows[0].name);
      rows[0].is_current = true;
    }
    return { session: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A session with that name already exists in this school', 409);
    throw err;
  }
}, 201));

router.post('/:id/set-current', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid session id', 400);
  const { rows } = await client.query(
    `SELECT ${SESSION_COLS} FROM sessions WHERE school_id = $1 AND id = $2`,
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Session not found', 404);
  await setCurrent(client, req, rows[0].id, rows[0].name);
  rows[0].is_current = true;
  return { session: rows[0] };
}));

router.patch('/:id', requireCapability('classes:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(req.params.id)) throw bad('Invalid session id', 400);
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  if (b.name !== undefined) {
    if (!isNonEmptyString(b.name, 100)) throw bad('name must be a non-empty string', 400);
    vals.push(b.name.trim());
    sets.push(`name = $${vals.length}`);
  }
  for (const f of ['starts_on', 'ends_on']) {
    if (b[f] !== undefined) {
      if (b[f] !== null && !isDateStr(b[f])) throw bad(`${f} must be YYYY-MM-DD`, 400);
      vals.push(b[f] || null);
      sets.push(`${f} = $${vals.length}`);
    }
  }
  if (sets.length === 0) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE sessions SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING ${SESSION_COLS}`,
      vals
    );
    if (rows.length === 0) throw bad('Session not found', 404);
    return { session: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A session with that name already exists in this school', 409);
    throw err;
  }
}));

module.exports = router;
