'use strict';

// School Manager SaaS — student routes (Phase 2).
// Visibility (all scoped to the caller's school):
//   school_admin / school_owner -> every student of the school.
//   principal, accountant, hr_manager, transport_manager, librarian,
//     receptionist -> every student (read-only; see the capability
//     matrix in lib/permissions.js).
//   teacher      -> students of classes assigned to them (class
//     teacher OR subject teacher, lib/scope.js).
//   parent       -> only the student linked to their account.
//   student      -> only their own record.
// Writes need the students:write capability (school_admin /
// school_owner). Creating a student ALSO passes the subscription
// gate (lib/subscriptions.js) and is assigned a per-school admission
// number (ADM-<year>-<seq>) plus an 'admission' history row.
// List filters: q (name search), class_id, section, status.
// Extras: GET /export.csv, POST /import (CSV bulk admission),
// POST /promote (bulk class move), POST /:id/status (lifecycle change
// with history), /:id/history, /:id/documents (metadata + URL only —
// no file binaries are stored by this API).

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { assertCanAddStudent } = require('../lib/subscriptions');
const { teacherClassIds, linkedStudentId } = require('../lib/scope');
const { parseCsv, toCsv } = require('../lib/csv');
const { logAudit } = require('../lib/audit');
const { isUuid, isNonEmptyString } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

const STATUSES = ['active', 'left', 'graduated', 'transferred'];
const STUDENT_COLS = 's.id, s.school_id, s.class_id, c.name AS class_name, s.section, s.roll_no, s.name, '
  + 's.admission_number, s.photo_url, s.guardian_name, s.guardian_phone, '
  + 's.emergency_contact_name, s.emergency_contact_phone, s.previous_school, s.medical_notes, '
  + 's.status, s.created_at';
const RETURN_COLS = 'id, school_id, class_id, section, roll_no, name, admission_number, photo_url, '
  + 'guardian_name, guardian_phone, emergency_contact_name, emergency_contact_phone, '
  + 'previous_school, medical_notes, status, created_at';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function statusEvent(newStatus) {
  if (newStatus === 'left') return 'withdrawal';
  if (newStatus === 'graduated') return 'graduation';
  if (newStatus === 'transferred') return 'transfer_out';
  return 'status_change';
}

async function writeHistory(client, req, studentId, event, fields) {
  await client.query(
    `INSERT INTO student_history
       (school_id, student_id, event, from_class_id, to_class_id, from_status, to_status, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      req.schoolId, studentId, event,
      (fields && fields.fromClassId) || null,
      (fields && fields.toClassId) || null,
      (fields && fields.fromStatus) || null,
      (fields && fields.toStatus) || null,
      (fields && fields.note) || null,
      req.user.sub,
    ]
  );
}

// One student of this school as the caller may see them, or throw
// 404 (not found / not yours) / 403 (teacher, not their class) —
// the same semantics the attendance routes use.
async function getVisibleStudent(client, req, studentId) {
  const { rows } = await client.query(
    `SELECT ${STUDENT_COLS} FROM students s JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 AND s.id = $2`,
    [req.schoolId, studentId]
  );
  if (rows.length === 0) throw bad('Student not found', 404);
  const student = rows[0];
  const role = req.user.role;
  if (role === 'parent' || role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (linked !== studentId) throw bad('Student not found', 404);
  } else if (role === 'teacher') {
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    if (!ids.includes(student.class_id)) throw bad('Student is not in one of your classes', 403);
  } else if (!can(role, 'students:read')) {
    throw bad('Forbidden for this role', 403);
  }
  return student;
}

async function listStudents(req, client) {
  const role = req.user.role;
  const q = req.query || {};
  const filters = [];
  const params = [req.schoolId];
  const addFilter = (clause, value) => {
    params.push(value);
    filters.push(clause.replace('?', `$${params.length}`));
  };
  if (q.q) addFilter('s.name ILIKE ?', `%${String(q.q).trim()}%`);
  if (q.class_id) {
    if (!isUuid(q.class_id)) throw bad('class_id must be a UUID', 400);
    addFilter('s.class_id = ?', q.class_id);
  }
  if (q.section) addFilter('s.section = ?', String(q.section).trim());
  if (q.status) {
    if (!STATUSES.includes(q.status)) throw bad('status filter is invalid', 400);
    addFilter('s.status = ?', q.status);
  }
  const where = filters.length > 0 ? ' AND ' + filters.join(' AND ') : '';
  const order = 'ORDER BY c.name, s.section, s.roll_no';

  if (role === 'teacher') {
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    if (ids.length === 0) return [];
    params.push(ids);
    const { rows } = await client.query(
      `SELECT ${STUDENT_COLS} FROM students s JOIN classes c ON c.id = s.class_id
       WHERE s.school_id = $1 AND s.class_id = ANY($${params.length})${where} ${order}`,
      params
    );
    return rows;
  }
  if (role === 'parent' || role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (!linked) return [];
    params.push(linked);
    const { rows } = await client.query(
      `SELECT ${STUDENT_COLS} FROM students s JOIN classes c ON c.id = s.class_id
       WHERE s.school_id = $1 AND s.id = $${params.length}${where}`,
      params
    );
    return rows;
  }
  if (can(role, 'students:read')) {
    const { rows } = await client.query(
      `SELECT ${STUDENT_COLS} FROM students s JOIN classes c ON c.id = s.class_id
       WHERE s.school_id = $1${where} ${order}`,
      params
    );
    return rows;
  }
  throw bad('Forbidden for this role', 403);
}

// Shared creation path for POST / and CSV import: validates the class,
// passes the subscription gate, assigns the admission number and
// writes the admission history row. The school row is locked FOR
// UPDATE so admission sequences never collide within a school.
async function createStudent(client, req, b) {
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!isNonEmptyString(b.section, 20)) throw bad('section is required', 400);
  if (!isNonEmptyString(b.roll_no, 50)) throw bad('roll_no is required', 400);
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  if (b.status !== undefined && !STATUSES.includes(b.status)) {
    throw bad(`status must be one of ${STATUSES.join(', ')}`, 400);
  }
  const cls = await client.query(
    'SELECT id FROM classes WHERE id = $1 AND school_id = $2',
    [b.class_id, req.schoolId]
  );
  if (cls.rows.length === 0) throw bad('class_id does not belong to this school', 400);
  await assertCanAddStudent(client, req.schoolId);
  await client.query('SELECT id FROM schools WHERE id = $1 FOR UPDATE', [req.schoolId]);
  const seqRes = await client.query(
    'SELECT COALESCE(MAX(admission_seq), 0) + 1 AS seq FROM students WHERE school_id = $1',
    [req.schoolId]
  );
  const seq = seqRes.rows[0].seq;
  const admissionNumber = `ADM-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
  try {
    const { rows } = await client.query(
      `INSERT INTO students
         (school_id, class_id, section, roll_no, name, admission_number, admission_seq,
          photo_url, guardian_name, guardian_phone, emergency_contact_name,
          emergency_contact_phone, previous_school, medical_notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${RETURN_COLS}`,
      [
        req.schoolId, b.class_id, b.section.trim(), b.roll_no.trim(), b.name.trim(),
        admissionNumber, seq,
        b.photo_url || null, b.guardian_name || null, b.guardian_phone || null,
        b.emergency_contact_name || null, b.emergency_contact_phone || null,
        b.previous_school || null, b.medical_notes || null,
        b.status || 'active',
      ]
    );
    await writeHistory(client, req, rows[0].id, 'admission', {
      toClassId: b.class_id, toStatus: rows[0].status,
    });
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw bad('That roll number already exists in this class section', 409);
    throw err;
  }
}

router.get('/', withSchoolDb(async (req, client) => {
  return { students: await listStudents(req, client) };
}));

// CSV export of the caller's visible student list (same filters).
router.get('/export.csv', withSchoolDb(async (req, client) => {
  const students = await listStudents(req, client);
  const csv = toCsv(
    ['admission_number', 'name', 'class', 'section', 'roll_no', 'guardian_name', 'guardian_phone',
      'emergency_contact_name', 'emergency_contact_phone', 'previous_school', 'status'],
    students.map((s) => [
      s.admission_number, s.name, s.class_name, s.section, s.roll_no, s.guardian_name,
      s.guardian_phone, s.emergency_contact_name, s.emergency_contact_phone,
      s.previous_school, s.status,
    ])
  );
  const res = req.res;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(csv);
  return undefined;
}));

router.get('/:id', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid student id', 400);
  const student = await getVisibleStudent(client, req, req.params.id);
  return { student };
}));

router.get('/:id/history', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid student id', 400);
  await getVisibleStudent(client, req, req.params.id);
  const { rows } = await client.query(
    `SELECT h.id, h.event, h.from_class_id, fc.name AS from_class_name,
            h.to_class_id, tc.name AS to_class_name, h.from_status, h.to_status,
            h.note, h.created_by, h.created_at
     FROM student_history h
     LEFT JOIN classes fc ON fc.id = h.from_class_id
     LEFT JOIN classes tc ON tc.id = h.to_class_id
     WHERE h.school_id = $1 AND h.student_id = $2
     ORDER BY h.created_at ASC, h.id ASC`,
    [req.schoolId, req.params.id]
  );
  return { history: rows };
}));

// ---- Documents: metadata + URL only (no binary storage) ----

router.get('/:id/documents', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid student id', 400);
  await getVisibleStudent(client, req, req.params.id);
  const { rows } = await client.query(
    `SELECT id, school_id, student_id, name, doc_type, url, created_by, created_at
     FROM student_documents WHERE school_id = $1 AND student_id = $2 ORDER BY created_at ASC`,
    [req.schoolId, req.params.id]
  );
  return { documents: rows };
}));

router.post('/:id/documents', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid student id', 400);
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  if (!isNonEmptyString(b.url, 2000)) throw bad('url is required', 400);
  await getVisibleStudent(client, req, req.params.id);
  const { rows } = await client.query(
    `INSERT INTO student_documents (school_id, student_id, name, doc_type, url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, school_id, student_id, name, doc_type, url, created_by, created_at`,
    [req.schoolId, req.params.id, b.name.trim(), String(b.doc_type || 'other').trim(), b.url.trim(), req.user.sub]
  );
  return { document: rows[0] };
}, 201));

router.delete('/:id/documents/:docId', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id) || !isUuid(req.params.docId)) throw bad('Invalid id', 400);
  const { rows } = await client.query(
    'DELETE FROM student_documents WHERE school_id = $1 AND student_id = $2 AND id = $3 RETURNING id',
    [req.schoolId, req.params.id, req.params.docId]
  );
  if (rows.length === 0) throw bad('Document not found', 404);
  return { deleted: true };
}));

// ---- Create ----

router.post('/', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  const student = await createStudent(client, req, req.body || {});
  await logAudit(client, req, 'student.create', 'student', student.id, {
    name: student.name, admission_number: student.admission_number,
  });
  return { student };
}, 201));

// ---- Bulk CSV import ----
// Body: { csv: "<header row + data rows>" } with headers
// class_name, section, roll_no, name and optional guardian_name,
// guardian_phone, emergency_contact_name, emergency_contact_phone,
// previous_school, status. Valid rows are imported; every bad row is
// reported with its line number. The subscription gate applies per
// row: once the student limit is hit, remaining rows are errors.
router.post('/import', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (typeof b.csv !== 'string' || b.csv.trim().length === 0) {
    throw bad('csv text is required', 400);
  }
  const parsed = parseCsv(b.csv).filter((r) => r.some((c) => String(c).trim().length > 0));
  if (parsed.length < 2) throw bad('csv needs a header row and at least one data row', 400);
  const headers = parsed[0].map((h) => String(h).trim().toLowerCase());
  const col = (name) => headers.indexOf(name);
  const idx = {
    class_name: col('class_name'), section: col('section'), roll_no: col('roll_no'),
    name: col('name'), guardian_name: col('guardian_name'), guardian_phone: col('guardian_phone'),
    emergency_contact_name: col('emergency_contact_name'),
    emergency_contact_phone: col('emergency_contact_phone'),
    previous_school: col('previous_school'), status: col('status'),
  };
  if (idx.class_name < 0 || idx.roll_no < 0 || idx.name < 0) {
    throw bad('csv headers must include class_name, roll_no and name', 400);
  }
  const clsRes = await client.query(
    'SELECT id, name FROM classes WHERE school_id = $1', [req.schoolId]
  );
  const classByName = new Map(clsRes.rows.map((c) => [c.name.trim().toLowerCase(), c.id]));

  const cell = (row, i) => (i >= 0 && row[i] !== undefined ? String(row[i]).trim() : '');
  const errors = [];
  let imported = 0;
  let limitHit = false;
  for (let r = 1; r < parsed.length; r++) {
    const row = parsed[r];
    const line = r + 1;
    if (limitHit) {
      errors.push({ row: line, error: 'Student limit reached — row not imported' });
      continue;
    }
    const className = cell(row, idx.class_name);
    const classId = classByName.get(className.toLowerCase());
    if (!classId) {
      errors.push({ row: line, error: `Unknown class "${className}"` });
      continue;
    }
    const data = {
      class_id: classId,
      section: cell(row, idx.section) || 'A',
      roll_no: cell(row, idx.roll_no),
      name: cell(row, idx.name),
      guardian_name: cell(row, idx.guardian_name) || undefined,
      guardian_phone: cell(row, idx.guardian_phone) || undefined,
      emergency_contact_name: cell(row, idx.emergency_contact_name) || undefined,
      emergency_contact_phone: cell(row, idx.emergency_contact_phone) || undefined,
      previous_school: cell(row, idx.previous_school) || undefined,
      status: cell(row, idx.status) || undefined,
    };
    try {
      // A savepoint per row: one bad row never aborts the whole import.
      await client.query('SAVEPOINT import_row');
      await createStudent(client, req, data);
      await client.query('RELEASE SAVEPOINT import_row');
      imported++;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT import_row');
      if (err.status === 403) limitHit = true;
      errors.push({ row: line, error: err.message });
    }
  }
  return { imported, errors };
}));

// ---- Bulk promotion: move a class's ACTIVE students to a target class ----

router.post('/promote', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.from_class_id)) throw bad('from_class_id must be a UUID', 400);
  if (!isUuid(b.to_class_id)) throw bad('to_class_id must be a UUID', 400);
  if (b.from_class_id === b.to_class_id) throw bad('from_class_id and to_class_id must differ', 400);
  for (const id of [b.from_class_id, b.to_class_id]) {
    const cls = await client.query(
      'SELECT id FROM classes WHERE id = $1 AND school_id = $2', [id, req.schoolId]
    );
    if (cls.rows.length === 0) throw bad('Class not found', 404);
  }
  const moving = await client.query(
    `SELECT id, section, roll_no FROM students
     WHERE school_id = $1 AND class_id = $2 AND status = 'active' ORDER BY section, roll_no`,
    [req.schoolId, b.from_class_id]
  );
  const targetSection = b.to_section ? String(b.to_section).trim() : null;
  // Roll numbers stay with the student; a clash in the target
  // class+section aborts the whole move (nothing is half-promoted).
  const target = await client.query(
    'SELECT section, roll_no FROM students WHERE school_id = $1 AND class_id = $2',
    [req.schoolId, b.to_class_id]
  );
  const taken = new Set(target.rows.map((t) => `${targetSection || t.section}|${t.roll_no}`));
  const clashes = moving.rows.filter((s) => taken.has(`${targetSection || s.section}|${s.roll_no}`));
  if (clashes.length > 0) {
    throw bad(`Promotion blocked: ${clashes.length} roll number(s) already exist in the target class`, 409);
  }
  for (const s of moving.rows) {
    await client.query(
      'UPDATE students SET class_id = $1, section = $2 WHERE school_id = $3 AND id = $4',
      [b.to_class_id, targetSection || s.section, req.schoolId, s.id]
    );
    await writeHistory(client, req, s.id, 'promotion', {
      fromClassId: b.from_class_id, toClassId: b.to_class_id, note: b.note || null,
    });
  }
  return { promoted: moving.rows.length };
}));

// ---- Lifecycle status change (writes history) ----

router.post('/:id/status', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid student id', 400);
  const b = req.body || {};
  if (!STATUSES.includes(b.status)) throw bad(`status must be one of ${STATUSES.join(', ')}`, 400);
  const cur = await client.query(
    'SELECT id, status FROM students WHERE school_id = $1 AND id = $2',
    [req.schoolId, req.params.id]
  );
  if (cur.rows.length === 0) throw bad('Student not found', 404);
  const { rows } = await client.query(
    `UPDATE students SET status = $1 WHERE school_id = $2 AND id = $3 RETURNING ${RETURN_COLS}`,
    [b.status, req.schoolId, req.params.id]
  );
  await writeHistory(client, req, req.params.id, statusEvent(b.status), {
    fromStatus: cur.rows[0].status, toStatus: b.status, note: b.note || null,
  });
  await logAudit(client, req, 'student.status_change', 'student', req.params.id, {
    from: cur.rows[0].status, to: b.status,
  });
  return { student: rows[0] };
}));

// ---- Patch / delete ----

router.patch('/:id', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(req.params.id)) throw bad('Invalid student id', 400);
  const cur = await client.query(
    'SELECT id, class_id, status FROM students WHERE school_id = $1 AND id = $2',
    [req.schoolId, req.params.id]
  );
  if (cur.rows.length === 0) throw bad('Student not found', 404);
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  const stringField = (field, max) => {
    if (b[field] !== undefined) {
      if (!isNonEmptyString(b[field], max)) throw bad(`${field} must be a non-empty string`, 400);
      vals.push(b[field].trim());
      sets.push(`${field} = $${vals.length}`);
    }
  };
  const nullableField = (field) => {
    if (b[field] !== undefined) {
      vals.push(b[field] || null);
      sets.push(`${field} = $${vals.length}`);
    }
  };
  stringField('section', 20);
  stringField('roll_no', 50);
  stringField('name', 200);
  nullableField('guardian_name');
  nullableField('guardian_phone');
  nullableField('photo_url');
  nullableField('emergency_contact_name');
  nullableField('emergency_contact_phone');
  nullableField('previous_school');
  nullableField('medical_notes');
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw bad(`status must be one of ${STATUSES.join(', ')}`, 400);
    vals.push(b.status);
    sets.push(`status = $${vals.length}`);
  }
  if (b.class_id !== undefined) {
    if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
    const cls = await client.query(
      'SELECT id FROM classes WHERE id = $1 AND school_id = $2',
      [b.class_id, req.schoolId]
    );
    if (cls.rows.length === 0) throw bad('class_id does not belong to this school', 400);
    vals.push(b.class_id);
    sets.push(`class_id = $${vals.length}`);
  }
  if (sets.length === 0) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE students SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING ${RETURN_COLS}`,
      vals
    );
    if (b.status !== undefined && b.status !== cur.rows[0].status) {
      await writeHistory(client, req, req.params.id, statusEvent(b.status), {
        fromStatus: cur.rows[0].status, toStatus: b.status,
      });
    }
    if (b.class_id !== undefined && b.class_id !== cur.rows[0].class_id) {
      await writeHistory(client, req, req.params.id, 'class_change', {
        fromClassId: cur.rows[0].class_id, toClassId: b.class_id,
      });
    }
    return { student: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('That roll number already exists in this class section', 409);
    throw err;
  }
}));

router.delete('/:id', requireCapability('students:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid student id', 400);
  const { rows } = await client.query(
    'DELETE FROM students WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Student not found', 404);
  await logAudit(client, req, 'student.delete', 'student', req.params.id, {});
  return { deleted: true };
}));

module.exports = router;
