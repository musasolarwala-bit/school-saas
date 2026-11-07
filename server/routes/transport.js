'use strict';

// School Manager SaaS — transport (Phase 6).
// Vehicles, routes with ordered stops, one assignment per student
// (route + stop + optional transport fee amount, recorded only — fee
// collection stays in the Phase 3 fees module), and a per-day route
// manifest with manually marked pickup attendance.
// GPS LIVE TRACKING IS NOT IMPLEMENTED: it is an external dependency
// (driver app / GPS hardware + a streaming service). The manifest is
// the manual substitute; nothing here pretends to be live location.
// Roles: transport:write = school_admin, school_owner,
// transport_manager. Parents/students read only their linked child's
// assignment and route.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isUuid, isNonEmptyString, isDateStr, dateStr } = require('../lib/validate');
const { linkedStudentId } = require('../lib/scope');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('transport:read'));

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function schoolRow(client, req, table, id, label) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND school_id = $2`, [id, req.schoolId]
  );
  if (rows.length === 0) throw bad(`${label} not found`, 404);
  return rows[0];
}

function isTimeStr(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
}

const VEHICLE_TYPES = ['bus', 'van', 'car', 'other'];
const VEHICLE_STATUSES = ['active', 'maintenance', 'inactive'];

// ---------------- Vehicles ----------------

router.get('/vehicles', withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    'SELECT * FROM transport_vehicles WHERE school_id = $1 ORDER BY registration_no',
    [req.schoolId]
  );
  return { vehicles: rows };
}));

router.post('/vehicles', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.registration_no, 60)) throw bad('registration_no is required', 400);
  if (b.vehicle_type !== undefined && !VEHICLE_TYPES.includes(b.vehicle_type)) throw bad('vehicle_type is invalid', 400);
  if (b.status !== undefined && !VEHICLE_STATUSES.includes(b.status)) throw bad('status is invalid', 400);
  const capacity = b.capacity === undefined ? 0 : Number(b.capacity);
  if (!Number.isInteger(capacity) || capacity < 0) throw bad('capacity must be an integer >= 0', 400);
  try {
    const { rows } = await client.query(
      `INSERT INTO transport_vehicles (school_id, registration_no, vehicle_type, capacity, driver_name, driver_phone, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.schoolId, b.registration_no.trim(), b.vehicle_type || 'bus', capacity,
       b.driver_name || null, b.driver_phone || null, b.status || 'active']
    );
    return { vehicle: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A vehicle with that registration already exists', 409);
    throw err;
  }
}, 201));

router.patch('/vehicles/:id', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid vehicle id', 400);
  const b = req.body || {};
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.registration_no !== undefined) {
    if (!isNonEmptyString(b.registration_no, 60)) throw bad('registration_no must be non-empty', 400);
    set('registration_no', b.registration_no.trim());
  }
  if (b.vehicle_type !== undefined) {
    if (!VEHICLE_TYPES.includes(b.vehicle_type)) throw bad('vehicle_type is invalid', 400);
    set('vehicle_type', b.vehicle_type);
  }
  if (b.capacity !== undefined) {
    const capacity = Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 0) throw bad('capacity must be an integer >= 0', 400);
    set('capacity', capacity);
  }
  if (b.status !== undefined) {
    if (!VEHICLE_STATUSES.includes(b.status)) throw bad('status is invalid', 400);
    set('status', b.status);
  }
  for (const f of ['driver_name', 'driver_phone']) if (b[f] !== undefined) set(f, b[f] || null);
  if (sets.length === 0) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE transport_vehicles SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING *`,
      vals
    );
    if (rows.length === 0) throw bad('Vehicle not found', 404);
    return { vehicle: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A vehicle with that registration already exists', 409);
    throw err;
  }
}));

router.delete('/vehicles/:id', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid vehicle id', 400);
  const { rows } = await client.query(
    'DELETE FROM transport_vehicles WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Vehicle not found', 404);
  return { deleted: true };
}));

// ---------------- Routes + stops ----------------

router.get('/routes', withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    `SELECT r.*, v.registration_no, v.driver_name, v.driver_phone,
            (SELECT COUNT(*)::int FROM transport_stops st WHERE st.route_id = r.id AND st.school_id = r.school_id) AS stop_count,
            (SELECT COUNT(*)::int FROM transport_assignments a WHERE a.route_id = r.id AND a.school_id = r.school_id AND a.status = 'active') AS student_count
     FROM transport_routes r
     LEFT JOIN transport_vehicles v ON v.id = r.vehicle_id
     WHERE r.school_id = $1 ORDER BY r.name`,
    [req.schoolId]
  );
  return { routes: rows };
}));

router.post('/routes', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  if (b.vehicle_id !== undefined && b.vehicle_id !== null) {
    if (!isUuid(b.vehicle_id)) throw bad('vehicle_id must be a UUID', 400);
    await schoolRow(client, req, 'transport_vehicles', b.vehicle_id, 'Vehicle');
  }
  try {
    const { rows } = await client.query(
      `INSERT INTO transport_routes (school_id, name, vehicle_id, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.schoolId, b.name.trim(), b.vehicle_id || null, b.notes || null]
    );
    return { route: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A route with that name already exists', 409);
    throw err;
  }
}, 201));

router.patch('/routes/:id', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid route id', 400);
  const b = req.body || {};
  if (b.vehicle_id !== undefined && b.vehicle_id !== null) {
    if (!isUuid(b.vehicle_id)) throw bad('vehicle_id must be a UUID', 400);
    await schoolRow(client, req, 'transport_vehicles', b.vehicle_id, 'Vehicle');
  }
  if (b.status !== undefined && !['active', 'inactive'].includes(b.status)) throw bad('status is invalid', 400);
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.name !== undefined) {
    if (!isNonEmptyString(b.name, 200)) throw bad('name must be non-empty', 400);
    set('name', b.name.trim());
  }
  if (b.vehicle_id !== undefined) set('vehicle_id', b.vehicle_id || null);
  if (b.notes !== undefined) set('notes', b.notes || null);
  if (b.status !== undefined) set('status', b.status);
  if (sets.length === 0) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE transport_routes SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING *`,
      vals
    );
    if (rows.length === 0) throw bad('Route not found', 404);
    return { route: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A route with that name already exists', 409);
    throw err;
  }
}));

router.delete('/routes/:id', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid route id', 400);
  const { rows } = await client.query(
    'DELETE FROM transport_routes WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Route not found', 404);
  return { deleted: true };
}));

router.get('/routes/:id/stops', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid route id', 400);
  await schoolRow(client, req, 'transport_routes', req.params.id, 'Route');
  const { rows } = await client.query(
    'SELECT * FROM transport_stops WHERE school_id = $1 AND route_id = $2 ORDER BY sequence',
    [req.schoolId, req.params.id]
  );
  return {
    stops: rows.map((r) => ({ ...r, pickup_time: r.pickup_time ? String(r.pickup_time).slice(0, 5) : null })),
  };
}));

router.post('/routes/:id/stops', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid route id', 400);
  await schoolRow(client, req, 'transport_routes', req.params.id, 'Route');
  const b = req.body || {};
  if (!isNonEmptyString(b.stop_name, 200)) throw bad('stop_name is required', 400);
  if (!Number.isInteger(b.sequence) || b.sequence < 1) throw bad('sequence must be a positive integer', 400);
  if (b.pickup_time !== undefined && b.pickup_time !== null && !isTimeStr(b.pickup_time)) throw bad('pickup_time must be HH:MM', 400);
  try {
    const { rows } = await client.query(
      `INSERT INTO transport_stops (school_id, route_id, stop_name, sequence, pickup_time)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.schoolId, req.params.id, b.stop_name.trim(), b.sequence, b.pickup_time || null]
    );
    return { stop: { ...rows[0], pickup_time: rows[0].pickup_time ? String(rows[0].pickup_time).slice(0, 5) : null } };
  } catch (err) {
    if (err.code === '23505') throw bad('That stop name or sequence already exists on this route', 409);
    throw err;
  }
}, 201));

router.delete('/stops/:id', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid stop id', 400);
  const { rows } = await client.query(
    'DELETE FROM transport_stops WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Stop not found', 404);
  return { deleted: true };
}));

// ---------------- Assignments ----------------

const ASSIGN_COLS = 'a.id, a.school_id, a.student_id, a.route_id, a.stop_id, a.fee_amount, a.status, a.created_at, '
  + 's.name AS student_name, s.roll_no, s.section, c.name AS class_name, '
  + 'r.name AS route_name, st.stop_name';

router.get('/assignments', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'a.school_id = $1';
  if (req.query.route_id !== undefined) {
    if (!isUuid(req.query.route_id)) throw bad('route_id must be a UUID', 400);
    params.push(req.query.route_id);
    where += ` AND a.route_id = $${params.length}`;
  }
  if (req.query.student_id !== undefined) {
    if (!isUuid(req.query.student_id)) throw bad('student_id must be a UUID', 400);
    params.push(req.query.student_id);
    where += ` AND a.student_id = $${params.length}`;
  }
  if (req.user.role === 'parent' || req.user.role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (!linked) return { assignments: [] };
    params.push(linked);
    where += ` AND a.student_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${ASSIGN_COLS} FROM transport_assignments a
     JOIN students s ON s.id = a.student_id
     JOIN classes c ON c.id = s.class_id
     JOIN transport_routes r ON r.id = a.route_id
     LEFT JOIN transport_stops st ON st.id = a.stop_id
     WHERE ${where} ORDER BY r.name, st.sequence NULLS LAST, s.name`,
    params
  );
  return { assignments: rows.map((r) => ({ ...r, fee_amount: Number(r.fee_amount) })) };
}));

router.post('/assignments', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.student_id)) throw bad('student_id must be a UUID', 400);
  if (!isUuid(b.route_id)) throw bad('route_id must be a UUID', 400);
  await schoolRow(client, req, 'students', b.student_id, 'Student');
  await schoolRow(client, req, 'transport_routes', b.route_id, 'Route');
  if (b.stop_id !== undefined && b.stop_id !== null) {
    if (!isUuid(b.stop_id)) throw bad('stop_id must be a UUID', 400);
    const stop = await schoolRow(client, req, 'transport_stops', b.stop_id, 'Stop');
    if (stop.route_id !== b.route_id) throw bad('stop_id does not belong to that route', 400);
  }
  const fee = b.fee_amount === undefined ? 0 : Number(b.fee_amount);
  if (!Number.isFinite(fee) || fee < 0) throw bad('fee_amount must be a number >= 0', 400);
  try {
    const { rows } = await client.query(
      `INSERT INTO transport_assignments (school_id, student_id, route_id, stop_id, fee_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.schoolId, b.student_id, b.route_id, b.stop_id || null, fee]
    );
    return { assignment: { ...rows[0], fee_amount: Number(rows[0].fee_amount) } };
  } catch (err) {
    if (err.code === '23505') throw bad('That student already has a transport assignment — update it instead', 409);
    throw err;
  }
}, 201));

router.patch('/assignments/:id', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid assignment id', 400);
  const existing = await schoolRow(client, req, 'transport_assignments', req.params.id, 'Assignment');
  const b = req.body || {};
  const routeId = b.route_id !== undefined ? b.route_id : existing.route_id;
  if (b.route_id !== undefined) {
    if (!isUuid(b.route_id)) throw bad('route_id must be a UUID', 400);
    await schoolRow(client, req, 'transport_routes', b.route_id, 'Route');
  }
  if (b.stop_id !== undefined && b.stop_id !== null) {
    if (!isUuid(b.stop_id)) throw bad('stop_id must be a UUID', 400);
    const stop = await schoolRow(client, req, 'transport_stops', b.stop_id, 'Stop');
    if (stop.route_id !== routeId) throw bad('stop_id does not belong to that route', 400);
  }
  if (b.status !== undefined && !['active', 'inactive'].includes(b.status)) throw bad('status is invalid', 400);
  const sets = ['updated_at = now()'];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.route_id !== undefined) set('route_id', b.route_id);
  if (b.stop_id !== undefined) set('stop_id', b.stop_id || null);
  if (b.fee_amount !== undefined) {
    const fee = Number(b.fee_amount);
    if (!Number.isFinite(fee) || fee < 0) throw bad('fee_amount must be a number >= 0', 400);
    set('fee_amount', fee);
  }
  if (b.status !== undefined) set('status', b.status);
  if (sets.length === 1) throw bad('Nothing to update', 400);
  const { rows } = await client.query(
    `UPDATE transport_assignments SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING *`,
    vals
  );
  return { assignment: { ...rows[0], fee_amount: Number(rows[0].fee_amount) } };
}));

router.delete('/assignments/:id', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid assignment id', 400);
  const { rows } = await client.query(
    'DELETE FROM transport_assignments WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Assignment not found', 404);
  return { deleted: true };
}));

// ---------------- Manifest (per-day route sheet) ----------------

router.get('/manifest', withSchoolDb(async (req, client) => {
  if (!isUuid(req.query.route_id)) throw bad('route_id query parameter is required', 400);
  const date = req.query.date || dateStr(new Date());
  if (!isDateStr(date)) throw bad('date must be YYYY-MM-DD', 400);
  const route = await schoolRow(client, req, 'transport_routes', req.query.route_id, 'Route');
  if (req.user.role === 'parent' || req.user.role === 'student') {
    throw bad('Route manifests are staff-only', 403);
  }
  const stops = await client.query(
    'SELECT * FROM transport_stops WHERE school_id = $1 AND route_id = $2 ORDER BY sequence',
    [req.schoolId, route.id]
  );
  const riders = await client.query(
    `SELECT a.id AS assignment_id, a.student_id, a.stop_id,
            s.name AS student_name, s.roll_no, s.section, c.name AS class_name,
            ta.status AS attendance_status
     FROM transport_assignments a
     JOIN students s ON s.id = a.student_id
     JOIN classes c ON c.id = s.class_id
     LEFT JOIN transport_attendance ta
       ON ta.assignment_id = a.id AND ta.school_id = a.school_id AND ta.date = $3
     WHERE a.school_id = $1 AND a.route_id = $2 AND a.status = 'active'
     ORDER BY s.name`,
    [req.schoolId, route.id, date]
  );
  const byStop = new Map();
  for (const st of stops.rows) byStop.set(st.id, { stop: st, students: [] });
  const unstopped = [];
  for (const r of riders.rows) {
    const entry = {
      assignment_id: r.assignment_id, student_id: r.student_id, name: r.student_name,
      roll_no: r.roll_no, section: r.section, class_name: r.class_name,
      status: r.attendance_status || null,
    };
    if (r.stop_id && byStop.has(r.stop_id)) byStop.get(r.stop_id).students.push(entry);
    else unstopped.push(entry);
  }
  return {
    manifest: {
      route: { id: route.id, name: route.name },
      date,
      stops: [...byStop.values()].map((g) => ({
        stop_id: g.stop.id, stop_name: g.stop.stop_name, sequence: g.stop.sequence,
        pickup_time: g.stop.pickup_time ? String(g.stop.pickup_time).slice(0, 5) : null,
        students: g.students,
      })),
      unstopped,
      marked: riders.rows.filter((r) => r.attendance_status).length,
      total: riders.rows.length,
    },
  };
}));

router.post('/manifest/mark', requireCapability('transport:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isDateStr(b.date)) throw bad('date must be YYYY-MM-DD', 400);
  if (!Array.isArray(b.entries) || b.entries.length === 0) throw bad('entries must be a non-empty array', 400);
  let marked = 0;
  for (const e of b.entries) {
    if (!e || !isUuid(e.assignment_id)) throw bad('every entry needs an assignment_id', 400);
    if (!['present', 'absent'].includes(e.status)) throw bad('status must be present or absent', 400);
    await schoolRow(client, req, 'transport_assignments', e.assignment_id, 'Assignment');
    await client.query(
      `INSERT INTO transport_attendance (school_id, assignment_id, date, status, marked_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (school_id, assignment_id, date)
       DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, updated_at = now()`,
      [req.schoolId, e.assignment_id, b.date, e.status, req.user.sub]
    );
    marked += 1;
  }
  return { marked };
}, 201));

module.exports = router;
