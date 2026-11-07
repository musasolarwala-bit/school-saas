'use strict';

// School Manager SaaS — plain PostgreSQL data layer.
// getPgPool(): lazy singleton pg Pool from DATABASE_URL.
// withTenant(pool, tenantId, fn): checks out a client, opens a
//   transaction, sets the tenant session variable the row-level-security
//   policies read (app.tenant_id), runs fn(client), COMMITs on success /
//   ROLLBACKs on error, and always releases the client.
//
// IMPORTANT: the app connects as the database owner on Render, and
// PostgreSQL does NOT apply RLS policies to the table owner. So RLS is
// the second layer (it binds any non-owner connection), while the API
// layer's explicit `WHERE school_id = $1` scoping is the layer that
// binds the app itself. Both layers are tested in tests/run.js.
//
// UUIDs are passed as parameters via set_config() — never interpolated
// into SQL text.

const { Pool, types } = require('pg');
const { databaseUrl } = require('../config');

types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC -> number
types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT  -> number
// DATE (1082): keep the raw 'YYYY-MM-DD' text Postgres sends. pg's
// default converts a DATE to a JS Date at LOCAL midnight; turning it
// back into a string with toISOString() (UTC) then shifts the day
// backwards in any UTC+ timezone (e.g. Asia/Karachi), which silently
// corrupted due dates, attendance dates, leave dates, etc. Returning
// the text makes a stored calendar date round-trip exactly in every
// server timezone. Consumers use dateStr(), which slices strings.
types.setTypeParser(1082, (v) => v);

let pool = null;

// Render's EXTERNAL database URL carries ?sslmode=require; its INTERNAL
// URL (used when the web service and database share a region) does not.
// Enable TLS only when the connection string asks for it, so the same
// code works locally, on Render (internal or external URL) and anywhere
// else. rejectUnauthorized:false is required for managed-Postgres
// certificates, which are not in the default CA bundle.
function poolConfig() {
  const cfg = { connectionString: databaseUrl };
  try {
    const sslmode = new URL(databaseUrl).searchParams.get('sslmode');
    if (sslmode === 'require' || sslmode === 'verify-full' || sslmode === 'verify-ca') {
      cfg.ssl = { rejectUnauthorized: false };
    }
  } catch (_) {
    /* malformed URL: let pg report the real error */
  }
  return cfg;
}

function getPgPool() {
  if (!databaseUrl) return null;
  if (!pool) {
    pool = new Pool(poolConfig());
  }
  return pool;
}

// Run fn(client) inside a transaction with the tenant set as a LOCAL
// session variable (transaction-scoped, so it can never leak to the
// next checkout of the pooled client).
async function withTenant(pool, tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPgPool, withTenant };
