-- 009_students_academic.sql — Phase 2: richer student records, student
-- history + documents, staff profiles, academic sessions, subjects.
-- Students gain an auto admission number (ADM-<year>-<seq>, unique per
-- school), photo / emergency-contact / previous-school / medical fields,
-- and two more lifecycle statuses (graduated, transferred).
-- Every new school table follows the standard RLS pattern.

ALTER TABLE students ADD COLUMN admission_number TEXT;
ALTER TABLE students ADD COLUMN admission_seq INT;
ALTER TABLE students ADD COLUMN photo_url TEXT;
ALTER TABLE students ADD COLUMN emergency_contact_name TEXT;
ALTER TABLE students ADD COLUMN emergency_contact_phone TEXT;
ALTER TABLE students ADD COLUMN previous_school TEXT;
ALTER TABLE students ADD COLUMN medical_notes TEXT;

ALTER TABLE students DROP CONSTRAINT IF EXISTS students_status_check;
ALTER TABLE students ADD CONSTRAINT students_status_check
  CHECK (status IN ('active', 'left', 'graduated', 'transferred'));

CREATE UNIQUE INDEX students_admission_number_unique
  ON students (school_id, admission_number)
  WHERE admission_number IS NOT NULL;

-- Backfill admission numbers for students that already exist, in
-- admission (creation) order per school.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY school_id ORDER BY created_at, id) AS rn,
         EXTRACT(YEAR FROM created_at)::int AS yr
  FROM students
)
UPDATE students s
SET admission_seq = n.rn,
    admission_number = 'ADM-' || n.yr || '-' || LPAD(n.rn::text, 4, '0')
FROM numbered n
WHERE n.id = s.id;

-- Lifecycle events: admission, promotion, transfers, withdrawal,
-- graduation, and generic status / class changes.
CREATE TABLE student_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN (
    'admission', 'promotion', 'transfer_in', 'transfer_out',
    'withdrawal', 'graduation', 'status_change', 'class_change'
  )),
  from_class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  to_class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX student_history_student_idx ON student_history (school_id, student_id, created_at);

INSERT INTO student_history (school_id, student_id, event, to_class_id, to_status)
SELECT school_id, id, 'admission', class_id, status FROM students;

CREATE TABLE student_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'other',
  url TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX student_documents_student_idx ON student_documents (school_id, student_id);

-- Staff records (teachers and non-teaching staff). A profile may link
-- to a login user (users.id); classes.teacher_id keeps pointing at the
-- teacher's USER row, as before — the profile is the HR record.
CREATE TABLE staff_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  cnic TEXT,
  qualifications TEXT,
  experience_years INT CHECK (experience_years IS NULL OR experience_years >= 0),
  joining_date DATE,
  department TEXT,
  designation TEXT,
  salary_basic NUMERIC(12, 2) NOT NULL DEFAULT 0,
  salary_allowances JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resigned', 'terminated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX staff_profiles_user_unique
  ON staff_profiles (school_id, user_id) WHERE user_id IS NOT NULL;

-- Academic sessions (e.g. 2026-27). One current session per school.
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_on DATE,
  ends_on DATE,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE UNIQUE INDEX sessions_one_current_per_school
  ON sessions (school_id) WHERE is_current;

-- Seed each school's current session from its legacy `session` label
-- and point its classes at it.
INSERT INTO sessions (school_id, name, is_current)
SELECT id, session, true FROM schools
ON CONFLICT (school_id, name) DO NOTHING;

ALTER TABLE classes ADD COLUMN session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

UPDATE classes c
SET session_id = s.id
FROM sessions s
WHERE s.school_id = c.school_id
  AND s.name = (SELECT sc.session FROM schools sc WHERE sc.id = c.school_id)
  AND c.session_id IS NULL;

-- Subjects and who teaches / studies them.
CREATE TABLE subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE class_subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, class_id, subject_id)
);

CREATE TABLE teacher_subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, teacher_user_id, subject_id, class_id)
);

ALTER TABLE student_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_history_tenant_isolation ON student_history
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE student_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_documents_tenant_isolation ON student_documents
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE staff_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_profiles_tenant_isolation ON staff_profiles
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_tenant_isolation ON sessions
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY subjects_tenant_isolation ON subjects
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE class_subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY class_subjects_tenant_isolation ON class_subjects
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE teacher_subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY teacher_subjects_tenant_isolation ON teacher_subjects
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
