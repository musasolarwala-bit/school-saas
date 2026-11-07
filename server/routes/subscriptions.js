'use strict';

// School Manager SaaS — super-admin subscription routes (Phase 1).
// Mounted at /api/admin next to routes/schools.js; only super_admin
// may call these. Like schools.js they run on the plain pool (a
// super_admin manages ALL schools; no tenant variable is set).
//
// Packages are DURATION packages: price_pkr buys period_months of
// service; period_months NULL = Lifetime (never expires).
//   POST   /api/admin/plans                              create
//   GET    /api/admin/plans                              list
//   PATCH  /api/admin/plans/:id                          edit
//   DELETE /api/admin/plans/:id                          remove (409 when in use)
//   GET    /api/admin/subscriptions                      every school's current subscription
//   GET    /api/admin/schools/:id/subscription           one school's subscription
//   POST   /api/admin/schools/:id/subscription/assign    { plan_id } — (re)start a plan from now
//   POST   /api/admin/schools/:id/subscription/payment   { plan_id, amount?, method?, notes? }
//   PATCH  /api/admin/schools/:id/subscription           { student_limit } — null = unlimited
//
// Recording a payment extends the school's expiry by the plan's
// period, counting from the LATER of now and the current expiry (a
// school that renews early never loses paid time). A Lifetime payment
// clears the expiry entirely. Assigning a plan restarts its period
// from now without recording a payment.

const express = require('express');
const { getPgPool } = require('../lib/db');
const { requireAuth, requireSuperAdmin } = require('../lib/middleware');
const { isUuid, isNonEmptyString } = require('../lib/validate');
const { effectiveStatus, addMonths } = require('../lib/subscriptions');
const { logAuditFor } = require('../lib/audit');

const router = express.Router();

router.use(requireAuth, requireSuperAdmin);

const PLAN_COLS = 'id, name, price_pkr, period_months, is_active, created_at, updated_at';
const SUB_JOIN =
  'ss.id, ss.school_id, ss.plan_id, ss.status, ss.starts_at, ss.expires_at, ' +
  'ss.student_limit, ss.created_at, ss.updated_at, p.name AS plan_name, s.name AS school_name, s.slug AS school_slug';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isPositiveAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function isPeriod(v) {
  return v === null || (Number.isInteger(v) && v > 0);
}

async function schoolExists(pool, schoolId) {
  const { rows } = await pool.query('SELECT id FROM schools WHERE id = $1', [schoolId]);
  return rows.length > 0;
}

async function loadSubscription(pool, schoolId) {
  const { rows } = await pool.query(
    `SELECT ${SUB_JOIN} FROM school_subscriptions ss
     LEFT JOIN plans p ON p.id = ss.plan_id
     JOIN schools s ON s.id = ss.school_id
     WHERE ss.school_id = $1`,
    [schoolId]
  );
  if (rows.length === 0) return null;
  return { ...rows[0], stored_status: rows[0].status, status: effectiveStatus(rows[0]) };
}

// ---- Plans ----

router.get('/plans', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT ${PLAN_COLS} FROM plans ORDER BY period_months NULLS LAST, price_pkr ASC`
    );
    return res.json({ plans: rows });
  } catch (err) {
    return next(err);
  }
});

router.post('/plans', async (req, res, next) => {
  const b = req.body || {};
  try {
    if (!isNonEmptyString(b.name, 100)) throw bad('name is required', 400);
    if (!isPositiveAmount(b.price_pkr)) throw bad('price_pkr must be greater than 0', 400);
    if (b.period_months !== undefined && !isPeriod(b.period_months)) {
      throw bad('period_months must be a positive whole number, or null for Lifetime', 400);
    }
    if (b.is_active !== undefined && typeof b.is_active !== 'boolean') {
      throw bad('is_active must be a boolean', 400);
    }
    const pool = getPgPool();
    const { rows } = await pool.query(
      `INSERT INTO plans (name, price_pkr, period_months, is_active)
       VALUES ($1, $2, $3, $4) RETURNING ${PLAN_COLS}`,
      [b.name.trim(), b.price_pkr, b.period_months === undefined ? null : b.period_months, b.is_active !== false]
    );
    return res.status(201).json({ plan: rows[0] });
  } catch (err) {
    if (err.code === '23505') return next(bad('A plan with that name already exists', 409));
    return next(err);
  }
});

router.patch('/plans/:id', async (req, res, next) => {
  const b = req.body || {};
  try {
    if (!isUuid(req.params.id)) throw bad('Invalid plan id', 400);
    const sets = [];
    const vals = [req.params.id];
    if (b.name !== undefined) {
      if (!isNonEmptyString(b.name, 100)) throw bad('name must be a non-empty string', 400);
      vals.push(b.name.trim());
      sets.push(`name = $${vals.length}`);
    }
    if (b.price_pkr !== undefined) {
      if (!isPositiveAmount(b.price_pkr)) throw bad('price_pkr must be greater than 0', 400);
      vals.push(b.price_pkr);
      sets.push(`price_pkr = $${vals.length}`);
    }
    if (b.period_months !== undefined) {
      if (!isPeriod(b.period_months)) {
        throw bad('period_months must be a positive whole number, or null for Lifetime', 400);
      }
      vals.push(b.period_months);
      sets.push(`period_months = $${vals.length}`);
    }
    if (b.is_active !== undefined) {
      if (typeof b.is_active !== 'boolean') throw bad('is_active must be a boolean', 400);
      vals.push(b.is_active);
      sets.push(`is_active = $${vals.length}`);
    }
    if (sets.length === 0) throw bad('Nothing to update', 400);
    sets.push('updated_at = now()');
    const pool = getPgPool();
    const { rows } = await pool.query(
      `UPDATE plans SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PLAN_COLS}`,
      vals
    );
    if (rows.length === 0) throw bad('Plan not found', 404);
    return res.json({ plan: rows[0] });
  } catch (err) {
    if (err.code === '23505') return next(bad('A plan with that name already exists', 409));
    return next(err);
  }
});

router.delete('/plans/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw bad('Invalid plan id', 400);
    const pool = getPgPool();
    const payments = await pool.query(
      'SELECT COUNT(*)::int AS n FROM subscription_payments WHERE plan_id = $1',
      [req.params.id]
    );
    if (payments.rows[0].n > 0) {
      throw bad('This plan has recorded payments and cannot be deleted; deactivate it instead', 409);
    }
    const current = await pool.query(
      'SELECT COUNT(*)::int AS n FROM school_subscriptions WHERE plan_id = $1',
      [req.params.id]
    );
    if (current.rows[0].n > 0) {
      throw bad('This plan is assigned to a school and cannot be deleted; deactivate it instead', 409);
    }
    const { rows } = await pool.query('DELETE FROM plans WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) throw bad('Plan not found', 404);
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

// ---- Subscriptions ----

router.get('/subscriptions', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT ${SUB_JOIN} FROM school_subscriptions ss
       LEFT JOIN plans p ON p.id = ss.plan_id
       JOIN schools s ON s.id = ss.school_id
       ORDER BY s.created_at ASC`
    );
    const subs = rows.map((r) => ({ ...r, stored_status: r.status, status: effectiveStatus(r) }));
    return res.json({ subscriptions: subs });
  } catch (err) {
    return next(err);
  }
});

router.get('/schools/:id/subscription', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw bad('Invalid school id', 400);
    const pool = getPgPool();
    if (!(await schoolExists(pool, req.params.id))) throw bad('School not found', 404);
    const sub = await loadSubscription(pool, req.params.id);
    return res.json({ subscription: sub });
  } catch (err) {
    return next(err);
  }
});

// Upsert the school's subscription row with the given field values.
async function saveSubscription(pool, schoolId, fields) {
  const { rows } = await pool.query(
    `INSERT INTO school_subscriptions (school_id, plan_id, status, starts_at, expires_at, student_limit)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (school_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id, status = EXCLUDED.status,
       starts_at = EXCLUDED.starts_at, expires_at = EXCLUDED.expires_at,
       student_limit = COALESCE(school_subscriptions.student_limit, EXCLUDED.student_limit),
       updated_at = now()
     RETURNING id`,
    [
      schoolId,
      fields.plan_id,
      fields.status,
      fields.starts_at,
      fields.expires_at,
      fields.student_limit === undefined ? null : fields.student_limit,
    ]
  );
  return rows[0].id;
}

async function loadPlan(pool, planId) {
  const { rows } = await pool.query(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1`, [planId]);
  return rows.length > 0 ? rows[0] : null;
}

router.post('/schools/:id/subscription/assign', async (req, res, next) => {
  const b = req.body || {};
  try {
    if (!isUuid(req.params.id)) throw bad('Invalid school id', 400);
    if (!isUuid(b.plan_id)) throw bad('plan_id must be a UUID', 400);
    const pool = getPgPool();
    if (!(await schoolExists(pool, req.params.id))) throw bad('School not found', 404);
    const plan = await loadPlan(pool, b.plan_id);
    if (!plan) throw bad('Plan not found', 404);
    if (!plan.is_active) throw bad('This plan is not active', 400);
    const now = new Date();
    await saveSubscription(pool, req.params.id, {
      plan_id: plan.id,
      status: 'active',
      starts_at: now,
      expires_at: plan.period_months === null ? null : addMonths(now, plan.period_months),
    });
    const sub = await loadSubscription(pool, req.params.id);
    return res.json({ subscription: sub });
  } catch (err) {
    return next(err);
  }
});

router.post('/schools/:id/subscription/payment', async (req, res, next) => {
  const b = req.body || {};
  try {
    if (!isUuid(req.params.id)) throw bad('Invalid school id', 400);
    if (!isUuid(b.plan_id)) throw bad('plan_id must be a UUID', 400);
    if (b.amount !== undefined && !isPositiveAmount(b.amount)) {
      throw bad('amount must be greater than 0', 400);
    }
    if (b.method !== undefined && b.method !== null && !isNonEmptyString(b.method, 100)) {
      throw bad('method must be a non-empty string', 400);
    }
    if (b.notes !== undefined && b.notes !== null && !isNonEmptyString(b.notes, 1000)) {
      throw bad('notes must be a non-empty string', 400);
    }
    const pool = getPgPool();
    if (!(await schoolExists(pool, req.params.id))) throw bad('School not found', 404);
    const plan = await loadPlan(pool, b.plan_id);
    if (!plan) throw bad('Plan not found', 404);
    if (!plan.is_active) throw bad('This plan is not active', 400);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await loadSubscription(client, req.params.id);
      const now = new Date();
      let expiresAt = null;
      if (plan.period_months !== null) {
        // Renew from the later of now / current expiry: early renewal
        // never loses paid time. A current Lifetime (NULL expiry with
        // an active paid plan) is replaced by the finite plan's term.
        const base = cur && cur.expires_at && new Date(cur.expires_at) > now
          ? new Date(cur.expires_at)
          : now;
        expiresAt = addMonths(base, plan.period_months);
      }
      await saveSubscription(client, req.params.id, {
        plan_id: plan.id,
        status: 'active',
        starts_at: cur ? cur.starts_at : now,
        expires_at: expiresAt,
      });
      const pay = await client.query(
        `INSERT INTO subscription_payments
           (school_id, plan_id, amount, method, period_months, recorded_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, school_id, plan_id, amount, method, period_months, recorded_by, notes, created_at`,
        [
          req.params.id,
          plan.id,
          b.amount !== undefined ? b.amount : plan.price_pkr,
          b.method ? b.method.trim() : 'Cash',
          plan.period_months,
          req.user.sub,
          b.notes || null,
        ]
      );
      await logAuditFor(client, req.params.id, req, 'subscription.payment', 'subscription_payment', pay.rows[0].id, {
        plan_id: plan.id, plan_name: plan.name,
        amount: Number(b.amount !== undefined ? b.amount : plan.price_pkr),
      });
      await client.query('COMMIT');
      const sub = await loadSubscription(pool, req.params.id);
      return res.status(201).json({ subscription: sub, payment: pay.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

router.patch('/schools/:id/subscription', async (req, res, next) => {
  const b = req.body || {};
  try {
    if (!isUuid(req.params.id)) throw bad('Invalid school id', 400);
    if (b.student_limit === undefined) throw bad('Nothing to update (send student_limit)', 400);
    if (b.student_limit !== null && (!Number.isInteger(b.student_limit) || b.student_limit < 0)) {
      throw bad('student_limit must be null (unlimited) or a whole number >= 0', 400);
    }
    const pool = getPgPool();
    if (!(await schoolExists(pool, req.params.id))) throw bad('School not found', 404);
    await pool.query(
      `INSERT INTO school_subscriptions (school_id, status, student_limit)
       VALUES ($1, 'trial', $2)
       ON CONFLICT (school_id) DO UPDATE SET student_limit = EXCLUDED.student_limit, updated_at = now()`,
      [req.params.id, b.student_limit]
    );
    const sub = await loadSubscription(pool, req.params.id);
    return res.json({ subscription: sub });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
