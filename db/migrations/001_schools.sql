-- 001_schools.sql — one row per school (tenant).
-- A school is the tenant boundary: every other school table carries a
-- school_id pointing here, and tenant isolation keys off that column.

CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  phone TEXT,
  address TEXT,
  session TEXT NOT NULL DEFAULT '2026-27',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row-level security: a connection that is NOT the table owner only
-- ever sees the school matching its app.tenant_id session variable.
-- (The app itself connects as owner on Render, so RLS is the second
-- layer; the API's explicit school_id scoping is the first. Both are
-- tested in tests/run.js.)
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;

CREATE POLICY schools_tenant_isolation ON schools
  FOR ALL
  USING (id::text = current_setting('app.tenant_id', true))
  WITH CHECK (id::text = current_setting('app.tenant_id', true));
