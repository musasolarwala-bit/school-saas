'use strict';

// School Manager SaaS — super-admin routes.
// Only role super_admin may call these (school_id NULL). They run on
// the plain pool (no tenant variable): a super_admin manages ALL
// schools, and school rows are never filtered for them.

const express = require('express');
const { getPgPool } = require('../lib/db');
const { requireAuth, requireSuperAdmin } = require('../lib/middleware');
const { isUuid } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSuperAdmin);

// List every school with its user count and status.
router.get('/schools', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const { rows } = await pool.query(`
      SELECT s.id, s.name, s.slug, s.phone, s.address, s.session, s.status, s.created_at,
             COUNT(u.id)::int AS user_count
      FROM schools s
      LEFT JOIN users u ON u.school_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at ASC
    `);
    return res.json({ schools: rows });
  } catch (err) {
    return next(err);
  }
});

async function setSchoolStatus(req, res, next, status) {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid school id' });
  try {
    const pool = getPgPool();
    const { rows } = await pool.query(
      'UPDATE schools SET status = $1 WHERE id = $2 RETURNING id, name, slug, status',
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'School not found' });
    return res.json({ school: rows[0] });
  } catch (err) {
    return next(err);
  }
}

// Suspend: logins for this school immediately get 403 (requireSchool
// re-checks status on every request), even for tokens issued earlier.
router.post('/schools/:id/suspend', (req, res, next) => setSchoolStatus(req, res, next, 'suspended'));
router.post('/schools/:id/activate', (req, res, next) => setSchoolStatus(req, res, next, 'active'));

module.exports = router;
