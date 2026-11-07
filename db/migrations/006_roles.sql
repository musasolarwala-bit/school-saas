-- 006_roles.sql — Phase 1: widen the user role set from 5 to 12.
-- Stage 1 shipped super_admin / school_admin / teacher / parent /
-- student. Phase 1 adds the remaining staff roles from the product
-- spec; what each role may DO is defined by the capability matrix in
-- server/lib/permissions.js and enforced in the route middleware.
-- The CHECK constraint created inline in 002_users.sql is auto-named
-- users_role_check by PostgreSQL.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN (
    'super_admin',
    'school_owner',
    'school_admin',
    'principal',
    'accountant',
    'hr_manager',
    'teacher',
    'parent',
    'student',
    'transport_manager',
    'librarian',
    'receptionist'
  )
);
