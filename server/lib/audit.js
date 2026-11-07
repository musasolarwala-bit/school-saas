'use strict';

// School Manager SaaS — audit log writer (Phase 8).
// logAudit() runs INSIDE the caller's transaction (tenant or pool),
// so an audit row exists if and only if the change it describes
// committed. actor comes from the JWT (req.user): sub = user id.
// For super-admin (platform) actions the school_id is the TARGET
// school, passed explicitly via logAuditFor().

async function insertAudit(client, schoolId, actor, action, entityType, entityId, meta) {
  await client.query(
    `INSERT INTO audit_log (school_id, actor_user_id, actor_role, action, entity_type, entity_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      schoolId,
      actor && actor.sub ? actor.sub : null,
      actor && actor.role ? actor.role : null,
      action,
      entityType || null,
      entityId || null,
      JSON.stringify(meta || {}),
    ]
  );
}

// Tenant-scoped variant: school = the caller's school (req.schoolId).
async function logAudit(client, req, action, entityType, entityId, meta) {
  return insertAudit(client, req.schoolId, req.user, action, entityType, entityId, meta);
}

// Explicit-school variant (super-admin routes run on the plain pool).
async function logAuditFor(client, schoolId, req, action, entityType, entityId, meta) {
  return insertAudit(client, schoolId, req ? req.user : null, action, entityType, entityId, meta);
}

module.exports = { logAudit, logAuditFor };
