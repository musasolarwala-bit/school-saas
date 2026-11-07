-- 003_classes_students.sql — classes and students (Stage 1 core data).
-- classes.teacher_id points at a teacher's USER row (role = 'teacher');
-- Stage 2 may move teacher records to a staff table, but the API
-- contract (teacher sees only their assigned classes' students) stays.

CREATE TABLE classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  section TEXT NOT NULL DEFAULT 'A',
  roll_no TEXT NOT NULL,
  name TEXT NOT NULL,
  guardian_name TEXT,
  guardian_phone TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'left')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, class_id, section, roll_no)
);

-- Now that students exists, link parent/student accounts to records.
ALTER TABLE users
  ADD CONSTRAINT users_linked_student_fk
  FOREIGN KEY (linked_student_id) REFERENCES students(id) ON DELETE SET NULL;

ALTER TABLE classes ENABLE ROW LEVEL SECURITY;

CREATE POLICY classes_tenant_isolation ON classes
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE students ENABLE ROW LEVEL SECURITY;

CREATE POLICY students_tenant_isolation ON students
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
