-- 013_learning.sql — Phase 5: homework (+ submissions) and the class
-- timetable. Submissions are created for every active student of the
-- class when homework is assigned (status 'pending'); the submit /
-- check flow then moves them forward. Timetable conflicts (same
-- class + weekday + period) are blocked by the UNIQUE constraint;
-- teacher / room double-booking is checked in the route so it can
-- answer with a clear 409 message.

CREATE TABLE homework (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  teacher_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX homework_class_idx ON homework (school_id, class_id, due_date);

CREATE TABLE homework_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  homework_id UUID NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'late', 'checked')),
  submitted_at TIMESTAMPTZ,
  note TEXT,
  feedback TEXT,
  checked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, homework_id, student_id)
);

CREATE INDEX homework_submissions_student_idx
  ON homework_submissions (school_id, student_id, status);

CREATE TABLE timetable_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  teacher_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  weekday INT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  period_no INT NOT NULL CHECK (period_no > 0),
  starts_at TIME,
  ends_at TIME,
  room TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, class_id, weekday, period_no),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);

CREATE INDEX timetable_teacher_idx
  ON timetable_slots (school_id, teacher_user_id, weekday);

ALTER TABLE homework ENABLE ROW LEVEL SECURITY;
CREATE POLICY homework_tenant_isolation ON homework
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE homework_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY homework_submissions_tenant_isolation ON homework_submissions
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE timetable_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY timetable_slots_tenant_isolation ON timetable_slots
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
