'use strict';

// School Manager SaaS — role scoping helpers shared by routes.
// A teacher's classes are those they are the class teacher of
// (classes.teacher_id) PLUS any class they teach a subject in
// (teacher_subjects, Phase 2). Both count as "assigned" everywhere:
// student lists, attendance marking, dashboards.
// Parent/student accounts see only their linked student record.

// Ids of the classes a teacher user is assigned to in this school.
async function teacherClassIds(client, schoolId, userId) {
  const { rows } = await client.query(
    `SELECT id FROM classes WHERE school_id = $1 AND teacher_id = $2
     UNION
     SELECT class_id AS id FROM teacher_subjects
     WHERE school_id = $1 AND teacher_user_id = $2`,
    [schoolId, userId]
  );
  return rows.map((r) => r.id);
}

// The student id a parent/student account is linked to (null for
// other roles, or when the account has no link).
async function linkedStudentId(client, user) {
  if (!user || (user.role !== 'parent' && user.role !== 'student')) return null;
  const { rows } = await client.query(
    'SELECT linked_student_id FROM users WHERE id = $1 AND school_id = $2',
    [user.sub, user.school_id]
  );
  return rows.length > 0 ? rows[0].linked_student_id : null;
}

module.exports = { teacherClassIds, linkedStudentId };
