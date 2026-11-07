'use strict';

// School Manager SaaS — role -> capability matrix (Phase 1).
// Stage 1 had 5 roles and scattered requireRole(...) lists. Phase 1
// widens the set to 12 roles; this module is the SINGLE source of
// truth for what each role may do, and routes enforce it via
// requireCapability() (server/lib/middleware.js) or can() for
// in-handler checks. Route handlers still apply their finer scoping
// on top (teacher -> own classes only, parent/student -> linked child
// only); a capability never widens that scoping.
//
// Capability guide:
//   platform:admin   super-admin panel (schools, plans, subscriptions)
//   users:manage     create / list / deactivate users of the school
//   students:read    read student records (scope decided by the route)
//   students:write   create / edit / delete students
//   classes:read     read classes (scope decided by the route)
//   classes:write    create / edit / delete classes
//   attendance:read  read attendance (sheet: staff roles; summary:
//                    also parent/student for their linked child)
//   attendance:write mark / re-mark attendance
//   fees:read        fee summaries + payment lists (parent/student:
//                    their linked child only, enforced in the route)
//   fees:write       fee heads, fee plans, recording payments
//   settings:write   school settings + branding (own school only)
//   exams:read       exam terms, exams, marks, results (parent/student:
//                    published results of their linked child only)
//   exams:write      terms, exams, grading scale, bulk marks entry,
//                    result publication (teacher: own classes/subjects)
//   homework:read    homework lists (scope decided by the route)
//   homework:write   create/edit homework, check submissions
//                    (teacher: own classes)
//   timetable:read   class / teacher timetables (own scope for
//                    teacher + parent/student)
//   timetable:write  timetable slot CRUD (office roles only)
//   transport:read   vehicles, routes, stops, assignments, manifests
//   transport:write  transport CRUD + manifest marking
//   library:read     books + loans (parent/student: linked child only)
//   library:write    book CRUD, issue / return
//   inventory:read   inventory items, categories, movements
//   inventory:write  item/category CRUD + stock movements
//   hr:read          leave requests + payroll runs (self: own rows)
//   hr:write         leave decisions, payroll generate / finalize
//   analytics:read   school analytics (real aggregates only)
//   reports:read     report-centre CSV exports
//   audit:read       the school's audit log
//
// Phases 4–8 scoping decisions:
//   principal        read-all on every module incl. analytics,
//                    reports and audit — still writes nothing.
//   accountant       gains reports:read (accounts reporting) only.
//   hr_manager       gains hr read+write (leaves, payroll) and
//                    analytics:read is NOT granted (payroll data only
//                    through the HR module).
//   teacher          exams + homework read/write inside their
//                    assigned-class scope; timetable read.
//   transport_manager / librarian
//                    full read+write of their own module.
//   receptionist     read-only front-desk lookups (timetable,
//                    transport, library).
//   parent / student exams + homework + timetable + library +
//                    transport read, always scoped to the linked
//                    student in the routes.
//
// Deliberate scoping decisions:
//   principal        read-all school data (students, classes,
//                    attendance, fees) — approves/monitors, writes
//                    nothing, no user management, no school suspend.
//   accountant       fees read+write and student read (to find who
//                    owes what) — cannot write/delete students.
//   hr_manager       staff/user management only — no fees at all.
//   transport_manager, librarian, receptionist
//                    their modules arrive in later phases; for now
//                    they get basic student + class read (front-desk
//                    and route/library lookups) and are gated OUT of
//                    fees, attendance writes and user management.
//   school_owner     same capabilities as school_admin (own school).

const ROLES = [
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
  'receptionist',
];

const SCHOOL_ROLES = ROLES.filter((r) => r !== 'super_admin');

const ADMIN_CAPS = [
  'users:manage', 'students:read', 'students:write',
  'classes:read', 'classes:write',
  'attendance:read', 'attendance:write',
  'fees:read', 'fees:write', 'settings:write',
  'exams:read', 'exams:write', 'homework:read', 'homework:write',
  'timetable:read', 'timetable:write',
  'transport:read', 'transport:write',
  'library:read', 'library:write',
  'inventory:read', 'inventory:write',
  'hr:read', 'hr:write', 'analytics:read', 'reports:read', 'audit:read',
];

const ROLE_CAPABILITIES = {
  super_admin: ['platform:admin'],
  school_owner: [...ADMIN_CAPS],
  school_admin: [...ADMIN_CAPS],
  principal: [
    'students:read', 'classes:read', 'attendance:read', 'fees:read',
    'exams:read', 'homework:read', 'timetable:read',
    'transport:read', 'library:read', 'inventory:read', 'hr:read',
    'analytics:read', 'reports:read', 'audit:read',
  ],
  accountant: ['students:read', 'fees:read', 'fees:write', 'reports:read'],
  hr_manager: ['users:manage', 'students:read', 'hr:read', 'hr:write'],
  teacher: [
    'students:read', 'classes:read', 'attendance:read', 'attendance:write',
    'exams:read', 'exams:write', 'homework:read', 'homework:write',
    'timetable:read',
  ],
  parent: [
    'students:read', 'attendance:read', 'fees:read',
    'exams:read', 'homework:read', 'timetable:read',
    'library:read', 'transport:read',
  ],
  student: [
    'students:read', 'attendance:read', 'fees:read',
    'exams:read', 'homework:read', 'timetable:read',
    'library:read', 'transport:read',
  ],
  transport_manager: [
    'students:read', 'classes:read', 'transport:read', 'transport:write',
  ],
  librarian: [
    'students:read', 'classes:read', 'library:read', 'library:write',
  ],
  receptionist: [
    'students:read', 'classes:read', 'timetable:read',
    'transport:read', 'library:read',
  ],
};

function can(role, capability) {
  const caps = ROLE_CAPABILITIES[role];
  return Array.isArray(caps) && caps.includes(capability);
}

// Roles holding a capability (useful for role-list route gates that
// must stay explicit, e.g. fee config reads incl. principal).
function rolesWith(capability) {
  return ROLES.filter((r) => can(r, capability));
}

module.exports = { ROLES, SCHOOL_ROLES, ROLE_CAPABILITIES, can, rolesWith };
