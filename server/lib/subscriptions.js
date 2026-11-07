'use strict';

// School Manager SaaS — subscription helpers (Phase 1).
// A school's subscription row stores a RAW status (trial / active /
// expired / suspended); the EFFECTIVE status also accounts for the
// clock: a trial or active subscription whose expires_at has passed
// is expired, whatever the stored value says. A NULL expires_at
// (Lifetime, or a not-yet-started row) never expires.
// Enforcement rule (see routes/students.js): an expired or suspended
// subscription blocks CREATING students; logins and reads keep
// working so the school can still see its data and renew.
// student_limit (NULL = unlimited) counts ACTIVE students only — a
// student who left does not consume a seat.

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function effectiveStatus(sub) {
  if (!sub) return null;
  if (sub.status === 'suspended') return 'suspended';
  if (sub.expires_at && new Date(sub.expires_at).getTime() <= Date.now()) {
    return 'expired';
  }
  return sub.status;
}

const SUB_COLS =
  'ss.id, ss.school_id, ss.plan_id, ss.status, ss.starts_at, ss.expires_at, ' +
  'ss.student_limit, ss.created_at, ss.updated_at, p.name AS plan_name';

// The school's current subscription (with plan name), or null.
// db may be a pool or a tenant client — both expose .query().
async function getSubscription(db, schoolId) {
  const { rows } = await db.query(
    `SELECT ${SUB_COLS} FROM school_subscriptions ss
     LEFT JOIN plans p ON p.id = ss.plan_id
     WHERE ss.school_id = $1`,
    [schoolId]
  );
  if (rows.length === 0) return null;
  const sub = rows[0];
  return { ...sub, status: effectiveStatus(sub), stored_status: rows[0].status };
}

// Public shape exposed on GET /api/auth/me: enough for the UI to show
// the school's plan, state and renewal date — nothing more.
function publicSubscription(sub) {
  if (!sub) return null;
  return {
    status: sub.status,
    plan_name: sub.plan_name || null,
    starts_at: sub.starts_at,
    expires_at: sub.expires_at,
    student_limit: sub.student_limit,
  };
}

// Throws 403 when the school may not add another student right now:
// subscription expired/suspended, or the plan's student_limit reached.
// Runs inside the caller's tenant transaction (client).
async function assertCanAddStudent(client, schoolId) {
  const sub = await getSubscription(client, schoolId);
  if (!sub) return; // no subscription row: nothing to enforce (legacy)
  if (sub.status === 'expired') {
    throw bad('This school\'s subscription has expired. Renew it to add new students.', 403);
  }
  if (sub.status === 'suspended') {
    throw bad('This school\'s subscription is suspended. Contact the platform admin.', 403);
  }
  if (sub.student_limit !== null && sub.student_limit !== undefined) {
    const { rows } = await client.query(
      "SELECT COUNT(*)::int AS n FROM students WHERE school_id = $1 AND status = 'active'",
      [schoolId]
    );
    if (rows[0].n >= sub.student_limit) {
      throw bad(
        `Student limit reached: this school's subscription allows ${sub.student_limit} active students. ` +
        'Ask the platform admin to raise the limit.',
        403
      );
    }
  }
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

module.exports = { effectiveStatus, getSubscription, publicSubscription, assertCanAddStudent, addMonths };
