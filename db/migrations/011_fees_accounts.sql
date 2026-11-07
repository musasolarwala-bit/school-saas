-- 011_fees_accounts.sql — Phase 3: fee discounts, late-fine settings,
-- generated vouchers, payment method/reference, and the accounts book
-- (expense categories + records, non-fee income).
-- fee_payments.method becomes a real enum; legacy free-text values are
-- normalised first ('Cash' -> 'cash', unknown values -> 'other').

UPDATE fee_payments SET method = 'cash'
  WHERE lower(btrim(method)) = 'cash';
UPDATE fee_payments SET method = 'bank_transfer'
  WHERE lower(btrim(method)) IN ('bank', 'bank transfer', 'bank_transfer', 'banktransfer');
UPDATE fee_payments SET method = 'jazzcash'
  WHERE lower(btrim(method)) = 'jazzcash';
UPDATE fee_payments SET method = 'easypaisa'
  WHERE lower(btrim(method)) = 'easypaisa';
UPDATE fee_payments SET method = 'other'
  WHERE method NOT IN ('cash', 'bank_transfer', 'jazzcash', 'easypaisa', 'other');

ALTER TABLE fee_payments ALTER COLUMN method SET DEFAULT 'cash';
ALTER TABLE fee_payments ADD CONSTRAINT fee_payments_method_check
  CHECK (method IN ('cash', 'bank_transfer', 'jazzcash', 'easypaisa', 'other'));
ALTER TABLE fee_payments ADD COLUMN reference TEXT;

-- Per-student discounts. fee_head_id NULL means "every fee head".
-- kind records WHY (scholarship / sibling / concession / other).
CREATE TABLE student_fee_discounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  fee_head_id UUID REFERENCES fee_heads(id) ON DELETE CASCADE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  value NUMERIC(12, 2) NOT NULL CHECK (value > 0),
  kind TEXT NOT NULL DEFAULT 'concession'
    CHECK (kind IN ('scholarship', 'sibling', 'concession', 'other')),
  reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'percent' OR value <= 100)
);

CREATE INDEX student_fee_discounts_student_idx
  ON student_fee_discounts (school_id, student_id);

-- One settings row per school: how late fines work.
CREATE TABLE school_fee_settings (
  school_id UUID PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  late_fine_type TEXT NOT NULL DEFAULT 'none'
    CHECK (late_fine_type IN ('none', 'flat', 'per_day')),
  late_fine_amount NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (late_fine_amount >= 0),
  late_fine_grace_days INT NOT NULL DEFAULT 0
    CHECK (late_fine_grace_days >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A generated voucher is the snapshot of one student's charge for one
-- plan in one period (YYYY-MM): plan amount minus discount, plus any
-- late fine that already applied at generation time. Payments stay
-- recorded against fee_plans (the ledger); vouchers are the bills.
CREATE TABLE fee_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES fee_plans(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  fine_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  due_date DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, student_id, plan_id, period)
);

CREATE INDEX fee_vouchers_class_period_idx ON fee_vouchers (school_id, period);

-- Accounts: expense categories are per school (defaults are seeded
-- lazily by the API on first use); expense rows snapshot the category
-- name so history survives a category rename/delete.
CREATE TABLE expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE expense_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  category_id UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  spent_on DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX expense_records_school_date_idx ON expense_records (school_id, spent_on);

CREATE TABLE income_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  received_on DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX income_records_school_date_idx ON income_records (school_id, received_on);

ALTER TABLE student_fee_discounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_fee_discounts_tenant_isolation ON student_fee_discounts
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE school_fee_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY school_fee_settings_tenant_isolation ON school_fee_settings
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE fee_vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY fee_vouchers_tenant_isolation ON fee_vouchers
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_categories_tenant_isolation ON expense_categories
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE expense_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_records_tenant_isolation ON expense_records
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE income_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY income_records_tenant_isolation ON income_records
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
