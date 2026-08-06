import { randomBytes, randomUUID } from 'node:crypto';
import { db, nowIso } from './database.js';

export type AssignmentRow = {
  id: string;
  practice_id: string;
  patient_id: string;
  template_id: string;
  assigned_by: string;
  token: string;
  status: 'pending' | 'in_progress' | 'completed' | 'expired';
  submission_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export function createAssignment(input: {
  practiceId: string;
  patientId: string;
  templateId: string;
  assignedBy: string;
  expiresInDays?: number;
}): AssignmentRow {
  const id = randomUUID();
  const token = randomBytes(16).toString('hex');
  const days = input.expiresInDays ?? 7;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const now = nowIso();

  db.prepare(
    `insert into form_assignments
      (id, practice_id, patient_id, template_id, assigned_by, token, status, submission_id, expires_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'pending', null, ?, ?, ?)`,
  ).run(id, input.practiceId, input.patientId, input.templateId, input.assignedBy, token, expiresAt, now, now);

  return getAssignmentByIdOrThrow(id);
}

export function getAssignmentByToken(token: string): AssignmentRow | undefined {
  return db.prepare('select * from form_assignments where token = ?').get(token) as AssignmentRow | undefined;
}

export function getAssignmentById(id: string): AssignmentRow | undefined {
  return db.prepare('select * from form_assignments where id = ?').get(id) as AssignmentRow | undefined;
}

export function getAssignmentByIdOrThrow(id: string): AssignmentRow {
  const row = getAssignmentById(id);
  if (!row) throw new Error('Assignment not found');
  return row;
}

export function listAssignmentsForPractice(practiceId: string): Array<Record<string, unknown>> {
  return db
    .prepare(
      `select
        fa.id, fa.token, fa.status, fa.expires_at, fa.created_at, fa.submission_id, fa.patient_id,
        p.child_first_name, p.child_last_name, p.child_dob,
        t.name as template_name, t.template_key,
        su.email as assigned_by_email,
        na.next_appointment_date, na.next_appointment_time
       from form_assignments fa
       join patients p on p.id = fa.patient_id
       join pdf_templates t on t.id = fa.template_id
       join staff_users su on su.id = fa.assigned_by
       left join (
         select patient_id, appointment_date as next_appointment_date, appointment_time as next_appointment_time
         from (
           select patient_id, appointment_date, appointment_time,
                  row_number() over (partition by patient_id order by created_at desc, id desc) as rn
           from appointments
         ) x where rn = 1
       ) na on na.patient_id = p.id
       where fa.practice_id = ?
       order by fa.created_at desc`,
    )
    .all(practiceId) as Array<Record<string, unknown>>;
}

/** True when patient already has a non-expired pending/in_progress assignment for this template. */
export function hasActiveAssignmentForPatientTemplate(
  patientId: string,
  practiceId: string,
  templateId: string,
): boolean {
  const row = db
    .prepare(
      `select id from form_assignments
       where patient_id = ? and practice_id = ? and template_id = ?
         and status in ('pending', 'in_progress')
         and datetime(replace(substr(expires_at, 1, 19), 'T', ' ')) >= datetime('now')`,
    )
    .get(patientId, practiceId, templateId);
  return Boolean(row);
}

export function listAssignmentsForPatient(patientId: string, practiceId: string): Array<Record<string, unknown>> {
  return db
    .prepare(
      `select
        fa.id, fa.token, fa.status, fa.expires_at, fa.created_at, fa.submission_id,
        t.name as template_name, t.template_key,
        su.email as assigned_by_email
       from form_assignments fa
       join pdf_templates t on t.id = fa.template_id
       join staff_users su on su.id = fa.assigned_by
       where fa.patient_id = ? and fa.practice_id = ?
       order by fa.created_at desc`,
    )
    .all(patientId, practiceId) as Array<Record<string, unknown>>;
}

export function updateAssignment(
  id: string,
  updates: { status?: AssignmentRow['status']; submissionId?: string },
): void {
  const now = nowIso();
  if (updates.status !== undefined && updates.submissionId !== undefined) {
    db.prepare('update form_assignments set status = ?, submission_id = ?, updated_at = ? where id = ?').run(
      updates.status,
      updates.submissionId,
      now,
      id,
    );
  } else if (updates.status !== undefined) {
    db.prepare('update form_assignments set status = ?, updated_at = ? where id = ?').run(updates.status, now, id);
  }
}

export function completeAssignmentBySubmissionId(submissionId: string): void {
  db.prepare(
    `update form_assignments set status = 'completed', updated_at = ? where submission_id = ? and status != 'completed'`,
  ).run(nowIso(), submissionId);
}

export function deleteAssignment(id: string, practiceId: string): boolean {
  const result = db
    .prepare('delete from form_assignments where id = ? and practice_id = ?')
    .run(id, practiceId);
  return result.changes > 0;
}

export function expireStaleAssignments(): number {
  // Use datetime() to parse the ISO-8601 stored value before comparing — SQLite's
  // datetime('now') uses a space separator while toISOString() uses 'T', so a raw
  // string comparison would give the wrong result.
  const result = db
    .prepare(
      `update form_assignments
       set status = 'expired', updated_at = ?
       where status = 'pending' and datetime(expires_at) < datetime('now')`,
    )
    .run(nowIso());
  return result.changes as number;
}
