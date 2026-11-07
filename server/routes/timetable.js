'use strict';

// School Manager SaaS — timetable (Phase 5).
// Weekly slots per class: weekday 1 (Mon) .. 7 (Sun), period number,
// optional start/end times and room. Conflict rules, all enforced
// server-side:
//   - same class + weekday + period       -> UNIQUE constraint (409)
//   - same teacher + weekday + period, or overlapping times in
//     another class                        -> 409 (double-booking)
//   - same room + weekday + period/time   -> 409
// Reads: office roles see everything; a teacher sees their assigned
// classes' slots plus every slot they personally teach; parents /
// students see their linked child's class timetable.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isUuid } = require('../lib/validate');
const { teacherClassIds, linkedStudentId } = require('../lib/scope');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('timetable:read'));

const SLOT_COLS = 'ts.id, ts.school_id, ts.class_id, ts.subject_id, ts.teacher_user_id, ts.weekday, '
  + 'ts.period_no, ts.starts_at, ts.ends_at, ts.room, ts.created_at, '
  + 'c.name AS class_name, s.name AS subject_name, u.name AS teacher_name';

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

function validateSlotBody(b) {
  if (!isUuid(b.class_id)) throw bad('class_id must be a UUID', 400);
  if (!Number.isInteger(b.weekday) || b.weekday < 1 || b.weekday > 7) {
    throw bad('weekday must be an integer 1 (Mon) to 7 (Sun)', 400);
  }
  if (!Number.isInteger(b.period_no) || b.period_no < 1) throw bad('period_no must be a positive integer', 400);
  if (b.subject_id !== undefined && b.subject_id !== null && !isUuid(b.subject_id)) throw bad('subject_id must be a UUID', 400);
  if (b.teacher_user_id !== undefined && b.teacher_user_id !== null && !isUuid(b.teacher_user_id)) throw bad('teacher_user_id must be a UUID', 400);
  if (b.starts_at !== undefined && b.starts_at !== null && !isTimeStr(b.starts_at)) throw bad('starts_at must be HH:MM', 400);
  if (b.ends_at !== undefined && b.ends_at !== null && !isTimeStr(b.ends_at)) throw bad('ends_at must be HH:MM', 400);
  if (b.starts_at && b.ends_at && b.starts_at >= b.ends_at) throw bad('starts_at must be before ends_at', 400);
}

// Double-booking check for teacher and room, written plainly: fetch
// the day's slots for the teacher / room and compare in JS (small
// data, exact semantics). Two slots clash when they share the
// weekday AND (same period_no OR overlapping times).
async function checkClashes(client, req, slot, excludeId) {
  if (slot.teacher_user_id) {
    const { rows } = await client.query(
      `SELECT id, period_no, starts_at::text AS st, ends_at::text AS en, class_id
       FROM timetable_slots
       WHERE school_id = $1 AND weekday = $2 AND teacher_user_id = $3 AND ($4::uuid IS NULL OR id <> $4)`,
      [req.schoolId, slot.weekday, slot.teacher_user_id, excludeId || null]
    );
    for (const r of rows) {
      const overlap = slot.starts_at && slot.ends_at && r.st && r.en &&
        slot.starts_at < r.en.slice(0, 5) && r.st.slice(0, 5) < slot.ends_at;
      if (r.period_no === slot.period_no || overlap) {
        throw bad('Teacher is already booked at that time in another class', 409);
      }
    }
  }
  if (slot.room) {
    const { rows } = await client.query(
      `SELECT id, period_no, starts_at::text AS st, ends_at::text AS en
       FROM timetable_slots
       WHERE school_id = $1 AND weekday = $2 AND room = $3 AND ($4::uuid IS NULL OR id <> $4)`,
      [req.schoolId, slot.weekday, slot.room, excludeId || null]
    );
    for (const r of rows) {
      const overlap = slot.starts_at && slot.ends_at && r.st && r.en &&
        slot.starts_at < r.en.slice(0, 5) && r.st.slice(0, 5) < slot.ends_at;
      if (r.period_no === slot.period_no || overlap) {
        throw bad('Room is already booked at that time', 409);
      }
    }
  }
}

router.get('/', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'ts.school_id = $1';
  if (req.query.class_id !== undefined) {
    if (!isUuid(req.query.class_id)) throw bad('class_id must be a UUID', 400);
    params.push(req.query.class_id);
    where += ` AND ts.class_id = $${params.length}`;
  }
  if (req.query.weekday !== undefined) {
    const wd = Number(req.query.weekday);
    if (!Number.isInteger(wd) || wd < 1 || wd > 7) throw bad('weekday must be 1..7', 400);
    params.push(wd);
    where += ` AND ts.weekday = $${params.length}`;
  }
  if (req.user.role === 'teacher') {
    const ids = await teacherClassIds(client, req.schoolId, req.user.sub);
    params.push(ids, req.user.sub);
    where += ` AND (ts.class_id = ANY($${params.length - 1}::uuid[]) OR ts.teacher_user_id = $${params.length})`;
  }
  if (req.user.role === 'parent' || req.user.role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (!linked) return { slots: [] };
    const st = await schoolRow(client, req, 'students', linked, 'Student');
    params.push(st.class_id);
    where += ` AND ts.class_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${SLOT_COLS} FROM timetable_slots ts
     JOIN classes c ON c.id = ts.class_id
     LEFT JOIN subjects s ON s.id = ts.subject_id
     LEFT JOIN users u ON u.id = ts.teacher_user_id
     WHERE ${where} ORDER BY ts.weekday, ts.period_no, c.name`,
    params
  );
  return {
    slots: rows.map((r) => ({
      ...r,
      starts_at: r.starts_at ? String(r.starts_at).slice(0, 5) : null,
      ends_at: r.ends_at ? String(r.ends_at).slice(0, 5) : null,
    })),
  };
}));

// One teacher's week (any staff role may look up; teacher: self or
// teachers of their classes — office convenience, still school-scoped).
router.get('/teacher/:userId', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.userId)) throw bad('Invalid user id', 400);
  if (req.user.role === 'parent' || req.user.role === 'student') {
    throw bad('Teacher timetables are staff-only', 403);
  }
  if (req.user.role === 'teacher' && req.params.userId !== req.user.sub) {
    throw bad('Teachers can only view their own timetable here', 403);
  }
  const { rows } = await client.query(
    `SELECT ${SLOT_COLS} FROM timetable_slots ts
     JOIN classes c ON c.id = ts.class_id
     LEFT JOIN subjects s ON s.id = ts.subject_id
     LEFT JOIN users u ON u.id = ts.teacher_user_id
     WHERE ts.school_id = $1 AND ts.teacher_user_id = $2
     ORDER BY ts.weekday, ts.period_no`,
    [req.schoolId, req.params.userId]
  );
  return {
    slots: rows.map((r) => ({
      ...r,
      starts_at: r.starts_at ? String(r.starts_at).slice(0, 5) : null,
      ends_at: r.ends_at ? String(r.ends_at).slice(0, 5) : null,
    })),
  };
}));

router.post('/slots', requireCapability('timetable:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  validateSlotBody(b);
  await schoolRow(client, req, 'classes', b.class_id, 'Class');
  if (b.subject_id) await schoolRow(client, req, 'subjects', b.subject_id, 'Subject');
  if (b.teacher_user_id) {
    const t = await client.query(
      "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'teacher'",
      [b.teacher_user_id, req.schoolId]
    );
    if (t.rows.length === 0) throw bad('teacher_user_id is not a teacher of this school', 400);
  }
  const slot = {
    weekday: b.weekday, period_no: b.period_no,
    starts_at: b.starts_at || null, ends_at: b.ends_at || null,
    teacher_user_id: b.teacher_user_id || null, room: b.room || null,
  };
  await checkClashes(client, req, slot, null);
  try {
    const { rows } = await client.query(
      `INSERT INTO timetable_slots (school_id, class_id, subject_id, teacher_user_id, weekday, period_no, starts_at, ends_at, room, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [req.schoolId, b.class_id, b.subject_id || null, slot.teacher_user_id,
       slot.weekday, slot.period_no, slot.starts_at, slot.ends_at, slot.room, req.user.sub]
    );
    return { slot: { id: rows[0].id, ...slot, class_id: b.class_id, subject_id: b.subject_id || null } };
  } catch (err) {
    if (err.code === '23505') throw bad('That class already has a slot at that weekday and period', 409);
    throw err;
  }
}, 201));

router.patch('/slots/:id', requireCapability('timetable:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid slot id', 400);
  const existing = await schoolRow(client, req, 'timetable_slots', req.params.id, 'Slot');
  const b = req.body || {};
  const merged = {
    class_id: b.class_id !== undefined ? b.class_id : existing.class_id,
    subject_id: b.subject_id !== undefined ? b.subject_id : existing.subject_id,
    teacher_user_id: b.teacher_user_id !== undefined ? b.teacher_user_id : existing.teacher_user_id,
    weekday: b.weekday !== undefined ? b.weekday : existing.weekday,
    period_no: b.period_no !== undefined ? b.period_no : existing.period_no,
    starts_at: b.starts_at !== undefined ? b.starts_at : (existing.starts_at ? String(existing.starts_at).slice(0, 5) : null),
    ends_at: b.ends_at !== undefined ? b.ends_at : (existing.ends_at ? String(existing.ends_at).slice(0, 5) : null),
    room: b.room !== undefined ? b.room : existing.room,
  };
  validateSlotBody(merged);
  await checkClashes(client, req, merged, req.params.id);
  try {
    const { rows } = await client.query(
      `UPDATE timetable_slots
       SET class_id = $3, subject_id = $4, teacher_user_id = $5, weekday = $6,
           period_no = $7, starts_at = $8, ends_at = $9, room = $10
       WHERE school_id = $1 AND id = $2 RETURNING *`,
      [req.schoolId, req.params.id, merged.class_id, merged.subject_id, merged.teacher_user_id,
       merged.weekday, merged.period_no, merged.starts_at, merged.ends_at, merged.room]
    );
    return {
      slot: {
        ...rows[0],
        starts_at: rows[0].starts_at ? String(rows[0].starts_at).slice(0, 5) : null,
        ends_at: rows[0].ends_at ? String(rows[0].ends_at).slice(0, 5) : null,
      },
    };
  } catch (err) {
    if (err.code === '23505') throw bad('That class already has a slot at that weekday and period', 409);
    throw err;
  }
}));

router.delete('/slots/:id', requireCapability('timetable:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid slot id', 400);
  const { rows } = await client.query(
    'DELETE FROM timetable_slots WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Slot not found', 404);
  return { deleted: true };
}));

module.exports = router;
