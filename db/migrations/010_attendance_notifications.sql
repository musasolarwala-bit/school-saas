-- 010_attendance_notifications.sql — Phase 3: attendance status words,
-- staff attendance, and the in-app notifications foundation.
-- Stage 2 stored single-letter codes (P/A/L). Phase 3 uses full words
-- and adds late / half_day. Existing rows are translated; the API also
-- keeps accepting the legacy letters as input aliases.
-- Notifications are IN-APP ONLY for now: no SMS / WhatsApp / email is
-- sent anywhere (those are external dependencies, see README).

ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_status_check;

UPDATE attendance SET status = CASE status
  WHEN 'P' THEN 'present'
  WHEN 'A' THEN 'absent'
  WHEN 'L' THEN 'leave'
  ELSE status
END;

ALTER TABLE attendance ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('present', 'absent', 'late', 'half_day', 'leave'));

CREATE TABLE staff_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_profile_id UUID NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'half_day', 'leave')),
  check_in TIME,
  check_out TIME,
  marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, staff_profile_id, date)
);

CREATE INDEX staff_attendance_day_idx ON staff_attendance (school_id, date);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx
  ON notifications (school_id, user_id, is_read, created_at DESC);

ALTER TABLE staff_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_attendance_tenant_isolation ON staff_attendance
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant_isolation ON notifications
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
