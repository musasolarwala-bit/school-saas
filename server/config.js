'use strict';

// School Manager SaaS — environment configuration.
// Fail fast when a required variable is missing: a server that boots
// without a database URL or JWT secret would fail in confusing ways.

const databaseUrl = process.env.DATABASE_URL || '';
const jwtSecret = process.env.JWT_SECRET || '';
const port = parseInt(process.env.PORT || '3000', 10);

function requireConfig() {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!jwtSecret) throw new Error('JWT_SECRET is not set');
}

module.exports = { databaseUrl, jwtSecret, port, requireConfig };
