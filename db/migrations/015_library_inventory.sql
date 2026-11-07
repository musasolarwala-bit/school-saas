-- 015_library_inventory.sql — Phase 6: library books + loans and the
-- school inventory (items, categories, stock movements, condition).
-- copies_available on a book is maintained by the issue/return
-- endpoints in the same transaction as the loan row, so availability
-- can never drift from the loan ledger.

CREATE TABLE library_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  isbn TEXT,
  category TEXT,
  copies_total INT NOT NULL DEFAULT 1 CHECK (copies_total >= 0),
  copies_available INT NOT NULL DEFAULT 1 CHECK (copies_available >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (copies_available <= copies_total)
);

CREATE UNIQUE INDEX library_books_isbn_unique
  ON library_books (school_id, isbn) WHERE isbn IS NOT NULL;

CREATE TABLE library_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  staff_profile_id UUID REFERENCES staff_profiles(id) ON DELETE CASCADE,
  issued_on DATE NOT NULL DEFAULT CURRENT_DATE,
  due_on DATE NOT NULL,
  returned_on DATE,
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (student_id IS NOT NULL OR staff_profile_id IS NOT NULL)
);

CREATE INDEX library_loans_book_idx ON library_loans (school_id, book_id);
CREATE INDEX library_loans_student_idx ON library_loans (school_id, student_id);

CREATE TABLE inventory_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  category_id UUID REFERENCES inventory_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sku TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  min_stock INT NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  location TEXT,
  condition TEXT NOT NULL DEFAULT 'good'
    CHECK (condition IN ('good', 'needs_repair', 'damaged', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inventory_items_sku_unique
  ON inventory_items (school_id, sku) WHERE sku IS NOT NULL;

CREATE INDEX inventory_items_category_idx ON inventory_items (school_id, category_id);

-- Every stock change is a movement row; the item quantity is updated
-- in the same transaction. 'repair' rows carry quantity 0 and only
-- move the item's condition; 'adjust' sets an absolute quantity.
CREATE TABLE inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('in', 'out', 'adjust', 'damage', 'repair')),
  quantity INT NOT NULL DEFAULT 0,
  condition_after TEXT
    CHECK (condition_after IS NULL OR condition_after IN ('good', 'needs_repair', 'damaged', 'retired')),
  note TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX inventory_movements_item_idx ON inventory_movements (school_id, item_id, created_at);

ALTER TABLE library_books ENABLE ROW LEVEL SECURITY;
CREATE POLICY library_books_tenant_isolation ON library_books
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE library_loans ENABLE ROW LEVEL SECURITY;
CREATE POLICY library_loans_tenant_isolation ON library_loans
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE inventory_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_categories_tenant_isolation ON inventory_categories
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_items_tenant_isolation ON inventory_items
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_movements_tenant_isolation ON inventory_movements
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
