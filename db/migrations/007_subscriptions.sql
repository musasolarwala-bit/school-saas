-- 007_subscriptions.sql — Phase 1: subscription packages + per-school
-- subscriptions + payment history.
-- Pricing is BY DURATION (decided 2026-11-07, supersedes monthly
-- tiers): a package is a period of service for a single price.
-- period_months NULL means Lifetime — the subscription never expires
-- (expires_at stays NULL).
-- One CURRENT subscription row per school (UNIQUE school_id); the
-- payment history lives in subscription_payments. student_limit lives
-- on the subscription (NOT the plan): NULL = unlimited, and it only
-- bites when the super admin sets a value.
-- plans is a PLATFORM table (no school_id): only super-admin routes
-- touch it, so it carries no tenant RLS policy. The two school tables
-- follow the same RLS pattern as every other school table.

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  price_pkr NUMERIC(12, 2) NOT NULL CHECK (price_pkr > 0),
  period_months INT CHECK (period_months IS NULL OR period_months > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plans (name, price_pkr, period_months) VALUES
  ('12 Months', 5000, 12),
  ('24 Months', 8000, 24),
  ('36 Months', 12000, 36),
  ('Lifetime', 20000, NULL);

CREATE TABLE school_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL UNIQUE REFERENCES schools(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'trial'
    CHECK (status IN ('trial', 'active', 'expired', 'suspended')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  student_limit INT CHECK (student_limit IS NULL OR student_limit >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'Cash',
  -- Snapshot of the plan's period at payment time (plans are editable;
  -- NULL = Lifetime), so history stays true even if the plan changes.
  period_months INT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscription_payments_school_idx ON subscription_payments (school_id, created_at);

-- Schools registered before this migration get the standard 30-day
-- free trial, so every school always has exactly one subscription row.
INSERT INTO school_subscriptions (school_id, status, starts_at, expires_at)
SELECT id, 'trial', now(), now() + interval '30 days' FROM schools
ON CONFLICT (school_id) DO NOTHING;

ALTER TABLE school_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY school_subscriptions_tenant_isolation ON school_subscriptions
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_payments_tenant_isolation ON subscription_payments
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
