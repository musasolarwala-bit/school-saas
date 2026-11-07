'use strict';

// School Manager SaaS — public (unauthenticated) endpoints (Phase 1).
// GET /api/public/schools/:slug/branding — ONLY the five public
// branding fields, so the login page can wear the school's own name,
// logo and colour before anyone logs in. No phone, no address, no
// session, no counts — nothing private ever leaves through here.
// Unknown or malformed slugs get 404.

const express = require('express');
const { getPgPool } = require('../lib/db');
const { isSlug } = require('../lib/validate');

const router = express.Router();

router.get('/schools/:slug/branding', async (req, res, next) => {
  try {
    if (!isSlug(req.params.slug)) return res.status(404).json({ error: 'School not found' });
    const pool = getPgPool();
    const { rows } = await pool.query(
      'SELECT name, display_name, logo_url, primary_color, tagline FROM schools WHERE slug = $1',
      [req.params.slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'School not found' });
    return res.json({ branding: rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
