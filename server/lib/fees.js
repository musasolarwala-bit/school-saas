'use strict';

// School Manager SaaS — shared fee maths (Phase 3).
// One source of truth for "what does this student owe", used by the
// fee summary, voucher generation, the defaulters list and the admin
// dashboard, so the numbers can never drift apart.
//
// Charge model (per student, per fee plan of their class):
//   charge   = plan.amount - discount            (floored at 0)
//   discount = plan.amount * (percent discounts) + (fixed discounts),
//              capped at plan.amount. Discounts with fee_head_id NULL
//              apply to every head; head-specific ones stack with them.
//   pending  = max(0, charge - paid)
//   overdue  = pending > 0 AND due_date has passed
//   fine     = when overdue beyond the grace days, from the school's
//              fee settings: 'flat' charges once, 'per_day' charges
//              per day overdue (after grace). Fines are reported
//              separately from pending; pending never includes a fine.

const { dateStr, todayStr } = require('./validate');

const DEFAULT_SETTINGS = { late_fine_type: 'none', late_fine_amount: 0, late_fine_grace_days: 0 };

async function getFeeSettings(client, schoolId) {
  const { rows } = await client.query(
    'SELECT late_fine_type, late_fine_amount, late_fine_grace_days FROM school_fee_settings WHERE school_id = $1',
    [schoolId]
  );
  if (rows.length === 0) return { ...DEFAULT_SETTINGS };
  return {
    late_fine_type: rows[0].late_fine_type,
    late_fine_amount: Number(rows[0].late_fine_amount),
    late_fine_grace_days: rows[0].late_fine_grace_days,
  };
}

// Whole days from a 'YYYY-MM-DD' date until today (negative if future).
function daysOverdue(dueStr, today) {
  const due = new Date(dueStr + 'T00:00:00Z').getTime();
  const now = new Date(today + 'T00:00:00Z').getTime();
  return Math.round((now - due) / 86400000);
}

function computeFine(settings, dueStr, pending, today) {
  if (!settings || settings.late_fine_type === 'none') return 0;
  if (!dueStr || pending <= 0) return 0;
  const days = daysOverdue(dueStr, today) - (settings.late_fine_grace_days || 0);
  if (days <= 0) return 0;
  if (settings.late_fine_type === 'flat') return Number(settings.late_fine_amount);
  if (settings.late_fine_type === 'per_day') return Number(settings.late_fine_amount) * days;
  return 0;
}

// Per-plan charges for one student. `student` needs { id, class_id }.
// Returns { plans, total, paid, pending, overdue, fine_total } where
// total sums CHARGES (after discount) and overdue sums pending+fine
// over overdue plans.
async function studentCharges(client, schoolId, student, settings) {
  const cfg = settings || (await getFeeSettings(client, schoolId));
  const today = todayStr();
  const planRes = await client.query(
    `SELECT p.id AS plan_id, p.amount, p.due_date, h.id AS fee_head_id, h.name AS fee_head_name,
            COALESCE(pay.paid, 0) AS paid
     FROM fee_plans p
     JOIN fee_heads h ON h.id = p.fee_head_id
     LEFT JOIN (
       SELECT plan_id, SUM(amount) AS paid FROM fee_payments
       WHERE school_id = $1 AND student_id = $2 GROUP BY plan_id
     ) pay ON pay.plan_id = p.id
     WHERE p.school_id = $1 AND p.class_id = $3
     ORDER BY p.due_date NULLS LAST, h.name ASC`,
    [schoolId, student.id, student.class_id]
  );
  const discRes = await client.query(
    `SELECT fee_head_id, discount_type, value FROM student_fee_discounts
     WHERE school_id = $1 AND student_id = $2`,
    [schoolId, student.id]
  );
  const discounts = discRes.rows;
  const plans = planRes.rows.map((r) => {
    const amount = Number(r.amount);
    let pct = 0;
    let fixed = 0;
    for (const d of discounts) {
      if (d.fee_head_id !== null && d.fee_head_id !== r.fee_head_id) continue;
      if (d.discount_type === 'percent') pct += Number(d.value);
      else fixed += Number(d.value);
    }
    const discount = Math.min(amount, Math.round(((amount * pct) / 100 + fixed) * 100) / 100);
    const charge = amount - discount;
    const paid = Number(r.paid);
    const pending = Math.max(0, charge - paid);
    const due = dateStr(r.due_date);
    const overdue = pending > 0 && due !== null && due < today;
    const fine = overdue ? computeFine(cfg, due, pending, today) : 0;
    return {
      plan_id: r.plan_id,
      fee_head_id: r.fee_head_id,
      fee_head_name: r.fee_head_name,
      amount, discount, charge, paid, pending,
      due_date: due, overdue, fine,
    };
  });
  return {
    plans,
    total: plans.reduce((a, p) => a + p.charge, 0),
    paid: plans.reduce((a, p) => a + p.paid, 0),
    pending: plans.reduce((a, p) => a + p.pending, 0),
    overdue: plans.filter((p) => p.overdue).reduce((a, p) => a + p.pending + p.fine, 0),
    fine_total: plans.reduce((a, p) => a + p.fine, 0),
  };
}

// Whole-school outstanding: sum of per-plan pending (charge - paid,
// floored at 0) over ACTIVE students. Computed in SQL; discounts use
// the same rule as studentCharges (percent of amount + fixed, capped).
// Late fines are NOT included (they are a per-student summary figure).
async function schoolOutstanding(client, schoolId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(GREATEST(sp.charge - sp.paid, 0)), 0) AS outstanding
     FROM (
       SELECT
         p.amount - LEAST(p.amount,
           p.amount * (COALESCE(dh.pct, 0) + COALESCE(da.pct, 0)) / 100
           + COALESCE(dh.fixed, 0) + COALESCE(da.fixed, 0)) AS charge,
         COALESCE(pay.paid, 0) AS paid
       FROM students s
       JOIN fee_plans p ON p.school_id = s.school_id AND p.class_id = s.class_id
       LEFT JOIN (
         SELECT plan_id, student_id, SUM(amount) AS paid FROM fee_payments
         WHERE school_id = $1 GROUP BY plan_id, student_id
       ) pay ON pay.plan_id = p.id AND pay.student_id = s.id
       LEFT JOIN (
         SELECT student_id, fee_head_id,
                SUM(CASE WHEN discount_type = 'percent' THEN value ELSE 0 END) AS pct,
                SUM(CASE WHEN discount_type = 'fixed' THEN value ELSE 0 END) AS fixed
         FROM student_fee_discounts WHERE school_id = $1
         GROUP BY student_id, fee_head_id
       ) dh ON dh.student_id = s.id AND dh.fee_head_id = p.fee_head_id
       LEFT JOIN (
         SELECT student_id,
                SUM(CASE WHEN discount_type = 'percent' THEN value ELSE 0 END) AS pct,
                SUM(CASE WHEN discount_type = 'fixed' THEN value ELSE 0 END) AS fixed
         FROM student_fee_discounts WHERE school_id = $1 AND fee_head_id IS NULL
         GROUP BY student_id
       ) da ON da.student_id = s.id
       WHERE s.school_id = $1 AND s.status = 'active'
     ) sp`,
    [schoolId]
  );
  return Number(rows[0].outstanding);
}

module.exports = { getFeeSettings, computeFine, studentCharges, schoolOutstanding, DEFAULT_SETTINGS };
