'use strict';

// School Manager SaaS — library (Phase 6).
// Books carry copies_total / copies_available; issuing and returning
// update availability in the same transaction as the loan row, so
// the shelf count can never drift from the loan ledger. Overdue is
// computed at read time (due_on passed, no return). A flat fine of
// Rs 10/day is REPORTED on late returns (LIBRARY_FINE_PER_DAY) — it
// is not auto-charged; collecting it is a fees-module decision.
// Roles: library:write = school_admin, school_owner, librarian.
// Parents/students see only their linked child's loans.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isUuid, isNonEmptyString, dateStr, todayStr } = require('../lib/validate');
const { linkedStudentId } = require('../lib/scope');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('library:read'));

const LIBRARY_FINE_PER_DAY = 10;
const DEFAULT_LOAN_DAYS = 14;

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

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// ---------------- Books ----------------

router.get('/books', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'school_id = $1';
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where += ` AND (title ILIKE $${params.length} OR author ILIKE $${params.length} OR isbn ILIKE $${params.length})`;
  }
  if (req.query.category) {
    params.push(String(req.query.category).trim());
    where += ` AND category = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT *, (SELECT COUNT(*)::int FROM library_loans l
                 WHERE l.book_id = library_books.id AND l.school_id = $1 AND l.returned_on IS NULL) AS on_loan
     FROM library_books WHERE ${where} ORDER BY title`,
    params
  );
  return { books: rows };
}));

router.post('/books', requireCapability('library:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.title, 300)) throw bad('title is required', 400);
  const copies = b.copies_total === undefined ? 1 : Number(b.copies_total);
  if (!Number.isInteger(copies) || copies < 0) throw bad('copies_total must be an integer >= 0', 400);
  try {
    const { rows } = await client.query(
      `INSERT INTO library_books (school_id, title, author, isbn, category, copies_total, copies_available)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
      [req.schoolId, b.title.trim(), b.author || null, b.isbn || null, b.category || null, copies]
    );
    return { book: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A book with that ISBN already exists in this school', 409);
    throw err;
  }
}, 201));

router.patch('/books/:id', requireCapability('library:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid book id', 400);
  const book = await schoolRow(client, req, 'library_books', req.params.id, 'Book');
  const b = req.body || {};
  const sets = [];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.title !== undefined) {
    if (!isNonEmptyString(b.title, 300)) throw bad('title must be non-empty', 400);
    set('title', b.title.trim());
  }
  for (const f of ['author', 'isbn', 'category']) if (b[f] !== undefined) set(f, b[f] || null);
  if (b.copies_total !== undefined) {
    const copies = Number(b.copies_total);
    if (!Number.isInteger(copies) || copies < 0) throw bad('copies_total must be an integer >= 0', 400);
    const onLoan = book.copies_total - book.copies_available;
    if (copies < onLoan) throw bad('copies_total cannot go below the copies currently on loan', 400);
    set('copies_total', copies);
    set('copies_available', copies - onLoan);
  }
  if (sets.length === 0) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE library_books SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING *`,
      vals
    );
    return { book: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A book with that ISBN already exists in this school', 409);
    throw err;
  }
}));

router.delete('/books/:id', requireCapability('library:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid book id', 400);
  const book = await schoolRow(client, req, 'library_books', req.params.id, 'Book');
  if (book.copies_total - book.copies_available > 0) {
    throw bad('Copies of this book are still on loan', 409);
  }
  await client.query('DELETE FROM library_books WHERE school_id = $1 AND id = $2', [req.schoolId, req.params.id]);
  return { deleted: true };
}));

// ---------------- Loans ----------------

const LOAN_COLS = 'l.id, l.school_id, l.book_id, l.student_id, l.staff_profile_id, l.issued_on, l.due_on, l.returned_on, l.created_at, '
  + 'bk.title AS book_title, s.name AS student_name, sp.full_name AS staff_name';

function loanOut(r) {
  const today = todayStr();
  const due = dateStr(r.due_on);
  const returned = dateStr(r.returned_on);
  const overdueDays = !returned && due < today ? daysBetween(due, today) : 0;
  return {
    ...r,
    issued_on: dateStr(r.issued_on),
    due_on: due,
    returned_on: returned,
    status: returned ? 'returned' : (overdueDays > 0 ? 'overdue' : 'issued'),
    days_overdue: overdueDays,
  };
}

router.get('/loans', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'l.school_id = $1';
  if (req.query.student_id !== undefined) {
    if (!isUuid(req.query.student_id)) throw bad('student_id must be a UUID', 400);
    params.push(req.query.student_id);
    where += ` AND l.student_id = $${params.length}`;
  }
  if (req.query.active === 'true') where += ' AND l.returned_on IS NULL';
  if (req.query.overdue === 'true') where += ' AND l.returned_on IS NULL AND l.due_on < CURRENT_DATE';
  if (req.user.role === 'parent' || req.user.role === 'student') {
    const linked = await linkedStudentId(client, req.user);
    if (!linked) return { loans: [] };
    params.push(linked);
    where += ` AND l.student_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${LOAN_COLS} FROM library_loans l
     JOIN library_books bk ON bk.id = l.book_id
     LEFT JOIN students s ON s.id = l.student_id
     LEFT JOIN staff_profiles sp ON sp.id = l.staff_profile_id
     WHERE ${where} ORDER BY l.issued_on DESC, l.created_at DESC`,
    params
  );
  return { loans: rows.map(loanOut) };
}));

router.post('/loans', requireCapability('library:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isUuid(b.book_id)) throw bad('book_id must be a UUID', 400);
  const hasStudent = b.student_id !== undefined && b.student_id !== null;
  const hasStaff = b.staff_profile_id !== undefined && b.staff_profile_id !== null;
  if (hasStudent === hasStaff) throw bad('give exactly one of student_id / staff_profile_id', 400);
  const book = await schoolRow(client, req, 'library_books', b.book_id, 'Book');
  if (hasStudent) {
    if (!isUuid(b.student_id)) throw bad('student_id must be a UUID', 400);
    await schoolRow(client, req, 'students', b.student_id, 'Student');
  } else {
    if (!isUuid(b.staff_profile_id)) throw bad('staff_profile_id must be a UUID', 400);
    await schoolRow(client, req, 'staff_profiles', b.staff_profile_id, 'Staff profile');
  }
  if (book.copies_available <= 0) throw bad('No copies of this book are available', 409);
  let due = b.due_on;
  if (due === undefined || due === null) {
    const d = new Date(Date.now() + DEFAULT_LOAN_DAYS * 86400000);
    due = d.toISOString().slice(0, 10);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw bad('due_on must be YYYY-MM-DD', 400);
  }
  const { rows } = await client.query(
    `INSERT INTO library_loans (school_id, book_id, student_id, staff_profile_id, due_on, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.schoolId, b.book_id, hasStudent ? b.student_id : null, hasStaff ? b.staff_profile_id : null, due, req.user.sub]
  );
  await client.query(
    'UPDATE library_books SET copies_available = copies_available - 1 WHERE school_id = $1 AND id = $2',
    [req.schoolId, b.book_id]
  );
  return { loan: loanOut({ ...rows[0], book_title: book.title, student_name: null, staff_name: null }) };
}, 201));

router.post('/loans/:id/return', requireCapability('library:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid loan id', 400);
  const loan = await schoolRow(client, req, 'library_loans', req.params.id, 'Loan');
  if (loan.returned_on) throw bad('This loan is already returned', 409);
  const today = todayStr();
  const due = dateStr(loan.due_on);
  const daysLate = due < today ? daysBetween(due, today) : 0;
  const { rows } = await client.query(
    `UPDATE library_loans SET returned_on = CURRENT_DATE
     WHERE school_id = $1 AND id = $2 RETURNING *`,
    [req.schoolId, req.params.id]
  );
  await client.query(
    'UPDATE library_books SET copies_available = copies_available + 1 WHERE school_id = $1 AND id = $2',
    [req.schoolId, loan.book_id]
  );
  return {
    loan: loanOut(rows[0]),
    days_late: daysLate,
    fine: daysLate * LIBRARY_FINE_PER_DAY,
    fine_per_day: LIBRARY_FINE_PER_DAY,
  };
}));

module.exports = router;
