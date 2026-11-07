-- 016_hr_audit.sql — Phases 7+8: staff leave requests, payroll runs
-- (generated from staff_profiles salary structures), and the audit
-- log. Payroll items snapshot basic + allowances at generation time
-- so later salary edits never rewrite an issued payslip. A run is
-- 'draft' until finalized; finalized runs are locked in the routes.

CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_profile_id UUID REFERENCES staff_profiles(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL DEFAULT 'casual'
    CHECK (leave_type IN ('sick', 'casual', 'annual', 'unpaid', 'other')),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (staff_profile_id IS NOT NULL OR user_id IS NOT NULL),
  CHECK (from_date <= to_date)
);

CREATE INDEX leave_requests_school_status_idx ON leave_requests (school_id, status);

CREATE TABLE payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'finalized')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, month)
);

CREATE TABLE payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  staff_profile_id UUID NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  basic NUMERIC(12, 2) NOT NULL DEFAULT 0,
  allowances_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  allowances JSONB NOT NULL DEFAULT '{}'::jsonb,
  deductions NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  net NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, run_id, staff_profile_id)
);

CREATE INDEX payroll_items_run_idx ON payroll_items (school_id, run_id);

-- One row per key write (student create/delete/status, fee payment,
-- user create/deactivate, subscription payment, payroll finalize,
-- result publication, ...). Written inside the same transaction as
-- the change itself, so the log can never claim something that
-- rolled back. meta is a small JSON snapshot of the change.
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_school_time_idx ON audit_log (school_id, created_at DESC);

ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY leave_requests_tenant_isolation ON leave_requests
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_tenant_isolation ON payroll_runs
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_items_tenant_isolation ON payroll_items
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
