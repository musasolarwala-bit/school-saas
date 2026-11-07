'use strict';

// School Manager SaaS — inventory (Phase 6).
// Items with a running quantity; EVERY change goes through a
// movement row written in the same transaction, so the movement
// ledger fully explains the quantity:
//   in      +quantity        out     -quantity (never below 0)
//   damage  -quantity, condition may worsen
//   repair  quantity 0, condition improves (condition_after required)
//   adjust  quantity = the new absolute total (stock-take fix)
// low_stock is computed at read time (quantity <= min_stock).
// Roles: inventory:write = school_admin, school_owner; the
// principal reads (read-all), accountant / teachers have no access.

const express = require('express');
const { requireAuth, requireSchool, requireCapability, withSchoolDb } = require('../lib/middleware');
const { isUuid, isNonEmptyString } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireSchool, requireCapability('inventory:read'));

const CONDITIONS = ['good', 'needs_repair', 'damaged', 'retired'];
const MOVEMENT_TYPES = ['in', 'out', 'adjust', 'damage', 'repair'];

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

function itemOut(r) {
  return { ...r, unit_cost: Number(r.unit_cost), low_stock: r.quantity <= r.min_stock };
}

// ---------------- Categories ----------------

router.get('/categories', withSchoolDb(async (req, client) => {
  const { rows } = await client.query(
    'SELECT * FROM inventory_categories WHERE school_id = $1 ORDER BY name',
    [req.schoolId]
  );
  return { categories: rows };
}));

router.post('/categories', requireCapability('inventory:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 200)) throw bad('name is required', 400);
  try {
    const { rows } = await client.query(
      'INSERT INTO inventory_categories (school_id, name) VALUES ($1, $2) RETURNING *',
      [req.schoolId, b.name.trim()]
    );
    return { category: rows[0] };
  } catch (err) {
    if (err.code === '23505') throw bad('A category with that name already exists', 409);
    throw err;
  }
}, 201));

router.delete('/categories/:id', requireCapability('inventory:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid category id', 400);
  const { rows } = await client.query(
    'DELETE FROM inventory_categories WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Category not found', 404);
  return { deleted: true };
}));

// ---------------- Items ----------------

router.get('/items', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'i.school_id = $1';
  if (req.query.category_id !== undefined) {
    if (!isUuid(req.query.category_id)) throw bad('category_id must be a UUID', 400);
    params.push(req.query.category_id);
    where += ` AND i.category_id = $${params.length}`;
  }
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where += ` AND (i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length})`;
  }
  if (req.query.low_stock === 'true') where += ' AND i.quantity <= i.min_stock';
  const { rows } = await client.query(
    `SELECT i.*, cat.name AS category_name FROM inventory_items i
     LEFT JOIN inventory_categories cat ON cat.id = i.category_id
     WHERE ${where} ORDER BY i.name`,
    params
  );
  return { items: rows.map(itemOut) };
}));

router.post('/items', requireCapability('inventory:write'), withSchoolDb(async (req, client) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name, 300)) throw bad('name is required', 400);
  if (b.category_id !== undefined && b.category_id !== null) {
    if (!isUuid(b.category_id)) throw bad('category_id must be a UUID', 400);
    await schoolRow(client, req, 'inventory_categories', b.category_id, 'Category');
  }
  if (b.condition !== undefined && !CONDITIONS.includes(b.condition)) throw bad('condition is invalid', 400);
  const qty = b.quantity === undefined ? 0 : Number(b.quantity);
  const minStock = b.min_stock === undefined ? 0 : Number(b.min_stock);
  const cost = b.unit_cost === undefined ? 0 : Number(b.unit_cost);
  if (!Number.isInteger(qty) || qty < 0) throw bad('quantity must be an integer >= 0', 400);
  if (!Number.isInteger(minStock) || minStock < 0) throw bad('min_stock must be an integer >= 0', 400);
  if (!Number.isFinite(cost) || cost < 0) throw bad('unit_cost must be a number >= 0', 400);
  try {
    const { rows } = await client.query(
      `INSERT INTO inventory_items (school_id, category_id, name, sku, unit, quantity, min_stock, unit_cost, location, condition)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.schoolId, b.category_id || null, b.name.trim(), b.sku || null, b.unit || 'pcs',
       qty, minStock, cost, b.location || null, b.condition || 'good']
    );
    if (qty > 0) {
      await client.query(
        `INSERT INTO inventory_movements (school_id, item_id, movement_type, quantity, note, recorded_by)
         VALUES ($1, $2, 'in', $3, 'Opening stock', $4)`,
        [req.schoolId, rows[0].id, qty, req.user.sub]
      );
    }
    return { item: itemOut(rows[0]) };
  } catch (err) {
    if (err.code === '23505') throw bad('An item with that SKU already exists', 409);
    throw err;
  }
}, 201));

router.patch('/items/:id', requireCapability('inventory:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid item id', 400);
  await schoolRow(client, req, 'inventory_items', req.params.id, 'Item');
  const b = req.body || {};
  if (b.quantity !== undefined) throw bad('quantity changes go through stock movements, not PATCH', 400);
  if (b.category_id !== undefined && b.category_id !== null) {
    if (!isUuid(b.category_id)) throw bad('category_id must be a UUID', 400);
    await schoolRow(client, req, 'inventory_categories', b.category_id, 'Category');
  }
  if (b.condition !== undefined && !CONDITIONS.includes(b.condition)) throw bad('condition is invalid', 400);
  const sets = ['updated_at = now()'];
  const vals = [req.schoolId, req.params.id];
  const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
  if (b.name !== undefined) {
    if (!isNonEmptyString(b.name, 300)) throw bad('name must be non-empty', 400);
    set('name', b.name.trim());
  }
  if (b.category_id !== undefined) set('category_id', b.category_id || null);
  for (const f of ['sku', 'location', 'condition']) if (b[f] !== undefined) set(f, b[f] || null);
  if (b.unit !== undefined) set('unit', b.unit || 'pcs');
  if (b.min_stock !== undefined) {
    const ms = Number(b.min_stock);
    if (!Number.isInteger(ms) || ms < 0) throw bad('min_stock must be an integer >= 0', 400);
    set('min_stock', ms);
  }
  if (b.unit_cost !== undefined) {
    const cost = Number(b.unit_cost);
    if (!Number.isFinite(cost) || cost < 0) throw bad('unit_cost must be a number >= 0', 400);
    set('unit_cost', cost);
  }
  if (sets.length === 1) throw bad('Nothing to update', 400);
  try {
    const { rows } = await client.query(
      `UPDATE inventory_items SET ${sets.join(', ')} WHERE school_id = $1 AND id = $2 RETURNING *`,
      vals
    );
    return { item: itemOut(rows[0]) };
  } catch (err) {
    if (err.code === '23505') throw bad('An item with that SKU already exists', 409);
    throw err;
  }
}));

router.delete('/items/:id', requireCapability('inventory:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid item id', 400);
  const { rows } = await client.query(
    'DELETE FROM inventory_items WHERE school_id = $1 AND id = $2 RETURNING id',
    [req.schoolId, req.params.id]
  );
  if (rows.length === 0) throw bad('Item not found', 404);
  return { deleted: true };
}));

// ---------------- Movements ----------------

router.get('/movements', withSchoolDb(async (req, client) => {
  const params = [req.schoolId];
  let where = 'm.school_id = $1';
  if (req.query.item_id !== undefined) {
    if (!isUuid(req.query.item_id)) throw bad('item_id must be a UUID', 400);
    params.push(req.query.item_id);
    where += ` AND m.item_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT m.*, i.name AS item_name FROM inventory_movements m
     JOIN inventory_items i ON i.id = m.item_id
     WHERE ${where} ORDER BY m.created_at DESC LIMIT 500`,
    params
  );
  return { movements: rows };
}));

router.post('/items/:id/movements', requireCapability('inventory:write'), withSchoolDb(async (req, client) => {
  if (!isUuid(req.params.id)) throw bad('Invalid item id', 400);
  const item = await schoolRow(client, req, 'inventory_items', req.params.id, 'Item');
  const b = req.body || {};
  if (!MOVEMENT_TYPES.includes(b.movement_type)) {
    throw bad(`movement_type must be one of ${MOVEMENT_TYPES.join(', ')}`, 400);
  }
  const qty = b.quantity === undefined ? 0 : Number(b.quantity);
  if (!Number.isInteger(qty)) throw bad('quantity must be an integer', 400);
  if (b.condition_after !== undefined && b.condition_after !== null && !CONDITIONS.includes(b.condition_after)) {
    throw bad('condition_after is invalid', 400);
  }
  let newQty = item.quantity;
  if (b.movement_type === 'in') {
    if (qty <= 0) throw bad('quantity must be > 0 for a stock-in', 400);
    newQty = item.quantity + qty;
  } else if (b.movement_type === 'out' || b.movement_type === 'damage') {
    if (qty <= 0) throw bad('quantity must be > 0', 400);
    if (qty > item.quantity) throw bad('Not enough stock on hand', 400);
    newQty = item.quantity - qty;
  } else if (b.movement_type === 'adjust') {
    if (qty < 0) throw bad('adjust quantity is the new total and must be >= 0', 400);
    newQty = qty;
  } else if (b.movement_type === 'repair') {
    if (!b.condition_after) throw bad('a repair movement needs condition_after', 400);
  }
  const newCondition = b.condition_after ||
    (b.movement_type === 'damage' ? 'damaged' : item.condition);
  const { rows } = await client.query(
    `INSERT INTO inventory_movements (school_id, item_id, movement_type, quantity, condition_after, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.schoolId, req.params.id, b.movement_type, qty, b.condition_after || null, b.note || null, req.user.sub]
  );
  const upd = await client.query(
    `UPDATE inventory_items SET quantity = $3, condition = $4, updated_at = now()
     WHERE school_id = $1 AND id = $2 RETURNING *`,
    [req.schoolId, req.params.id, newQty, newCondition]
  );
  return { movement: rows[0], item: itemOut(upd.rows[0]) };
}, 201));

module.exports = router;
