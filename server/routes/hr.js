'use strict';

// School Manager SaaS — HR: leave requests + payroll (Phase 7).
// Leaves: any staff-linked user may request leave for THEMSELVES
// (their linked staff_profile, or their user row when they have no
// profile); hr:write roles (school_admin, school_owner, hr_manager)
// create for anyone and decide (approve / reject). Decided leaves
// are locked — the decision can only change via a new request.
// Payroll: a run per month (draft -> finalized). Generating fills
// items from ACTIVE staff_profiles: basic + allowances JSON sum -
// deductions, net computed server-side. Items of a DRAFT run may get
// deduction edits; finalizing locks the run permanently. Payslips
// are printable HTML, like the fee receipt.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { can } = require('../lib/permissions');
const { isUuid, isDateStr, isMonthStr, dateStr } = require('../lib/validate');
const { logAudit } = require('../lib/audit');

const router = express.Router();

router.use(requireAuth, requireSchool);

const LEAVE_TYPES = ['sick', 'casual', 'annual', 'unpaid', 'other'];

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function escHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function schoolRow(client, req, table, id, label) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND school_id = $2`, [id, req.schoolId]
  );
  if (rows.length === 0) throw bad(`${label} not found`, 404);
  return rows[0];
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// The caller's own staff profile (via staff_profiles.user_id), if any.
async function ownProfile(client, req) {
  const { rows } = await client.query(
    'SELECT * FROM staff_profiles WHERE school_id = $1 AND user_id = $2',
    [req.schoolId, req.user.sub]
  );
  return rows.length > 0 ? rows[0] : null;
}

// ---------------- Leaves ----------------

router.get('/leaves', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'l.school_id = $1';
  if (req.query.status !== undefined) {
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) throw bad('status filter is invalid', 400);
    params.push(req.query.status);
    where += ` AND l.status = $${params.length}`;
  }
  if (req.query.staff_profile_id !== undefined) {
    if (!isUuid(req.query.staff_profile_id)) throw bad('staff_profile_id must be a UUID', 400);
    params.push(req.query.staff_profile_id);
    where += ` AND l.staff_profile_id = $${params.length}`;
  }
  if (!can(req.user.role, 'hr:read')) {
    // Self-service only: rows tied to the caller's profile / user.
    const profile = await ownProfile(client, req);
    params.push(req.user.sub, profile ? profile.id : null);
    where += ` AND (l.user_id = $${params.length - 1} OR l.staff_profile_id = $${params.length})`;
  }
  const { rows } = await client.query(
    `SELECT l.*, sp.full_name AS staff_name, u.name AS user_name
     FROM leave_requests l
     LEFT JOIN staff_profiles sp ON sp.id = l.staff_profile_id
     LEFT JOIN users u ON u.id = l.user_id
     WHERE ${where} ORDER BY l.created_at DESC`,
    params
  );
  return {
    leaves: rows.map((r) => ({ ...r, from_date: dateStr(r.from_date), to_date: dateStr(r.to_date) })),
  };
}));

router.post('/leaves', withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (b.leave_type !== undefined && !LEAVE_TYPES.includes(b.leave_type)) throw bad('leave_type is invalid', 400);
  if (!isDateStr(b.from_date) || !isDateStr(b.to_date)) throw bad('from_date and to_date must be YYYY-MM-DD', 400);
  if (b.from_date > b.to_date) throw bad('from_date must be on or before to_date', 400);
  let staffProfileId = b.staff_profile_id || null;
  let userId = b.user_id || null;
  if (can(req.user.role, 'hr:write')) {
    if (staffProfileId) {
      if (!isUuid(staffProfileId)) throw bad('staff_profile_id must be a UUID', 400);
      await schoolRow(client, req, 'staff_profiles', staffProfileId, 'Staff profile');
    }
    if (userId) {
      if (!isUuid(userId)) throw bad('user_id must be a UUID', 400);
      await schoolRow(client, req, 'users', userId, 'User');
    }
    if (!staffProfileId && !userId) throw bad('staff_profile_id or user_id is required', 400);
  } else {
    // Self-service: the leave is for the caller, never for someone
    // else — any staff_profile_id / user_id in the body is ignored.
    const profile = await ownProfile(client, req);
    staffProfileId = profile ? profile.id : null;
    userId = req.user.sub;
  }
  const { rows } = await client.query(
    `INSERT INTO leave_requests (school_id, staff_profile_id, user_id, leave_type, from_date, to_date, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.schoolId, staffProfileId, userId, b.leave_type || 'casual', b.from_date, b.to_date, b.reason || null]
  );
  return { leave: { ...rows[0], from_date: dateStr(rows[0].from_date), to_date: dateStr(rows[0].to_date) } };
}, 201));

router.post('/leaves/:id/decide', requireCapability('hr:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid leave id', 400);
  const leave = await schoolRow(client, req, 'leave_requests', req.params.id, 'Leave request');
  const b = req.body || {};
  if (!['approved', 'rejected', 'cancelled'].includes(b.status)) {
    throw bad('status must be approved, rejected or cancelled', 400);
  }
  if (leave.status !== 'pending') throw bad('This leave request is already decided', 409);
  const { rows } = await client.query(
    `UPDATE leave_requests
     SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5, updated_at = now()
     WHERE school_id = $1 AND id = $2 RETURNING *`,
    [req.schoolId, req.params.id, b.status, req.user.sub, b.note || null]
  );
  return { leave: { ...rows[0], from_date: dateStr(rows[0].from_date), to_date: dateStr(rows[0].to_date) } };
}));

// The owner of a pending request (or an hr:write role) may withdraw it.
router.post('/leaves/:id/cancel', withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid leave id', 400);
  const leave = await schoolRow(client, req, 'leave_requests', req.params.id, 'Leave request');
  if (leave.status !== 'pending') throw bad('Only a pending request can be cancelled', 409);
  if (!can(req.user.role, 'hr:write')) {
    const profile = await ownProfile(client, req);
    const mine = leave.user_id === req.user.sub || (profile && leave.staff_profile_id === profile.id);
    if (!mine) throw bad('You can only cancel your own leave request', 403);
  }
  const { rows } = await client.query(
    `UPDATE leave_requests SET status = 'cancelled', updated_at = now()
     WHERE school_id = $1 AND id = $2 RETURNING *`,
    [req.schoolId, req.params.id]
  );
  return { leave: { ...rows[0], from_date: dateStr(rows[0].from_date), to_date: dateStr(rows[0].to_date) } };
}));

// ---------------- Payroll ----------------

const RUN_COLS = 'id, school_id, month, status, created_at, finalized_at';

router.get('/payroll/runs', requireCapability('hr:read'), withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    `SELECT ${RUN_COLS},
            (SELECT COUNT(*)::int FROM payroll_items i WHERE i.run_id = payroll_runs.id AND i.school_id = $1) AS item_count,
            (SELECT COALESCE(SUM(net), 0) FROM payroll_items i WHERE i.run_id = payroll_runs.id AND i.school_id = $1) AS total_net
     FROM payroll_runs WHERE school_id = $1 ORDER BY month DESC`,
    [req.schoolId]
  );
  return { runs: rows.map((r) => ({ ...r, total_net: Number(r.total_net) })) };
}));

router.post('/payroll/runs', requireCapability('hr:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isMonthStr(b.month)) throw bad('month must be YYYY-MM', 400);
  try {
    const { rows } = await client.query(
      `INSERT INTO payroll_runs (school_id, month, created_by) VALUES ($1, $2, $3) RETURNING ${RUN_COLS}`,
      [req.schoolId, b.month, req.user.sub]
    );
    return { run: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A payroll run already exists for that month', 409);
    throw err;
  }
}, 201));

async function loadRun(client, req, runId) {
  if (!isUuid(runId)) throw bad('Invalid run id', 400);
  return schoolRow(client, req, 'payroll_runs', runId, 'Payroll run');
}

// (Re)build a DRAFT run's items from current active staff profiles.
// Re-running replaces the items (deduction edits are lost — that is
// the documented behaviour; finalize to lock a run).
router.post('/payroll/runs/:id/generate', requireCapability('hr:write'), withSchoolDb(async (req, client) => {
  const run = await loadRun(client, req, req.params.id);
  if (run.status === 'finalized') throw bad('This payroll run is finalized and locked', 409);
  const staff = await client.query(
    "SELECT * FROM staff_profiles WHERE school_id = $1 AND status = 'active' ORDER BY full_name",
    [req.schoolId]
  );
  await client.query('DELETE FROM payroll_items WHERE school_id = $1 AND run_id = $2', [req.schoolId, run.id]);
  let total = 0;
  for (const s of staff.rows) {
    const allowances = s.salary_allowances || {};
    const allowancesTotal = round2(Object.values(allowances).reduce((a, v) => a + Number(v || 0), 0));
    const basic = round2(s.salary_basic);
    const net = round2(basic + allowancesTotal);
    total += net;
    await client.query(
      `INSERT INTO payroll_items (school_id, run_id, staff_profile_id, basic, allowances_total, allowances, deductions, net)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
      [req.schoolId, run.id, s.id, basic, allowancesTotal, JSON.stringify(allowances), net]
    );
  }
  return { generated: staff.rows.length, total_net: round2(total) };
}, 201));

router.get('/payroll/runs/:id/items', requireCapability('hr:read'), withSchoolDb(async (req, client) => {
  const run = await loadRun(client, req, req.params.id);
  const { rows } = await client.query(
    `SELECT i.*, sp.full_name AS staff_name, sp.designation
     FROM payroll_items i JOIN staff_profiles sp ON sp.id = i.staff_profile_id
     WHERE i.school_id = $1 AND i.run_id = $2 ORDER BY sp.full_name`,
    [req.schoolId, run.id]
  );
  return {
    run: { id: run.id, month: run.month, status: run.status },
    items: rows.map((r) => ({
      ...r,
      basic: Number(r.basic), allowances_total: Number(r.allowances_total),
      deductions: Number(r.deductions), net: Number(r.net),
    })),
  };
}));

// Deduction edit on a DRAFT item; net is recomputed server-side.
router.patch('/payroll/items/:id', requireCapability('hr:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid item id', 400);
  const item = await schoolRow(client, req, 'payroll_items', req.params.id, 'Payroll item');
  const run = await loadRun(client, req, item.run_id);
  if (run.status === 'finalized') throw bad('This payroll run is finalized and locked', 409);
  const deductions = Number((req.body || {}).deductions);
  if (!Number.isFinite(deductions) || deductions < 0) throw bad('deductions must be a number >= 0', 400);
  const net = round2(Number(item.basic) + Number(item.allowances_total) - deductions);
  if (net < 0) throw bad('deductions cannot exceed basic + allowances', 400);
  const { rows } = await client.query(
    `UPDATE payroll_items SET deductions = $3, net = $4, updated_at = now()
     WHERE school_id = $1 AND id = $2 RETURNING *`,
    [req.schoolId, req.params.id, deductions, net]
  );
  return {
    item: {
      ...rows[0],
      basic: Number(rows[0].basic), allowances_total: Number(rows[0].allowances_total),
      deductions: Number(rows[0].deductions), net: Number(rows[0].net),
    },
  };
}));

router.post('/payroll/runs/:id/finalize', requireCapability('hr:write'), withSchoolDb(async (req, client) => {
  const run = await loadRun(client, req, req.params.id);
  if (run.status === 'finalized') throw bad('This payroll run is already finalized', 409);
  const count = await client.query(
    'SELECT COUNT(*)::int AS n FROM payroll_items WHERE school_id = $1 AND run_id = $2',
    [req.schoolId, run.id]
  );
  if (count.rows[0].n === 0) throw bad('Generate the payroll before finalizing it', 400);
  const { rows } = await client.query(
    `UPDATE payroll_runs SET status = 'finalized', finalized_by = $3, finalized_at = now()
     WHERE school_id = $1 AND id = $2 RETURNING ${RUN_COLS}`,
    [req.schoolId, run.id, req.user.sub]
  );
  await logAudit(client, req, 'payroll.finalize', 'payroll_run', run.id, {
    month: run.month, items: count.rows[0].n,
  });
  return { run: rows[0] };
}));

// Printable payslip for one payroll item.
router.get('/payroll/payslip/:itemId', requireCapability('hr:read'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.itemId)) throw bad('Invalid item id', 400);
  const { rows } = await client.query(
    `SELECT i.*, sp.full_name AS staff_name, sp.designation, sp.department,
            r.month, r.status AS run_status,
            sc.name AS school_name, sc.display_name, sc.primary_color
     FROM payroll_items i
     JOIN staff_profiles sp ON sp.id = i.staff_profile_id
     JOIN payroll_runs r ON r.id = i.run_id
     JOIN schools sc ON sc.id = i.school_id
     WHERE i.school_id = $1 AND i.id = $2`,
    [req.schoolId, req.params.itemId]
  );
  if (rows.length === 0) throw bad('Payroll item not found', 404);
  const p = rows[0];
  const allowances = p.allowances || {};
  const allowRows = Object.entries(allowances).map(([k, v]) =>
    `<tr><td class="k">${escHtml(k)}</td><td>Rs ${Number(v).toLocaleString('en-US')}</td></tr>`).join('');
  const schoolName = p.display_name || p.school_name;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Payslip — ${escHtml(p.staff_name)} — ${escHtml(p.month)}</title>
<style>body{font-family:system-ui,sans-serif;margin:40px;color:#1F2937}
.head{border-bottom:3px solid ${escHtml(p.primary_color || '#1d6fb8')};padding-bottom:8px;margin-bottom:16px}
table{border-collapse:collapse}td{padding:6px 14px 6px 0;font-size:15px}
.k{color:#6B7280}@media print{button{display:none}}</style></head>
<body>
<div class="head"><h1>${escHtml(schoolName)}</h1><p>Payslip — ${escHtml(p.month)} (${escHtml(p.run_status)})</p></div>
<table>
<tr><td class="k">Staff</td><td><strong>${escHtml(p.staff_name)}</strong></td></tr>
<tr><td class="k">Designation</td><td>${escHtml(p.designation || '')}${p.department ? ' · ' + escHtml(p.department) : ''}</td></tr>
<tr><td class="k">Basic salary</td><td>Rs ${Number(p.basic).toLocaleString('en-US')}</td></tr>
${allowRows}
<tr><td class="k">Allowances total</td><td>Rs ${Number(p.allowances_total).toLocaleString('en-US')}</td></tr>
<tr><td class="k">Deductions</td><td>Rs ${Number(p.deductions).toLocaleString('en-US')}</td></tr>
<tr><td class="k">Net pay</td><td><strong>Rs ${Number(p.net).toLocaleString('en-US')}</strong></td></tr>
</table>
<p><button onclick="window.print()">Print</button></p>
</body></html>`;
  const res = req.res;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
  return undefined;
}));

module.exports = router;
