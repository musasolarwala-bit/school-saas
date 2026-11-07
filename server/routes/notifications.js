'use strict';

// School Manager SaaS — in-app notifications (Phase 3 foundation).
// A user only ever sees and updates their OWN notifications.
//   GET  /api/school/notifications?unread=1
//   POST /api/school/notifications/:id/read
//   POST /api/school/notifications/read-all
// Delivery is in-app only: no SMS / WhatsApp / email leaves the
// platform (external dependencies — see README).

const express = require('express');
const { requireAuth, requireSchool, withSchoolDb } = require('../lib/middleware');
const { isUuid } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.get('/', withSchoolDb(async (req, client) => {
  const params = [req.schoolId, req.user.sub];
  let where = 'school_id = $1 AND user_id = $2';
  if (req.query.unread === '1' || req.query.unread === 'true') where += ' AND is_read = false';
  const { rows } = await client.query(
    `SELECT id, school_id, user_id, type, title, body, entity_type, entity_id, is_read, created_at
     FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 200`,
    params
  );
  const count = await client.query(
    'SELECT COUNT(*)::int AS n FROM notifications WHERE school_id = $1 AND user_id = $2 AND is_read = false',
    params
  );
  return { notifications: rows, unread_count: count.rows[0].n };
}));

router.post('/read-all', withSchoolDb(async (req, client) => {
  const { rowCount } = await client.query(
    'UPDATE notifications SET is_read = true WHERE school_id = $1 AND user_id = $2 AND is_read = false',
    [req.schoolId, req.user.sub]
  );
  return { updated: rowCount };
}));

router.post('/:id/read', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid notification id', 400);
  const { rows } = await client.query(
    `UPDATE notifications SET is_read = true
     WHERE school_id = $1 AND user_id = $2 AND id = $3 RETURNING id`,
    [req.schoolId, req.user.sub, req.params.id]
  );
  if (rows.length === 0) throw bad('Notification not found', 404);
  return { updated: true };
}));

module.exports = router;
