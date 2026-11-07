'use strict';

// School Manager SaaS — school settings: branding (Phase 1).
// GET  /api/school/settings/branding — the caller's own school.
// PUT  /api/school/settings/branding — update it (settings:write:
//   school_admin / school_owner only).
// The school is ALWAYS taken from the caller's token — there is no
// school id in the path or body, so one school's admin can never
// touch another school's branding. Runs in the tenant transaction
// like every other school route.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isNonEmptyString, isHexColor } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

const BRANDING_COLS = 'id, name, slug, display_name, logo_url, primary_color, tagline';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.get('/branding', withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    `SELECT ${BRANDING_COLS} FROM schools WHERE id = $1`,
    [req.schoolId]
  );
  if (rows.length === 0) throw bad('School not found', 404);
  return { branding: rows[0] };
}));

router.put('/branding', requireCapability('settings:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  const sets = [];
  const vals = [req.schoolId];
  const nullableString = (field, max) => {
    if (b[field] !== undefined) {
      if (b[field] !== null && !isNonEmptyString(b[field], max)) {
        throw bad(`${field} must be a non-empty string or null`, 400);
      }
      vals.push(b[field] === null ? null : b[field].trim());
      sets.push(`${field} = $${vals.length}`);
    }
  };
  nullableString('display_name', 200);
  nullableString('tagline', 300);
  if (b.logo_url !== undefined) {
    if (b.logo_url !== null) {
      if (!isNonEmptyString(b.logo_url, 1000) || !/^https?:\/\//i.test(b.logo_url.trim())) {
        throw bad('logo_url must be an http(s) URL or null', 400);
      }
      vals.push(b.logo_url.trim());
    } else {
      vals.push(null);
    }
    sets.push(`logo_url = $${vals.length}`);
  }
  if (b.primary_color !== undefined) {
    if (!isHexColor(b.primary_color)) throw bad('primary_color must be a hex color like #1d6fb8', 400);
    vals.push(b.primary_color.toLowerCase());
    sets.push(`primary_color = $${vals.length}`);
  }
  if (sets.length === 0) throw bad('Nothing to update', 400);
  const { rows } = await client.query(
    `UPDATE schools SET ${sets.join(', ')} WHERE id = $1 RETURNING ${BRANDING_COLS}`,
    vals
  );
  if (rows.length === 0) throw bad('School not found', 404);
  return { branding: rows[0] };
}));

module.exports = router;
