-- 012_exams.sql — Phase 4: exam terms, exams, bulk marks, grading
-- scale, result publication. Grades and GPA are COMPUTED from marks
-- at read time (server/lib/grades.js) against the school's bands —
-- never stored, so editing the scale re-grades history consistently.
-- results_published on the term is the publication gate: parents and
-- students only see a term's results once it is published.

CREATE TABLE exam_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  starts_on DATE,
  ends_on DATE,
  results_published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE grade_bands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  min_pct NUMERIC(5, 2) NOT NULL CHECK (min_pct >= 0 AND min_pct <= 100),
  max_pct NUMERIC(5, 2) NOT NULL CHECK (max_pct >= 0 AND max_pct <= 100),
  grade_point NUMERIC(4, 2) NOT NULL DEFAULT 0 CHECK (grade_point >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, label),
  CHECK (min_pct <= max_pct)
);

CREATE TABLE exams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  term_id UUID NOT NULL REFERENCES exam_terms(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  exam_date DATE,
  total_marks NUMERIC(7, 2) NOT NULL CHECK (total_marks > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, term_id, class_id, subject_id, name)
);

CREATE INDEX exams_class_term_idx ON exams (school_id, class_id, term_id);
CREATE INDEX exams_date_idx ON exams (school_id, exam_date);

CREATE TABLE exam_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  marks_obtained NUMERIC(7, 2) NOT NULL CHECK (marks_obtained >= 0),
  remarks TEXT,
  entered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, exam_id, student_id)
);

CREATE INDEX exam_marks_student_idx ON exam_marks (school_id, student_id);

ALTER TABLE exam_terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_terms_tenant_isolation ON exam_terms
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE grade_bands ENABLE ROW LEVEL SECURITY;
CREATE POLICY grade_bands_tenant_isolation ON grade_bands
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
CREATE POLICY exams_tenant_isolation ON exams
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE exam_marks ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_marks_tenant_isolation ON exam_marks
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
