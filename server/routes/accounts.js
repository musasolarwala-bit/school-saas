'use strict';

// School Manager SaaS — accounts book (Phase 3).
// Expense categories (per school, defaults seeded lazily on first
// use), expense records, non-fee income records, a daily cashbook
// and a profit & loss summary. Fee income itself lives in
// fee_payments; the cashbook and P&L join it in.
// Reads need fees:read (school_admin, school_owner, accountant,
// principal — the principal stays read-only); writes need fees:write
// (school_admin, school_owner, accountant).

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isNonEmptyString, isDateStr } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool);

const DEFAULT_CATEGORIES = ['Salaries', 'Utilities', 'Rent', 'Maintenance', 'Stationery', 'Transport', 'Other'];
const EXP_COLS = 'id, school_id, category_id, category, amount, spent_on, note, recorded_by, created_at';
const INC_COLS = 'id, school_id, category, amount, received_on, note, recorded_by, created_at';

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertRead(req) {
  if (!can(req.user.role, 'fees:read')) throw bad('Forbidden for this role', 403);
}

function isPositiveAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

async function seedCategories(client, schoolId) {
  for (const name of DEFAULT_CATEGORIES) {
    await client.query(
      'INSERT INTO expense_categories (school_id, name) VALUES ($1, $2) ON CONFLICT (school_id, name) DO NOTHING',
      [schoolId, name]
    );
  }
}

// ---- Categories ----

router.get('/categories', withSchoolDb(async (req, client) => {
  assertRead(req);
  await seedCategories(client, req.schoolId);
  const { rows } = await client.query(
    'SELECT id, school_id, name, created_at FROM expense_categories WHERE school_id = $1 ORDER BY name ASC',
    [req.schoolId]
  );
  return { categories: rows };
}));

router.post('/categories', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  await seedCategories(client, req.schoolId);
  try {
    const { rows } = await client.query(
      'INSERT INTO expense_categories (school_id, name) VALUES ($1, $2) RETURNING id, school_id, name, created_at',
      [req.schoolId, b.name.trim()]
    );
    return { category: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('An expense category with that name already exists', 409);
    throw err;
  }
}, 201));

router.delete('/categories/:id', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid category id', 400);
  const { rows } = await client.query(
    'DELETE FROM expense_categories WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Category not found', 404);
  return { deleted: true };
}));

// ---- Expenses ----

router.get('/expenses', withSchoolDb(async (req, client) => {
  assertRead(req);
  const params = [req.schoolId];
  let where = 'school_id = $1';
  if (req.query.from !== undefined) {
    if (!isDateStr(req.query.from)) throw bad('from must be YYYY-MM-DD', 400);
    params.push(req.query.from);
    where += ` AND spent_on >= $${params.length}`;
  }
  if (req.query.to !== undefined) {
    if (!isDateStr(req.query.to)) throw bad('to must be YYYY-MM-DD', 400);
    params.push(req.query.to);
    where += ` AND spent_on <= $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${EXP_COLS} FROM expense_records WHERE ${where} ORDER BY spent_on DESC, created_at DESC`,
    params
  );
  return { expenses: rows };
}));

router.post('/expenses', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isPositiveAmount(b.amount)) throw bad('amount must be greater than 0', 400);
  if (b.spent_on !== undefined && b.spent_on !== null && !isDateStr(b.spent_on)) {
    throw bad('spent_on must be YYYY-MM-DD', 400);
  }
  let categoryId = null;
  let categoryName = null;
  if (b.category_id) {
    if (!isUuid(b.category_id)) throw bad('category_id must be a UUID', 400);
    const cat = await client.query(
      'SELECT id, name FROM expense_categories WHERE id = $1 AND school_id = $2',
      [b.category_id, req.schoolId]
    );
    if (cat.rows.length === 0) throw bad('Category not found', 404);
    categoryId = cat.rows[0].id;
    categoryName = cat.rows[0].name;
  } else if (isNonEmptyString(b.category, 200)) {
    categoryName = b.category.trim();
  } else {
    throw bad('category_id or category is required', 400);
  }
  const { rows } = await client.query(
    `INSERT INTO expense_records (school_id, category_id, category, amount, spent_on, note, recorded_by)
     VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7) RETURNING ${EXP_COLS}`,
    [req.schoolId, categoryId, categoryName, b.amount, b.spent_on || null, b.note || null, req.user.sub]
  );
  return { expense: rows[0] };
}, 201));

router.delete('/expenses/:id', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid expense id', 400);
  const { rows } = await client.query(
    'DELETE FROM expense_records WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Expense not found', 404);
  return { deleted: true };
}));

// ---- Non-fee income ----

router.get('/income', withSchoolDb(async (req, client) => {
  assertRead(req);
  const params = [req.schoolId];
  let where = 'school_id = $1';
  if (req.query.from !== undefined) {
    if (!isDateStr(req.query.from)) throw bad('from must be YYYY-MM-DD', 400);
    params.push(req.query.from);
    where += ` AND received_on >= $${params.length}`;
  }
  if (req.query.to !== undefined) {
    if (!isDateStr(req.query.to)) throw bad('to must be YYYY-MM-DD', 400);
    params.push(req.query.to);
    where += ` AND received_on <= $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT ${INC_COLS} FROM income_records WHERE ${where} ORDER BY received_on DESC, created_at DESC`,
    params
  );
  return { income: rows };
}));

router.post('/income', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.category, 200)) throw bad('category is required', 400);
  if (!isPositiveAmount(b.amount)) throw bad('amount must be greater than 0', 400);
  if (b.received_on !== undefined && b.received_on !== null && !isDateStr(b.received_on)) {
    throw bad('received_on must be YYYY-MM-DD', 400);
  }
  const { rows } = await client.query(
    `INSERT INTO income_records (school_id, category, amount, received_on, note, recorded_by)
     VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6) RETURNING ${INC_COLS}`,
    [req.schoolId, b.category.trim(), b.amount, b.received_on || null, b.note || null, req.user.sub]
  );
  return { income: rows[0] };
}, 201));

router.delete('/income/:id', requireCapability('fees:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid income id', 400);
  const { rows } = await client.query(
    'DELETE FROM income_records WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Income record not found', 404);
  return { deleted: true };
}));

// ---- Cashbook (one day) + profit & loss (a period) ----

router.get('/cashbook', withSchoolDb(async (req, client) => {
  assertRead(req);
  if (!isDateStr(req.query.date)) throw bad('date must be YYYY-MM-DD', 400);
  const d = req.query.date;
  const fee = await client.query(
    `SELECT id, student_id, plan_id, amount, method, reference, receipt_no, paid_date
     FROM fee_payments WHERE school_id = $1 AND paid_date = $2 ORDER BY created_at ASC`,
    [req.schoolId, d]
  );
  const inc = await client.query(
    `SELECT ${INC_COLS} FROM income_records WHERE school_id = $1 AND received_on = $2 ORDER BY created_at ASC`,
    [req.schoolId, d]
  );
  const exp = await client.query(
    `SELECT ${EXP_COLS} FROM expense_records WHERE school_id = $1 AND spent_on = $2 ORDER BY created_at ASC`,
    [req.schoolId, d]
  );
  const sum = (rows) => rows.reduce((a, r) => a + Number(r.amount), 0);
  const feeIncome = sum(fee.rows);
  const otherIncome = sum(inc.rows);
  const expensesTotal = sum(exp.rows);
  return {
    cashbook: {
      date: d,
      fee_payments: fee.rows,
      income: inc.rows,
      expenses: exp.rows,
      totals: {
        fee_income: feeIncome,
        other_income: otherIncome,
        total_income: feeIncome + otherIncome,
        expenses: expensesTotal,
        net: feeIncome + otherIncome - expensesTotal,
      },
    },
  };
}));

router.get('/profit-loss', withSchoolDb(async (req, client) => {
  assertRead(req);
  if (!isDateStr(req.query.from) || !isDateStr(req.query.to)) {
    throw bad('from and to must be YYYY-MM-DD', 400);
  }
  const { from, to } = req.query;
  const fee = await client.query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM fee_payments WHERE school_id = $1 AND paid_date >= $2 AND paid_date <= $3',
    [req.schoolId, from, to]
  );
  const inc = await client.query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM income_records WHERE school_id = $1 AND received_on >= $2 AND received_on <= $3',
    [req.schoolId, from, to]
  );
  const expByCat = await client.query(
    `SELECT category, COALESCE(SUM(amount), 0) AS total FROM expense_records
     WHERE school_id = $1 AND spent_on >= $2 AND spent_on <= $3
     GROUP BY category ORDER BY category ASC`,
    [req.schoolId, from, to]
  );
  const feeIncome = Number(fee.rows[0].total);
  const otherIncome = Number(inc.rows[0].total);
  const expensesTotal = expByCat.rows.reduce((a, r) => a + Number(r.total), 0);
  return {
    profit_loss: {
      from, to,
      fee_income: feeIncome,
      other_income: otherIncome,
      total_income: feeIncome + otherIncome,
      expenses_by_category: expByCat.rows.map((r) => ({ category: r.category, total: Number(r.total) })),
      total_expenses: expensesTotal,
      net: feeIncome + otherIncome - expensesTotal,
    },
  };
}));

module.exports = router;
