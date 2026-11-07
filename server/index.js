'use strict';

// School Manager SaaS — Express app factory + server entry.
// index.js exports createApp() (used by tests on an ephemeral port)
// and boots it when run directly. Routes:
//   GET  /api/health
//   /api/auth/*            (register-school, login, me)
//   /api/admin/*           (super_admin: schools, suspend, activate,
//                           plans, subscriptions, payments)
//   /api/school/users, /api/school/classes, /api/school/students,
//   /api/school/attendance, /api/school/fees, /api/school/settings
//   /api/school/staff, /api/school/staff-attendance, /api/school/subjects,
//   /api/school/sessions, /api/school/dashboard, /api/school/notifications,
//   /api/school/accounts                       (Phase 2 + 3)
//   /api/school/exams, /api/school/homework, /api/school/timetable,
//   /api/school/portal, /api/school/transport, /api/school/library,
//   /api/school/inventory, /api/school/hr, /api/school/analytics,
//   /api/school/reports                        (Phases 4–8)
//   /api/public/*          (unauthenticated school branding only)
//   / (landing), /dashboard.html, /admin.html (static frontend)

const path = require('path');
const express = require('express');
const { requireConfig, port } = require('./config');
const authRoutes = require('./routes/auth');
const schoolsRoutes = require('./routes/schools');
const subscriptionsRoutes = require('./routes/subscriptions');
const usersRoutes = require('./routes/users');
const classesRoutes = require('./routes/classes');
const studentsRoutes = require('./routes/students');
const attendanceRoutes = require('./routes/attendance');
const feesRoutes = require('./routes/fees');
const settingsRoutes = require('./routes/settings');
const publicRoutes = require('./routes/public');
const staffRoutes = require('./routes/staff');
const subjectsRoutes = require('./routes/subjects');
const sessionsRoutes = require('./routes/sessions');
const dashboardRoutes = require('./routes/dashboard');
const notificationsRoutes = require('./routes/notifications');
const staffAttendanceRoutes = require('./routes/staffAttendance');
const accountsRoutes = require('./routes/accounts');
const examsRoutes = require('./routes/exams');
const homeworkRoutes = require('./routes/homework');
const timetableRoutes = require('./routes/timetable');
const portalsRoutes = require('./routes/portals');
const transportRoutes = require('./routes/transport');
const libraryRoutes = require('./routes/library');
const inventoryRoutes = require('./routes/inventory');
const hrRoutes = require('./routes/hr');
const analyticsRoutes = require('./routes/analytics');
const reportsRoutes = require('./routes/reports');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' })); // 1mb: CSV student imports ride in the JSON body
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', schoolsRoutes);
  app.use('/api/admin', subscriptionsRoutes);
  app.use('/api/school/users', usersRoutes);
  app.use('/api/school/classes', classesRoutes);
  app.use('/api/school/students', studentsRoutes);
  app.use('/api/school/attendance', attendanceRoutes);
  app.use('/api/school/fees', feesRoutes);
  app.use('/api/school/settings', settingsRoutes);
  app.use('/api/school/staff', staffRoutes);
  app.use('/api/school/subjects', subjectsRoutes);
  app.use('/api/school/sessions', sessionsRoutes);
  app.use('/api/school/dashboard', dashboardRoutes);
  app.use('/api/school/notifications', notificationsRoutes);
  app.use('/api/school/staff-attendance', staffAttendanceRoutes);
  app.use('/api/school/accounts', accountsRoutes);
  app.use('/api/school/exams', examsRoutes);
  app.use('/api/school/homework', homeworkRoutes);
  app.use('/api/school/timetable', timetableRoutes);
  app.use('/api/school/portal', portalsRoutes);
  app.use('/api/school/transport', transportRoutes);
  app.use('/api/school/library', libraryRoutes);
  app.use('/api/school/inventory', inventoryRoutes);
  app.use('/api/school/hr', hrRoutes);
  app.use('/api/school/analytics', analyticsRoutes);
  app.use('/api/school/reports', reportsRoutes);
  app.use('/api/public', publicRoutes);

  // JSON 404 for unknown API routes.
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Central error handler: honours err.status (validation / 404 / 409
  // cases set it), hides stack traces, and never leaks internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}

if (require.main === module) {
  requireConfig();
  const app = createApp();
  app.listen(port, () => {
    console.log(`School Manager SaaS listening on port ${port}`);
  });
}

module.exports = { createApp };
