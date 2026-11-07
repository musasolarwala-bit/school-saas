'use strict';

// School Manager SaaS — in-app notifications (Phase 3 foundation).
// Notifications are rows in the notifications table, read via
// /api/school/notifications. NOTHING is sent externally: SMS,
// WhatsApp and email delivery are external dependencies that plug in
// here later (see README, Phase 3 section) — this module is the one
// place that will fan out to them.

// Insert one notification per recipient user id. Runs inside the
// caller's tenant transaction.
async function createNotifications(client, schoolId, userIds, note) {
  for (const userId of userIds) {
    await client.query(
      `INSERT INTO notifications (school_id, user_id, type, title, body, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        schoolId, userId, note.type, note.title, note.body || null,
        note.entityType || null, note.entityId || null,
      ]
    );
  }
}

// When a student's attendance is marked 'present' or 'absent', tell
// every active parent account linked to that student — absence alerts
// and arrival confirmations, per the product spec. Late / half_day /
// leave marks create no notification.
async function notifyParentsOfAttendance(client, schoolId, student, date, status) {
  if (status !== 'absent' && status !== 'present') return;
  const { rows } = await client.query(
    `SELECT id FROM users
     WHERE school_id = $1 AND linked_student_id = $2 AND role = 'parent' AND active = true`,
    [schoolId, student.id]
  );
  if (rows.length === 0) return;
  const note = status === 'absent'
    ? {
      type: 'attendance_absent',
      title: `${student.name} was absent today`,
      body: `${student.name} was marked absent on ${date}. Please contact the school if this is unexpected.`,
    }
    : {
      type: 'attendance_present',
      title: `${student.name} has arrived at school`,
      body: `${student.name} was marked present on ${date}.`,
    };
  await createNotifications(client, schoolId, rows.map((r) => r.id), {
    ...note, entityType: 'student', entityId: student.id,
  });
}

module.exports = { createNotifications, notifyParentsOfAttendance };
