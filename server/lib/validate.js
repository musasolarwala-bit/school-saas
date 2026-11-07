'use strict';

// School Manager SaaS — small server-side validators.
// Every route validates its inputs here; the frontend never decides
// what is allowed.

function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

function isSlug(v) {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(v);
}

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.trim().length > 0 && (!maxLen || v.trim().length <= maxLen);
}

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

function isDateStr(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function isMonthStr(v) {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

// Normalise any date-ish value to a 'YYYY-MM-DD' string (or null).
// DATE columns arrive as raw strings already (see the OID-1082 type
// parser in lib/db.js); Date instances are converted via UTC, which
// is only used for genuine instants, never for stored calendar dates.
function dateStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Returns an error string, or null when the value is fine.
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    return 'Password must be at least 8 characters';
  }
  return null;
}

// Collects validation errors; routes return 400 with the list.
function validate(checks) {
  const errors = [];
  for (const [ok, message] of checks) {
    if (!ok) errors.push(message);
  }
  return errors;
}

module.exports = {
  isEmail, isSlug, isUuid, isNonEmptyString, isHexColor,
  isDateStr, isMonthStr, dateStr, todayStr, checkPassword, validate,
};
