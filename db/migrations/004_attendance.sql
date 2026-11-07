-- 004_attendance.sql — daily attendance, Stage 2 module 1.
-- One row per student per day; re-marking the same day updates the
-- row (upsert on the unique key), matching the offline app's behaviour.
-- Statuses mirror the offline app: P = present, A = absent, L = leave.
-- Leave is excluded from the attendance % (see the summary route).

CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('P', 'A', 'L')),
  marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, student_id, date)
);

CREATE INDEX attendance_class_day_idx ON attendance (school_id, class_id, date);

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;

CREATE POLICY attendance_tenant_isolation ON attendance
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
