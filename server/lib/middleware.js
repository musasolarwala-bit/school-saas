'use strict';

// School Manager SaaS — request middleware.
// requireAuth: Bearer JWT -> req.user { id, school_id, role, email }.
//   Missing / invalid / expired token -> 401.
// requireRole(...roles): caller must hold one of the roles -> else 403.
// requireSchool: caller must be a school user (not super_admin) whose
//   school is currently active. The school status is re-checked on every
//   request, so suspending a school takes effect even for tokens issued
//   before the suspension (tokens live up to 24h). -> 403 when suspended.
// requireSuperAdmin: caller must be super_admin -> else 403.
// withSchoolDb: runs a handler's DB work inside withTenant() so the
//   tenant session variable is set for every school-scoped query.

const { verifyToken } = require('./auth');
const { getPgPool, withTenant } = require('./db');
const { can } = require('./permissions');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return res.status(401).json({ error: 'Missing or invalid authorization header' });
  try {
    req.user = verifyToken(match[1]);
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden for this role' });
    }
    return next();
  };
}

// requireCapability(cap): caller must hold the capability in the
// role -> capability matrix (lib/permissions.js) -> else 403.
function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.user || !can(req.user.role, capability)) {
      return res.status(403).json({ error: 'Forbidden for this role' });
    }
    return next();
  };
}

async function requireSchool(req, res, next) {
  if (!req.user || !req.user.school_id) {
    return res.status(403).json({ error: 'This route requires a school account' });
  }
  try {
    const pool = getPgPool();
    const { rows } = await pool.query('SELECT status FROM schools WHERE id = $1', [req.user.school_id]);
    if (rows.length === 0) return res.status(403).json({ error: 'School not found' });
    if (rows[0].status !== 'active') {
      return res.status(403).json({ error: 'This school account is suspended' });
    }
    req.schoolId = req.user.school_id;
    return next();
  } catch (err) {
    return next(err);
  }
}

const requireSuperAdmin = requireRole('super_admin');

// Runs fn(client) inside a tenant-scoped transaction for the caller's
// school. Handlers receive the client and return a value; the wrapper
// sends it as JSON unless the handler already sent a response.
// statusCode lets POST routes answer 201 for creations.
function withSchoolDb(handler, statusCode = 200) {
  return async (req, res, next) => {
    try {
      const pool = getPgPool();
      const result = await withTenant(pool, req.schoolId, (client) => handler(req, client));
      if (!res.headersSent && result !== undefined) res.status(statusCode).json(result);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireRole, requireCapability, requireSchool, requireSuperAdmin, withSchoolDb };
