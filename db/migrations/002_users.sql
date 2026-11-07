-- 002_users.sql — login accounts.
-- One user belongs to exactly one school, except super_admin, whose
-- school_id is NULL (a super_admin manages all schools).
-- The same email may exist in DIFFERENT schools (UNIQUE on
-- (email, school_id)); super_admin emails are unique via the partial
-- index below, because NULLs are distinct in a plain UNIQUE constraint.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('super_admin', 'school_admin', 'teacher', 'parent', 'student')),
  -- For parent/student accounts: the student record they may see.
  linked_student_id UUID,
  -- Reserved for Stage 2, when a staff table owns teacher records.
  -- In Stage 1 a teacher's identity IS their user row, and
  -- classes.teacher_id points at it. No FK until the staff table lands.
  linked_teacher_id UUID,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email, school_id),
  CHECK (
    (role = 'super_admin' AND school_id IS NULL)
    OR (role <> 'super_admin' AND school_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX users_super_admin_email_unique
  ON users (email) WHERE school_id IS NULL;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Tenants only ever see their own school's users. super_admin rows
-- (school_id NULL) are never visible to a tenant connection.
CREATE POLICY users_tenant_isolation ON users
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
