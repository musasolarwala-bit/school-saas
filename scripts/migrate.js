'use strict';

// School Manager SaaS — migration runner.
//   npm run migrate
// Applies db/migrations/*.sql in filename order, tracking each applied
// file in schema_migrations so re-runs are safe (idempotent). Each
// migration runs in its own transaction.

const fs = require('fs');
const path = require('path');
const { getPgPool } = require('../server/lib/db');
const { requireConfig } = require('../server/config');

async function main() {
  requireConfig();
  const pool = getPgPool();
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${file}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.end();
  console.log('migrations done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
