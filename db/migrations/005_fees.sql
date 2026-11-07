-- 005_fees.sql — fee heads, per-class plans, and payments, Stage 2 module 2.
-- Mirrors the offline app: a plan charges one fee head to one class, a
-- student's pending for a plan is plan amount minus payments for that
-- plan, overpayment is rejected by the API (see routes/fees.js), and a
-- plan is overdue when its due date has passed and money is still owed.
-- Receipt numbers are sequential per school (RCPT-000001, ...).

CREATE TABLE fee_heads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE fee_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  fee_head_id UUID NOT NULL REFERENCES fee_heads(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, class_id, fee_head_id)
);

CREATE TABLE fee_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES fee_plans(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'Cash',
  receipt_no TEXT NOT NULL,
  paid_date DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, receipt_no)
);

CREATE INDEX fee_plans_class_idx ON fee_plans (school_id, class_id);
CREATE INDEX fee_payments_student_idx ON fee_payments (school_id, student_id, plan_id);

ALTER TABLE fee_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY fee_heads_tenant_isolation ON fee_heads
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE fee_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY fee_plans_tenant_isolation ON fee_plans
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE fee_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY fee_payments_tenant_isolation ON fee_payments
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
