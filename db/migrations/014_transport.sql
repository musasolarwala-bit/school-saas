-- 014_transport.sql — Phase 6: vehicles, routes + stops, student
-- assignments and a per-day route manifest attendance. GPS live
-- tracking is an EXTERNAL dependency and deliberately absent — only
-- manually marked manifest attendance is stored (see README).

CREATE TABLE transport_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  registration_no TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'bus'
    CHECK (vehicle_type IN ('bus', 'van', 'car', 'other')),
  capacity INT NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  driver_name TEXT,
  driver_phone TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'maintenance', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, registration_no)
);

CREATE TABLE transport_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  vehicle_id UUID REFERENCES transport_vehicles(id) ON DELETE SET NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE transport_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  stop_name TEXT NOT NULL,
  sequence INT NOT NULL CHECK (sequence > 0),
  pickup_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, route_id, sequence),
  UNIQUE (school_id, route_id, stop_name)
);

CREATE INDEX transport_stops_route_idx ON transport_stops (school_id, route_id, sequence);

-- One transport assignment per student; changing routes edits it.
CREATE TABLE transport_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  stop_id UUID REFERENCES transport_stops(id) ON DELETE SET NULL,
  fee_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, student_id)
);

CREATE INDEX transport_assignments_route_idx
  ON transport_assignments (school_id, route_id, status);

CREATE TABLE transport_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES transport_assignments(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent')),
  marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, assignment_id, date)
);

ALTER TABLE transport_vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY transport_vehicles_tenant_isolation ON transport_vehicles
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE transport_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY transport_routes_tenant_isolation ON transport_routes
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE transport_stops ENABLE ROW LEVEL SECURITY;
CREATE POLICY transport_stops_tenant_isolation ON transport_stops
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE transport_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY transport_assignments_tenant_isolation ON transport_assignments
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));

ALTER TABLE transport_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY transport_attendance_tenant_isolation ON transport_attendance
  FOR ALL
  USING (school_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (school_id::text = current_setting('app.tenant_id', true));
