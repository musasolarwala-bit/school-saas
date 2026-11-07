'use strict';

// School Manager SaaS — grading + result computation (Phase 4).
// Grades are computed from marks against the school's grade_bands at
// read time and are NEVER stored: editing the scale re-grades every
// result consistently, and the math in tests / report cards / merit
// lists can never drift apart.
//
// Default bands (used only when a school has not configured its own):
//   A+ 90-100 (4.0) · A 80-89.99 (3.7) · B 70-79.99 (3.0)
//   C 60-69.99 (2.5) · D 50-59.99 (2.0) · E 40-49.99 (1.0)
//   F 0-39.99 (0.0)

const DEFAULT_BANDS = [
  { label: 'A+', min_pct: 90, max_pct: 100, grade_point: 4.0 },
  { label: 'A', min_pct: 80, max_pct: 89.99, grade_point: 3.7 },
  { label: 'B', min_pct: 70, max_pct: 79.99, grade_point: 3.0 },
  { label: 'C', min_pct: 60, max_pct: 69.99, grade_point: 2.5 },
  { label: 'D', min_pct: 50, max_pct: 59.99, grade_point: 2.0 },
  { label: 'E', min_pct: 40, max_pct: 49.99, grade_point: 1.0 },
  { label: 'F', min_pct: 0, max_pct: 39.99, grade_point: 0.0 },
];

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function getBands(client, schoolId) {
  const { rows } = await client.query(
    'SELECT label, min_pct, max_pct, grade_point FROM grade_bands WHERE school_id = $1 ORDER BY min_pct DESC',
    [schoolId]
  );
  if (rows.length === 0) return DEFAULT_BANDS.map((b) => ({ ...b }));
  return rows.map((r) => ({
    label: r.label,
    min_pct: Number(r.min_pct),
    max_pct: Number(r.max_pct),
    grade_point: Number(r.grade_point),
  }));
}

function gradeFor(bands, pct) {
  const p = round2(pct);
  for (const b of bands) {
    if (p >= b.min_pct && p <= b.max_pct) return { grade: b.label, grade_point: b.grade_point };
  }
  // Gap in a custom scale: fall back to the nearest band below.
  const sorted = [...bands].sort((a, b2) => b2.min_pct - a.min_pct);
  for (const b of sorted) {
    if (p >= b.min_pct) return { grade: b.label, grade_point: b.grade_point };
  }
  const lowest = sorted[sorted.length - 1];
  return { grade: lowest.label, grade_point: lowest.grade_point };
}

// Full result for ONE student in ONE term: per-subject rows (every
// exam of the student's class in the term; subjects with several
// exams are summed), totals, overall %, grade, GPA (mean of subject
// grade points) and the student's position within the class.
// Returns null when the term does not exist in this school.
async function studentTermResult(client, schoolId, student, termId, bands) {
  const term = await client.query(
    'SELECT id, name, results_published FROM exam_terms WHERE school_id = $1 AND id = $2',
    [schoolId, termId]
  );
  if (term.rows.length === 0) return null;
  const scale = bands || (await getBands(client, schoolId));
  const { rows } = await client.query(
    `SELECT e.id AS exam_id, e.name AS exam_name, e.subject_id, s.name AS subject_name,
            e.total_marks, m.marks_obtained
     FROM exams e
     JOIN subjects s ON s.id = e.subject_id
     LEFT JOIN exam_marks m ON m.exam_id = e.id AND m.school_id = e.school_id AND m.student_id = $3
     WHERE e.school_id = $1 AND e.term_id = $2 AND e.class_id = $4
     ORDER BY s.name, e.exam_date NULLS LAST, e.name`,
    [schoolId, termId, student.id, student.class_id]
  );
  const bySubject = new Map();
  for (const r of rows) {
    if (!bySubject.has(r.subject_id)) {
      bySubject.set(r.subject_id, {
        subject_id: r.subject_id, subject_name: r.subject_name,
        total: 0, obtained: 0, entered: 0, exams: [],
      });
    }
    const sub = bySubject.get(r.subject_id);
    sub.total += Number(r.total_marks);
    if (r.marks_obtained !== null && r.marks_obtained !== undefined) {
      sub.obtained += Number(r.marks_obtained);
      sub.entered += 1;
    }
    sub.exams.push({
      exam_id: r.exam_id, exam_name: r.exam_name,
      total_marks: Number(r.total_marks),
      marks_obtained: r.marks_obtained === null || r.marks_obtained === undefined
        ? null : Number(r.marks_obtained),
    });
  }
  const subjects = [...bySubject.values()].map((sub) => {
    const pct = sub.total > 0 ? round2((sub.obtained / sub.total) * 100) : 0;
    const g = gradeFor(scale, pct);
    return { ...sub, pct, grade: g.grade, grade_point: g.grade_point };
  });
  const total = subjects.reduce((a, s) => a + s.total, 0);
  const obtained = subjects.reduce((a, s) => a + s.obtained, 0);
  const pct = total > 0 ? round2((obtained / total) * 100) : 0;
  const g = gradeFor(scale, pct);
  const gpa = subjects.length > 0
    ? round2(subjects.reduce((a, s) => a + s.grade_point, 0) / subjects.length)
    : 0;
  return {
    term: { id: term.rows[0].id, name: term.rows[0].name, results_published: term.rows[0].results_published },
    subjects,
    total, obtained, pct, grade: g.grade, gpa,
  };
}

// Positions for every ACTIVE student of a class in a term, ranked by
// total obtained marks (desc); ties share a position (1, 2, 2, 4).
// Returns a Map student_id -> { position, total, obtained, pct }.
async function classPositions(client, schoolId, classId, termId, bands) {
  const { rows } = await client.query(
    "SELECT id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'",
    [schoolId, classId]
  );
  const results = [];
  for (const s of rows) {
    const r = await studentTermResult(client, schoolId, { id: s.id, class_id: classId }, termId, bands);
    if (r) results.push({ student_id: s.id, total: r.total, obtained: r.obtained, pct: r.pct });
  }
  results.sort((a, b) => b.obtained - a.obtained || b.pct - a.pct);
  const map = new Map();
  let lastObtained = null;
  let lastPos = 0;
  results.forEach((r, i) => {
    const pos = r.obtained === lastObtained ? lastPos : i + 1;
    lastObtained = r.obtained;
    lastPos = pos;
    map.set(r.student_id, { position: pos, class_size: results.length, ...r });
  });
  return map;
}

module.exports = { DEFAULT_BANDS, getBands, gradeFor, studentTermResult, classPositions, round2 };
