'use strict';

// School Manager SaaS — auth routes.
// POST /api/auth/register-school — creates a school + its first
//   school_admin in ONE transaction (atomic: a failed registration
//   leaves no orphan school or admin behind).
// POST /api/auth/login — school users log in with { slug, email,
//   password }; a super_admin logs in with { email, password } and no
//   slug. Suspended schools and inactive users get 403.
// GET  /api/auth/me — current user + school (school users only).

const express = require('express');
const { getPgPool } = require('../lib/db');
const { hashPassword, verifyPassword, signToken } = require('../lib/auth');
const { requireAuth } = require('../lib/middleware');
const { getSubscription, publicSubscription } = require('../lib/subscriptions');
const { isEmail, isSlug, isNonEmptyString, checkPassword, validate } = require('../lib/validate');

const router = express.Router();

const PUBLIC_USER = 'id, school_id, name, email, role, active, created_at';

router.post('/register-school', async (req, res, next) => {
  const b = req.body || {};
  const errors = validate([
    [isNonEmptyString(b.school_name, 200), 'school_name is required'],
    [isSlug(b.slug), 'slug must be lowercase letters, digits and dashes (3-64 chars)'],
    [isNonEmptyString(b.admin_name, 200), 'admin_name is required'],
    [isEmail(b.admin_email), 'admin_email must be a valid email'],
    [!checkPassword(b.admin_password), checkPassword(b.admin_password) || ''],
  ]);
  if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schoolRes = await client.query(
      `INSERT INTO schools (name, slug, phone, address, session)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, slug, phone, address, session, status, created_at, display_name, logo_url, primary_color, tagline`,
      [b.school_name.trim(), b.slug, b.phone || null, b.address || null, b.session || '2026-27']
    );
    const school = schoolRes.rows[0];
    const passwordHash = await hashPassword(b.admin_password);
    const userRes = await client.query(
      `INSERT INTO users (school_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'school_admin')
       RETURNING ${PUBLIC_USER}`,
      [school.id, b.admin_name.trim(), b.admin_email.trim().toLowerCase(), passwordHash]
    );
    // Every new school starts on a 30-day free trial (Phase 1):
    // no plan, no student limit, expiry 30 days out.
    await client.query(
      `INSERT INTO school_subscriptions (school_id, status, starts_at, expires_at)
       VALUES ($1, 'trial', now(), now() + interval '30 days')`,
      [school.id]
    );
    // Phase 2: seed the school's first academic session as current
    // (migration 009 backfills schools that predate it; schools
    // registered afterwards are seeded here).
    await client.query(
      `INSERT INTO sessions (school_id, name, is_current) VALUES ($1, $2, true)
       ON CONFLICT (school_id, name) DO NOTHING`,
      [school.id, school.session]
    );
    await client.query('COMMIT');
    const user = userRes.rows[0];
    return res.status(201).json({
      school,
      user,
      token: signToken(user),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That school slug is already taken' });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post('/login', async (req, res, next) => {
  const b = req.body || {};
  const errors = validate([
    [isEmail(b.email), 'email must be a valid email'],
    [isNonEmptyString(b.password), 'password is required'],
    [b.slug === undefined || isSlug(b.slug), 'slug is invalid'],
  ]);
  if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

  try {
    const pool = getPgPool();
    const email = b.email.trim().toLowerCase();
    let user = null;
    let school = null;

    if (b.slug) {
      const s = await pool.query('SELECT * FROM schools WHERE slug = $1', [b.slug]);
      if (s.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
      school = s.rows[0];
      if (school.status !== 'active') {
        return res.status(403).json({ error: 'This school account is suspended' });
      }
      const u = await pool.query(
        'SELECT * FROM users WHERE school_id = $1 AND email = $2',
        [school.id, email]
      );
      user = u.rows[0] || null;
    } else {
      // No slug: only a super_admin (school_id NULL) may log in this way.
      const u = await pool.query(
        "SELECT * FROM users WHERE school_id IS NULL AND role = 'super_admin' AND email = $1",
        [email]
      );
      user = u.rows[0] || null;
    }

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.active) return res.status(403).json({ error: 'This account is deactivated' });
    const ok = await verifyPassword(b.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const pub = {
      id: user.id,
      school_id: user.school_id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      created_at: user.created_at,
    };
    return res.json({ user: pub, school, token: signToken(user) });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const u = await pool.query(`SELECT ${PUBLIC_USER} FROM users WHERE id = $1`, [req.user.sub]);
    if (u.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    const user = u.rows[0];
    let school = null;
    let subscription = null;
    if (user.school_id) {
      const s = await pool.query(
        'SELECT id, name, slug, phone, address, session, status, created_at, display_name, logo_url, primary_color, tagline FROM schools WHERE id = $1',
        [user.school_id]
      );
      school = s.rows[0] || null;
      // Phase 1: expose the subscription state so the UI can show the
      // plan, its status and the renewal date (and warn before expiry).
      subscription = publicSubscription(await getSubscription(pool, user.school_id));
    }
    return res.json({ user, school, subscription });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
