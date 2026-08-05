import { createHash, randomUUID } from 'node:crypto';
import type { PatientExcelImportRow } from '../lib/patientExcelImport.js';
import { autoAssignForWellVisit } from '../lib/autoFormAssignment.js';
import { db, nowIso, parseJson, stringifyJson } from './database.js';

export type SubmissionRow = {
  id: string;
  practice_id: string;
  patient_id: string | null;
  form_id: string;
  template_version: string;
  template_id: string | null;
  template_version_num: number | null;
  visit_type: string;
  status: 'in_progress' | 'completed' | 'exported';
  form_data_json: string;
  responses_json: string;
  completed_pdf_path: string | null;
  forms_completed_json: string;
  confirmation_code: string;
  submitted_at: string | null;
  exported_at: string | null;
  exported_by: string | null;
  ip_address: string | null;
  created_at: string;
  updated_at: string;
};

export function createSubmission(input: {
  practiceId: string;
  patientId?: string;
  visitType: string;
  formId: string;
  templateVersion: string;
  templateId?: string;
  templateVersionNum?: number;
  initialData: Record<string, unknown>;
  initialResponses?: Record<string, unknown>;
  confirmationCode: string;
  ipAddress?: string;
}): SubmissionRow {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `insert into submissions (
      id, practice_id, patient_id, form_id, template_version, template_id, template_version_num, visit_type, status,
      form_data_json, responses_json, completed_pdf_path, forms_completed_json, confirmation_code, submitted_at,
      exported_at, exported_by, ip_address, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, null, ?, ?, null, null, null, ?, ?, ?)`,
  ).run(
    id,
    input.practiceId,
    input.patientId ?? null,
    input.formId,
    input.templateVersion,
    input.templateId ?? null,
    input.templateVersionNum ?? null,
    input.visitType,
    stringifyJson(input.initialData),
    stringifyJson(input.initialResponses ?? {}),
    stringifyJson([]),
    input.confirmationCode,
    input.ipAddress ?? null,
    now,
    now,
  );

  return getSubmissionByIdOrThrow(id);
}

export function getSubmissionById(id: string): SubmissionRow | undefined {
  return db.prepare('select * from submissions where id = ?').get(id) as SubmissionRow | undefined;
}

export function getSubmissionByIdOrThrow(id: string): SubmissionRow {
  const row = getSubmissionById(id);
  if (!row) throw new Error('Submission not found');
  return row;
}

/** Normalize DOB for identity matching (YYYY-MM-DD prefix from ISO or date input). */
export function normalizeDobForMatch(dob: string): string {
  const t = String(dob ?? '').trim();
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : t;
}

/**
 * Same identity rule as Excel bulk import and staff assignments: one row per practice
 * for matching child first name, last name, and DOB (case-insensitive names, trimmed).
 */
export function findPatientIdByPracticeNameDob(
  practiceId: string,
  firstName: string,
  lastName: string,
  dob: string,
): string | undefined {
  const dobNorm = normalizeDobForMatch(dob);
  if (!dobNorm) return undefined;
  const row = db
    .prepare(
      `select id from patients where practice_id = ?
         and lower(trim(child_first_name)) = lower(trim(?))
         and lower(trim(child_last_name)) = lower(trim(?))
         and child_dob = ?
       limit 1`,
    )
    .get(practiceId, firstName.trim(), lastName.trim(), dobNorm) as { id: string } | undefined;
  return row?.id;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return b;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return b;
}

export function autosaveSubmission(input: {
  submissionId: string;
  formId: string;
  data: Record<string, unknown>;
}): SubmissionRow {
  const current = getSubmissionByIdOrThrow(input.submissionId);
  const currentData = parseJson<Record<string, unknown>>(current.form_data_json, {});
  const merged = deepMerge(currentData, input.data) as Record<string, unknown>;

  db.prepare('update submissions set form_data_json = ?, updated_at = ? where id = ?').run(
    stringifyJson(merged),
    nowIso(),
    input.submissionId,
  );

  return getSubmissionByIdOrThrow(input.submissionId);
}

export function autosaveSubmissionResponses(input: {
  submissionId: string;
  responses: Record<string, { value: unknown; updated_at?: string }>;
}): SubmissionRow {
  const current = getSubmissionByIdOrThrow(input.submissionId);
  const currentResponses = parseJson<Record<string, { value: unknown; updated_at?: string }>>(current.responses_json, {});
  const now = nowIso();
  const merged: Record<string, { value: unknown; updated_at: string }> = {
    ...(currentResponses as Record<string, { value: unknown; updated_at: string }>),
  };

  for (const [fieldId, payload] of Object.entries(input.responses)) {
    const rawValue = payload?.value ?? null;
    merged[fieldId] = { value: rawValue, updated_at: now };
  }

  db.prepare('update submissions set responses_json = ?, updated_at = ? where id = ?').run(
    stringifyJson(merged),
    now,
    input.submissionId,
  );

  return getSubmissionByIdOrThrow(input.submissionId);
}

export function addSubmissionEvent(input: {
  submissionId: string;
  practiceId: string;
  actorType: 'parent' | 'staff' | 'system';
  actorId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): void {
  db.prepare(
    `insert into submission_events (
      submission_id, practice_id, actor_type, actor_id, event_type, event_payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.submissionId,
    input.practiceId,
    input.actorType,
    input.actorId ?? null,
    input.eventType,
    stringifyJson(input.payload ?? {}),
    nowIso(),
  );
}

function upsertSingle(table: string, patientId: string, values: Record<string, unknown>): void {
  const id = randomUUID();
  const now = nowIso();
  const columns = Object.keys(values);
  if (columns.length === 0) return;

  const allColumns = ['id', 'patient_id', ...columns, 'created_at', 'updated_at'];
  const placeholders = allColumns.map(() => '?').join(', ');
  const updateSet = [...columns.map((col) => `${col}=excluded.${col}`), 'updated_at=excluded.updated_at'].join(', ');

  db.prepare(
    `insert into ${table} (${allColumns.join(', ')}) values (${placeholders})
     on conflict(patient_id) do update set ${updateSet}`,
  ).run(id, patientId, ...columns.map((c) => values[c]), now, now);
}

function replaceRows(
  table: string,
  patientId: string,
  rows: Array<Record<string, unknown>>,
  extraFixed?: Record<string, unknown>,
): void {
  db.prepare(`delete from ${table} where patient_id = ?`).run(patientId);
  const now = nowIso();

  for (const row of rows) {
    const merged = { ...(extraFixed ?? {}), ...row };
    const columns = Object.keys(merged);
    const values = columns.map((k) => merged[k]);
    db.prepare(
      `insert into ${table} (id, patient_id, ${columns.join(', ')}, created_at, updated_at)
       values (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)`,
    ).run(randomUUID(), patientId, ...values, now, now);
  }
}

export function materializePatientFromSubmission(submissionId: string): { patientId: string } {
  const submission = getSubmissionByIdOrThrow(submissionId);
  const form = parseJson<Record<string, any>>(submission.form_data_json, {});
  const patient = form.patient ?? {};
  const child = patient.child ?? {};
  const guardians = form.guardians ?? {};
  const insurance = form.insurance ?? {};
  const pharmacy = form.pharmacy ?? {};
  const medical = form.medical_history ?? {};
  const concerns = form.concerns ?? {};
  const immunizations = form.immunizations ?? {};
  const social = form.social_history ?? {};
  const preferences = form.provider_preferences ?? {};
  const consent = form.consent_signature ?? {};

  const now = nowIso();
  const submissionLinkedPatient = submission.patient_id
    ? (db.prepare('select id from patients where id = ?').get(submission.patient_id) as { id: string } | undefined)
    : undefined;

  let patientId: string;
  if (submissionLinkedPatient?.id) {
    patientId = submissionLinkedPatient.id;
  } else {
    const matched = findPatientIdByPracticeNameDob(
      submission.practice_id,
      String(child.first_name ?? ''),
      String(child.last_name ?? ''),
      String(child.dob ?? ''),
    );
    patientId = matched ?? randomUUID();
  }

  db.prepare(
    `insert into patients (
      id, practice_id, account_id, child_first_name, child_last_name, child_dob, visit_type,
      preferred_language, sex, race_ethnicity, created_at, updated_at
    ) values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      child_first_name = case when nullif(trim(excluded.child_first_name), '') is not null
        then excluded.child_first_name else patients.child_first_name end,
      child_last_name = case when nullif(trim(excluded.child_last_name), '') is not null
        then excluded.child_last_name else patients.child_last_name end,
      child_dob = case when nullif(trim(excluded.child_dob), '') is not null
        then excluded.child_dob else patients.child_dob end,
      visit_type = coalesce(nullif(trim(patients.visit_type), ''), nullif(trim(excluded.visit_type), ''), 'new_patient'),
      preferred_language = coalesce(excluded.preferred_language, patients.preferred_language),
      sex = coalesce(excluded.sex, patients.sex),
      race_ethnicity = coalesce(excluded.race_ethnicity, patients.race_ethnicity),
      updated_at = excluded.updated_at`,
  ).run(
    patientId,
    submission.practice_id,
    child.first_name ?? '',
    child.last_name ?? '',
    child.dob ?? '',
    submission.visit_type,
    child.preferred_language ?? null,
    child.sex ?? null,
    child.race_ethnicity ?? null,
    now,
    now,
  );

  const guardianRows: Array<Record<string, unknown>> = [];
  if (guardians.primary) {
    guardianRows.push({
      guardian_index: 1,
      full_name: guardians.primary.full_name ?? null,
      relationship: guardians.primary.relationship ?? null,
      phone: guardians.primary.phone ?? null,
      email: guardians.primary.email ?? null,
      address: guardians.primary.address ?? null,
      employer: guardians.primary.employer ?? null,
      ssn_last4: guardians.primary.ssn_last4 ?? null,
    });
  }
  if (guardians.secondary && guardians.secondary.enabled !== false) {
    guardianRows.push({
      guardian_index: 2,
      full_name: guardians.secondary.full_name ?? null,
      relationship: guardians.secondary.relationship ?? null,
      phone: guardians.secondary.phone ?? null,
      email: guardians.secondary.email ?? null,
      address: guardians.secondary.address ?? null,
      employer: guardians.secondary.employer ?? null,
      ssn_last4: guardians.secondary.ssn_last4 ?? null,
    });
  }

  const guardianRowHasData = (g: Record<string, unknown>) =>
    ['full_name', 'relationship', 'phone', 'email', 'address', 'employer', 'ssn_last4'].some((k) => {
      const v = g[k];
      return v != null && String(v).trim() !== '';
    });
  const hasGuardianPayload = guardianRows.some(guardianRowHasData);
  if (hasGuardianPayload) {
    db.prepare('delete from guardians where patient_id = ?').run(patientId);
    for (const g of guardianRows) {
      db.prepare(
        `insert into guardians (
        id, patient_id, guardian_index, full_name, relationship, phone, email, address, employer,
        ssn_last4, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        patientId,
        g.guardian_index,
        g.full_name,
        g.relationship,
        g.phone,
        g.email,
        g.address,
        g.employer,
        g.ssn_last4,
        now,
        now,
      );
    }
  }

  const insuranceRows = [
    { policy_order: 1, ...(insurance.primary ?? {}) },
    { policy_order: 2, ...(insurance.secondary ?? {}) },
  ].filter((row) => Object.keys(row).length > 1);

  if (insuranceRows.length > 0) {
    db.prepare('delete from insurance_policies where patient_id = ?').run(patientId);
    for (const policy of insuranceRows) {
      db.prepare(
        `insert into insurance_policies (
        id, patient_id, policy_order, company, subscriber_name, subscriber_dob, group_number, member_id,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        patientId,
        policy.policy_order,
        (policy as any).company ?? null,
        (policy as any).subscriber_name ?? null,
        (policy as any).subscriber_dob ?? null,
        (policy as any).group_number ?? null,
        (policy as any).member_id ?? null,
        now,
        now,
      );
    }
  }

  upsertSingle('pharmacies', patientId, {
    name: pharmacy.name ?? null,
    address: pharmacy.address ?? null,
    zip: pharmacy.zip ?? null,
  });

  upsertSingle('medical_history', patientId, {
    gestational_age: medical.gestational_age ?? null,
    birth_weight: medical.birth_weight ?? null,
    birth_complications: medical.birth_complications ?? null,
    hospitalizations: medical.hospitalizations ?? null,
    surgeries: medical.surgeries ?? null,
  });

  upsertSingle('concerns', patientId, {
    visit_reason: concerns.visit_reason ?? null,
    development_concerns: concerns.development_concerns ?? null,
  });

  const allergyRows: Array<Record<string, unknown>> = [];
  for (const item of (form.allergies?.drug ?? []) as any[]) {
    allergyRows.push({ allergy_type: 'drug', allergy_name: item.name ?? null, reaction: item.reaction ?? null });
  }
  for (const item of (form.allergies?.food ?? []) as any[]) {
    allergyRows.push({ allergy_type: 'food', allergy_name: item.name ?? null, reaction: item.reaction ?? null });
  }
  for (const item of (form.allergies?.environmental ?? []) as any[]) {
    allergyRows.push({
      allergy_type: 'environmental',
      allergy_name: item.name ?? null,
      reaction: item.reaction ?? null,
    });
  }
  if (allergyRows.length > 0) replaceRows('allergies', patientId, allergyRows);

  const medicationRows = ((form.medications?.items ?? []) as any[]).map((item) => ({
    medication_name: item.name ?? null,
    dose: item.dose ?? null,
    frequency: item.frequency ?? null,
  }));
  if (medicationRows.length > 0) replaceRows('medications', patientId, medicationRows);

  upsertSingle('immunizations', patientId, {
    status: immunizations.status ?? null,
  });

  const familyRows = Object.entries((form.family_history?.conditions ?? {}) as Record<string, unknown>).map(
    ([conditionName, present]) => ({
      condition_name: conditionName,
      present: present ? 1 : 0,
      notes: null,
    }),
  );
  if (familyRows.length > 0) replaceRows('family_history', patientId, familyRows);

  upsertSingle('social_history', patientId, {
    household_adults: social.household_adults ?? null,
    household_children: social.household_children ?? null,
    smokers_in_home: social.smokers_in_home ? 1 : 0,
    pets: social.pets ?? null,
    daycare_school: social.daycare_school ?? null,
    nutrition: social.nutrition ?? null,
  });

  upsertSingle('provider_preferences', patientId, {
    physician_preference: preferences.physician_preference ?? null,
    referral_source: preferences.referral_source ?? null,
    referring_provider: preferences.referring_provider ?? null,
  });

  upsertSingle('consents_signatures', patientId, {
    agreed: consent.agreed ? 1 : 0,
    typed_name: consent.typed_name ?? null,
    signature_data: consent.signature_data ?? null,
    signed_at: consent.signed_at ?? null,
  });

  db.prepare('update submissions set patient_id = ?, updated_at = ? where id = ?').run(patientId, nowIso(), submissionId);
  return { patientId };
}

export function completeSubmission(submissionId: string): SubmissionRow {
  const submission = getSubmissionByIdOrThrow(submissionId);
  // Legacy materialization remains for compatibility with the normalized staff workspace.
  materializePatientFromSubmission(submissionId);
  const now = nowIso();
  db.prepare(
    `update submissions
     set status = 'completed',
         forms_completed_json = ?,
         submitted_at = ?,
         completed_pdf_path = coalesce(?, completed_pdf_path),
         updated_at = ?
     where id = ?`,
  ).run(stringifyJson([submission.form_id]), now, null, now, submissionId);
  return getSubmissionByIdOrThrow(submissionId);
}

export function completeSubmissionWithPdf(submissionId: string, completedPdfPath: string | null): SubmissionRow {
  const submission = getSubmissionByIdOrThrow(submissionId);
  materializePatientFromSubmission(submissionId);
  const now = nowIso();
  db.prepare(
    `update submissions
     set status = 'completed',
         forms_completed_json = ?,
         submitted_at = ?,
         completed_pdf_path = ?,
         updated_at = ?
     where id = ?`,
  ).run(stringifyJson([submission.form_id]), now, completedPdfPath, now, submissionId);
  return getSubmissionByIdOrThrow(submissionId);
}

export function linkPatientAccount(input: { submissionId: string; accountId: string }): void {
  const submission = getSubmissionByIdOrThrow(input.submissionId);
  if (!submission.patient_id) {
    materializePatientFromSubmission(input.submissionId);
  }
  const latest = getSubmissionByIdOrThrow(input.submissionId);
  if (!latest.patient_id) return;
  db.prepare('update patients set account_id = ?, updated_at = ? where id = ?').run(
    input.accountId,
    nowIso(),
    latest.patient_id,
  );
}

/** Latest imported appointment visit type text for a patient (Excel schedule). */
export function getLatestAppointmentVisitTypeRaw(patientId: string): string | null {
  const row = db
    .prepare(
      `select visit_type_raw from appointments
       where patient_id = ?
       order by created_at desc, id desc
       limit 1`,
    )
    .get(patientId) as { visit_type_raw: string | null } | undefined;
  const raw = row?.visit_type_raw;
  return raw && String(raw).trim() ? String(raw).trim() : null;
}

export function listPatients(practiceId: string, search?: string): Array<Record<string, unknown>> {
  const q = `%${search ?? ''}%`;
  return db
    .prepare(
      `select p.id, p.child_first_name, p.child_last_name, p.child_dob, p.visit_type, p.updated_at,
              p.created_at,
              p.patient_acct_no,
              na.next_appointment_date, na.next_appointment_time,
              s.status as latest_submission_status,
              pa.email as account_email,
              loc.location_name        as location_name,
              loc.facility_group_name  as facility_group_name,
              loc.state                as location_state,
              loc.city                 as location_city,
              loc.id                   as location_id,
              exists (
                select 1 from form_assignments fa
                where fa.patient_id = p.id
                  and date(fa.created_at) = date(p.created_at)
              ) as assigned_same_day
       from patients p
       left join (
         select patient_id, appointment_date as next_appointment_date, appointment_time as next_appointment_time
         from (
           select patient_id, appointment_date, appointment_time,
                  row_number() over (partition by patient_id order by created_at desc, id desc) as rn
           from appointments
         ) x where rn = 1
       ) na on na.patient_id = p.id
       left join submissions s on s.patient_id = p.id
       left join patient_accounts pa on pa.id = p.account_id
       left join practices loc on loc.id = p.location_id
       where p.practice_id = ? and (
         p.child_first_name like ? or p.child_last_name like ?
         or coalesce(p.patient_acct_no, '') like ?
         or coalesce(loc.location_name, '') like ?
         or coalesce(loc.facility_group_name, '') like ?
         or coalesce(loc.state, '') like ?
       )
       group by p.id
       order by p.updated_at desc`,
    )
    .all(practiceId, q, q, q, q, q, q) as Array<Record<string, unknown>>;
}

export type AutoAssignSummary = {
  patient_name: string;
  age_group: string | null;
  form_labels: string[];
  assignments_created: number;
  assignments_skipped?: number;
  existing_patient?: boolean;
};

function recordAutoAssignSummary(
  summaries: AutoAssignSummary[],
  patientName: string,
  result: ReturnType<typeof autoAssignForWellVisit>,
  existingPatient: boolean,
): void {
  const visitHadRules = result.form_labels.length > 0 || result.assignments_created > 0;
  if (!visitHadRules && !result.age_group) return;
  summaries.push({
    patient_name: patientName,
    age_group: result.age_group,
    form_labels: result.form_labels,
    assignments_created: result.assignments_created,
    assignments_skipped: result.assignments_skipped,
    existing_patient: existingPatient,
  });
}

export type BulkPatientImportResult = {
  inserted: number;
  skipped: number;
  total_rows: number;
  errors: string[];
  imported_patients: Array<{
    id: string;
    child_first_name: string;
    child_last_name: string;
    patient_acct_no: string | null;
  }>;
  auto_form_assignments: AutoAssignSummary[];
};

/**
 * Insert parsed Excel rows; skips duplicates (same practice + acct no, or name + DOB),
 * duplicate keys within the same upload batch, and unique constraint violations.
 * If assignedByStaffId is provided, runs auto-form-assignment for well-visit rows.
 */
export async function bulkImportPatientsFromExcelRows(
  practiceId: string,
  parsedRows: PatientExcelImportRow[],
  total_rows: number,
  parseErrors: string[],
  assignedByStaffId?: string,
): Promise<BulkPatientImportResult> {
  const errors = [...parseErrors];
  const imported_patients: BulkPatientImportResult['imported_patients'] = [];
  const auto_form_assignments: AutoAssignSummary[] = [];
  let inserted = 0;
  let skipped = 0;

  const dupByAcct = db.prepare(
    `select id from patients where practice_id = ? and patient_acct_no is not null and trim(patient_acct_no) = ? limit 1`,
  );
  const dupByNameDob = db.prepare(
    `select id from patients where practice_id = ?
       and lower(trim(child_first_name)) = lower(trim(?))
       and lower(trim(child_last_name)) = lower(trim(?))
       and child_dob = ?
     limit 1`,
  ); // logic mirrored in findPatientIdByPracticeNameDob

  const insertPatient = db.prepare(
    `insert into patients (
      id, practice_id, account_id, child_first_name, child_last_name, child_dob, visit_type,
      preferred_language, sex, race_ethnicity, created_at, updated_at,
      external_patient_key, patient_acct_no, import_source, imported_at
    ) values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertAppointment = db.prepare(
    `insert into appointments (
      id, practice_id, patient_id, external_appointment_key,
      appointment_date, appointment_time, visit_type_raw, visit_reason,
      provider_name, facility_group_name, facility_name,
      import_source, imported_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertGuardian = db.prepare(
    `insert into guardians (
      id, patient_id, guardian_index, full_name, relationship, phone, email, address, employer,
      ssn_last4, created_at, updated_at
    ) values (?, ?, 1, null, null, ?, ?, ?, null, null, ?, ?)`,
  );

  const insertInsurance = db.prepare(
    `insert into insurance_policies (
      id, patient_id, policy_order, company, subscriber_name, subscriber_dob, group_number, member_id,
      created_at, updated_at
    ) values (?, ?, 1, ?, null, null, null, ?, ?, ?)`,
  );

  function insertAppointmentForImportRow(
    patientId: string,
    row: PatientExcelImportRow,
    now: string,
  ): string | null {
    const hasApptData = Boolean(
      row.nextAppointmentDate ||
        row.nextAppointmentTime ||
        row.appointmentVisitType ||
        row.appointmentVisitReason ||
        row.appointmentProviderName ||
        row.appointmentFacilityName,
    );
    if (!hasApptData) return null;
    const apptKey = `excel:${practiceId}:${row.externalPatientKey}:r${row.sheetRow}`;
    try {
      insertAppointment.run(
        randomUUID(),
        practiceId,
        patientId,
        apptKey,
        row.nextAppointmentDate,
        row.nextAppointmentTime,
        row.appointmentVisitType,
        row.appointmentVisitReason,
        row.appointmentProviderName,
        row.appointmentFacilityGroupName,
        row.appointmentFacilityName,
        'excel_bulk',
        now,
        now,
        now,
      );
      return null;
    } catch (apptErr) {
      return (apptErr as Error).message ?? String(apptErr);
    }
  }

  /**
   * Resolve (or create) a clinic location from the import row's facility fields,
   * and stamp location_id on the patient record.
   */
  function stampPatientLocation(patientId: string, row: PatientExcelImportRow): void {
    try {
      const locationId = findOrCreateClinicLocation(
        practiceId,
        row.appointmentFacilityName,
        row.appointmentFacilityGroupName,
      );
      if (locationId) {
        db.prepare(`update patients set location_id = ? where id = ?`).run(locationId, patientId);
      }
    } catch (err) {
      errors.push(
        `Row ${row.sheetRow}: could not link clinic/region (${(err as Error).message ?? String(err)})`,
      );
    }
  }

  const seenInFile = new Set<string>();

  for (const row of parsedRows) {
    const key = row.externalPatientKey;
    if (seenInFile.has(key)) {
      skipped += 1;
      errors.push(`Row ${row.sheetRow}: skipped (duplicate row in file)`);
      continue;
    }
    seenInFile.add(key);

    let existing: { id: string } | undefined;
    if (row.patientAcctNo?.trim()) {
      existing = dupByAcct.get(practiceId, row.patientAcctNo.trim()) as { id: string } | undefined;
    } else {
      existing = dupByNameDob.get(
        practiceId,
        row.childFirstName,
        row.childLastName,
        normalizeDobForMatch(row.childDob),
      ) as
        | { id: string }
        | undefined;
    }

    if (existing) {
      skipped += 1;
      const now = nowIso();
      // Always update location even for existing patients (facility may have changed)
      stampPatientLocation(existing.id, row);
      const apptErr = insertAppointmentForImportRow(existing.id, row, now);
      if (apptErr) {
        errors.push(`Row ${row.sheetRow}: existing patient — appointment not saved (${apptErr})`);
      }
      if (assignedByStaffId) {
        const visitType = row.appointmentVisitType ?? row.rawVisitType ?? row.visitType;
        const result = autoAssignForWellVisit({
          practiceId,
          patientId: existing.id,
          childDob: row.childDob,
          visitType,
          assignedBy: assignedByStaffId,
        });
        recordAutoAssignSummary(
          auto_form_assignments,
          `${row.childFirstName} ${row.childLastName}`,
          result,
          true,
        );
      }
      errors.push(`Row ${row.sheetRow}: skipped (patient already exists)`);
      continue;
    }

    const id = randomUUID();
    const now = nowIso();
    const acct = row.patientAcctNo?.trim() || null;

    try {
      insertPatient.run(
        id,
        practiceId,
        row.childFirstName,
        row.childLastName,
        row.childDob,
        row.visitType,
        row.preferredLanguage,
        row.sex,
        row.raceEthnicity,
        now,
        now,
        row.externalPatientKey,
        acct,
        'excel_bulk',
        now,
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        skipped += 1;
        errors.push(`Row ${row.sheetRow}: skipped (duplicate key)`);
        continue;
      }
      errors.push(`Row ${row.sheetRow}: ${msg}`);
      continue;
    }

    // Link to clinic location derived from facility columns
    stampPatientLocation(id, row);

    const apptErr = insertAppointmentForImportRow(id, row, now);
    if (apptErr) {
      errors.push(`Row ${row.sheetRow}: patient saved but appointment not saved (${apptErr})`);
    }

    if (row.guardianPhones || row.guardianEmail || row.guardianAddress) {
      insertGuardian.run(
        randomUUID(),
        id,
        row.guardianPhones,
        row.guardianEmail,
        row.guardianAddress,
        now,
        now,
      );
    }

    const hasPrimary = Boolean(row.primaryInsuranceCompany?.trim() || row.primaryInsuranceMemberId?.trim());
    const hasApptIns = Boolean(
      row.appointmentInsuranceCompany?.trim() || row.appointmentInsuranceMemberId?.trim(),
    );
    let company: string | null = null;
    let memberId: string | null = null;
    if (hasPrimary) {
      company = row.primaryInsuranceCompany?.trim() || null;
      memberId = row.primaryInsuranceMemberId?.trim() || null;
    } else if (hasApptIns) {
      company = row.appointmentInsuranceCompany?.trim() || null;
      memberId = row.appointmentInsuranceMemberId?.trim() || null;
    }
    if (company || memberId) {
      insertInsurance.run(randomUUID(), id, company, memberId, now, now);
    }

    inserted += 1;
    imported_patients.push({ id, child_first_name: row.childFirstName, child_last_name: row.childLastName, patient_acct_no: acct });

    if (assignedByStaffId) {
      const visitType = row.appointmentVisitType ?? row.rawVisitType ?? row.visitType;
      const result = autoAssignForWellVisit({
        practiceId,
        patientId: id,
        childDob: row.childDob,
        visitType,
        assignedBy: assignedByStaffId,
      });
      recordAutoAssignSummary(
        auto_form_assignments,
        `${row.childFirstName} ${row.childLastName}`,
        result,
        false,
      );
    }
  }

  return { inserted, skipped, total_rows, errors, imported_patients, auto_form_assignments };
}

function getRows(table: string, patientId: string): Array<Record<string, unknown>> {
  const rows = db.prepare(`select * from ${table} where patient_id = ? order by created_at asc`).all(patientId) as Array<
    Record<string, unknown>
  >;
  if (table === 'guardians') {
    return rows.map((row) => ({
      ...row,
      ssn_last4: row.ssn_last4,
    }));
  }
  return rows;
}

function getOne(table: string, patientId: string): Record<string, unknown> | null {
  return (db.prepare(`select * from ${table} where patient_id = ?`).get(patientId) as Record<string, unknown> | undefined) ?? null;
}

export function getPatientDetail(patientId: string, practiceId: string): Record<string, unknown> | null {
  const patient = db.prepare('select * from patients where id = ? and practice_id = ?').get(patientId, practiceId) as
    | Record<string, unknown>
    | undefined;
  if (!patient) return null;

  return {
    patient,
    guardians: getRows('guardians', patientId),
    insurance_policies: getRows('insurance_policies', patientId),
    appointments: db
      .prepare(`select * from appointments where patient_id = ? order by created_at desc, id desc`)
      .all(patientId),
    pharmacies: getOne('pharmacies', patientId),
    medical_history: getOne('medical_history', patientId),
    concerns: getOne('concerns', patientId),
    allergies: getRows('allergies', patientId),
    medications: getRows('medications', patientId),
    immunizations: getOne('immunizations', patientId),
    family_history: getRows('family_history', patientId),
    social_history: getOne('social_history', patientId),
    provider_preferences: getOne('provider_preferences', patientId),
    consents_signatures: getOne('consents_signatures', patientId),
    submissions: db
      .prepare(
        'select id, form_id, template_id, status, submitted_at, confirmation_code, completed_pdf_path from submissions where patient_id = ? order by created_at desc',
      )
      .all(patientId),
  };
}

export function updatePatientCore(
  patientId: string,
  practiceId: string,
  payload: Partial<Record<'child_first_name' | 'child_last_name' | 'child_dob' | 'visit_type' | 'preferred_language' | 'sex' | 'race_ethnicity', string>>,
): void {
  const allowed = ['child_first_name', 'child_last_name', 'child_dob', 'visit_type', 'preferred_language', 'sex', 'race_ethnicity'];
  const entries = Object.entries(payload).filter(([k, v]) => allowed.includes(k) && typeof v === 'string');
  if (entries.length === 0) return;
  const set = [...entries.map(([k]) => `${k} = ?`), 'updated_at = ?'].join(', ');
  db.prepare(`update patients set ${set} where id = ? and practice_id = ?`).run(
    ...entries.map(([, v]) => v),
    nowIso(),
    patientId,
    practiceId,
  );
}

export function replaceChildTable(patientId: string, table: string, rows: Array<Record<string, unknown>>): void {
  const tableMap: Record<string, string[]> = {
    guardians: ['guardian_index', 'full_name', 'relationship', 'phone', 'email', 'address', 'employer', 'ssn_last4'],
    insurance_policies: ['policy_order', 'company', 'subscriber_name', 'subscriber_dob', 'group_number', 'member_id'],
    allergies: ['allergy_type', 'allergy_name', 'reaction'],
    medications: ['medication_name', 'dose', 'frequency'],
    family_history: ['condition_name', 'present', 'notes'],
  };

  const columns = tableMap[table];
  if (!columns) throw new Error(`Unsupported table replace: ${table}`);

  db.prepare(`delete from ${table} where patient_id = ?`).run(patientId);
  const now = nowIso();
  for (const row of rows) {
    const filtered = columns.map((col) => {
      const val = row[col] ?? null;
      return val;
    });
    db.prepare(
      `insert into ${table} (id, patient_id, ${columns.join(', ')}, created_at, updated_at)
       values (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)`,
    ).run(randomUUID(), patientId, ...filtered, now, now);
  }
}

export function upsertOneToOne(patientId: string, table: string, payload: Record<string, unknown>): void {
  const map: Record<string, string[]> = {
    pharmacies: ['name', 'address', 'zip'],
    medical_history: ['gestational_age', 'birth_weight', 'birth_complications', 'hospitalizations', 'surgeries'],
    concerns: ['visit_reason', 'development_concerns'],
    immunizations: ['status'],
    social_history: ['household_adults', 'household_children', 'smokers_in_home', 'pets', 'daycare_school', 'nutrition'],
    provider_preferences: ['physician_preference', 'referral_source', 'referring_provider'],
    consents_signatures: ['agreed', 'typed_name', 'signature_data', 'signed_at'],
  };
  const columns = map[table];
  if (!columns) throw new Error(`Unsupported one-to-one table: ${table}`);
  const values = columns.map((col) => payload[col] ?? null);

  db.prepare(
    `insert into ${table} (id, patient_id, ${columns.join(', ')}, created_at, updated_at)
     values (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)
     on conflict(patient_id) do update set
     ${columns.map((c) => `${c}=excluded.${c}`).join(', ')},
     updated_at=excluded.updated_at`,
  ).run(randomUUID(), patientId, ...values, nowIso(), nowIso());
}

export function listSubmissions(practiceId: string): Array<Record<string, unknown>> {
  return db
    .prepare(
      `select s.id, s.status, s.submitted_at, s.updated_at, s.confirmation_code,
              p.child_first_name, p.child_last_name, p.child_dob, p.id as patient_id,
              t.name as template_name
       from submissions s
       left join patients p on p.id = s.patient_id
       left join pdf_templates t on t.id = s.template_id
       where s.practice_id = ?
       order by s.created_at desc`,
    )
    .all(practiceId) as Array<Record<string, unknown>>;
}

export function exportSubmissionJson(submissionId: string, staffUserId: string): Record<string, unknown> {
  const submission = getSubmissionByIdOrThrow(submissionId);
  const payload = parseJson<Record<string, unknown>>(submission.form_data_json, {});
  const responses = parseJson<Record<string, unknown>>(submission.responses_json, {});

  db.prepare("update submissions set status='exported', exported_at=?, exported_by=?, updated_at=? where id=?").run(
    nowIso(),
    staffUserId,
    nowIso(),
    submissionId,
  );

  const patientDetail = submission.patient_id
    ? getPatientDetail(submission.patient_id, submission.practice_id)
    : null;

  return {
    submission_id: submission.id,
    practice_id: submission.practice_id,
    patient_id: submission.patient_id,
    form_id: submission.form_id,
    template_version: submission.template_version,
    template_id: submission.template_id,
    template_version_num: submission.template_version_num,
    status: 'exported',
    completed_pdf_path: submission.completed_pdf_path,
    submitted_at: submission.submitted_at,
    confirmation_code: submission.confirmation_code,
    payload,
    responses,
    normalized_patient_data: patientDetail,
  };
}

/** Read-only version of exportSubmissionJson — no status side-effects, for patient self-downloads. */
export function readSubmissionForExport(submissionId: string): Record<string, unknown> {
  const submission = getSubmissionByIdOrThrow(submissionId);
  const payload = parseJson<Record<string, unknown>>(submission.form_data_json, {});
  const responses = parseJson<Record<string, unknown>>(submission.responses_json, {});
  const patientDetail = submission.patient_id
    ? getPatientDetail(submission.patient_id, submission.practice_id)
    : null;
  return {
    submission_id: submission.id,
    practice_id: submission.practice_id,
    patient_id: submission.patient_id,
    form_id: submission.form_id,
    template_version: submission.template_version,
    template_id: submission.template_id,
    template_version_num: submission.template_version_num,
    status: submission.status,
    completed_pdf_path: submission.completed_pdf_path,
    submitted_at: submission.submitted_at,
    confirmation_code: submission.confirmation_code,
    payload,
    responses,
    normalized_patient_data: patientDetail,
  };
}

/** Legacy URL slugs still used in bookmarks/links → current practice slug in DB. */
const PRACTICE_SLUG_ALIASES: Record<string, string> = {
  'sunshine-pediatrics': 'nurturekidspediatrics',
};

export function findPracticeBySlug(slug: string): Record<string, unknown> | undefined {
  const raw = String(slug ?? '').trim();
  if (!raw) return undefined;
  const canonical = PRACTICE_SLUG_ALIASES[raw.toLowerCase()] ?? raw;
  return db
    .prepare('select * from practices where lower(trim(slug)) = lower(trim(?))')
    .get(canonical) as Record<string, unknown> | undefined;
}

export function findPracticeById(id: string): Record<string, unknown> | undefined {
  return db.prepare('select * from practices where id = ?').get(id) as Record<string, unknown> | undefined;
}

/** Find a root organization by name (organization_id IS NULL = root org). */
export function findPracticeByName(name: string): Record<string, unknown> | undefined {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return undefined;
  return db
    .prepare(
      `select * from practices
       where lower(trim(name)) = lower(trim(?))
         and organization_id is null`,
    )
    .get(trimmed) as Record<string, unknown> | undefined;
}

/** All patient records matching child name + DOB (may span multiple practices).
 *
 * Three-tier matching strategy (tried in order, returns on first hit):
 *
 * 1. Full-name concat match — any first/last split of the same full name works.
 *    e.g. stored first="Marie-Isabela Lopez" last="Juarez"
 *         entered first="Marie-Isabela"      last="Lopez Juarez"  ✓
 *
 * 2. Compound last-name suffix match — first must match exactly, stored last
 *    name must end with the entered last name (space-bounded).
 *    e.g. stored first="Sofia" last="O'Connor Rivera"
 *         entered first="Sofia" last="Rivera"  ✓  ("O'Connor Rivera" ends with " Rivera")
 *    Also works for first-name suffix:
 *         stored first="Juan Carlos" last="Smith"
 *         entered first="Juan"       last="Smith"  ✓  ("Juan Carlos" ends with is prefix "Juan")
 *
 * 3. Exact column match — safety net for single-word names or unusual formats.
 */
export function findPatientsByIdentity(input: {
  firstName: string;
  lastName: string;
  dob: string;
}): Array<Record<string, unknown> & { practice_slug: string; practice_name: string }> {
  const dobNorm = String(input.dob).trim().slice(0, 10);
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();

  type PatientRow = Record<string, unknown> & { practice_slug: string; practice_name: string };

  const BASE = `select p.*, pr.slug as practice_slug, pr.name as practice_name
                from patients p
                join practices pr on pr.id = p.practice_id`;

  // ── Step 1: full-name concat match ───────────────────────────────────────
  // Normalise: collapse double-spaces that arise from the concat, then lowercase.
  const enteredFull = `${firstName} ${lastName}`.replace(/\s+/g, ' ').trim().toLowerCase();

  const step1 = db
    .prepare(
      `${BASE}
       where replace(lower(trim(p.child_first_name) || ' ' || trim(p.child_last_name)), '  ', ' ') = ?
         and p.child_dob = ?
       order by pr.name asc`,
    )
    .all(enteredFull, dobNorm) as PatientRow[];

  if (step1.length > 0) return step1;

  // ── Step 2: compound-name suffix match ───────────────────────────────────
  // Stored last ends with " <entered last>" (space prevents partial-word match).
  // Also allows stored first to start with entered first (e.g. "Juan Carlos" → "Juan").
  // Both sides are checked so family members can use any recognisable surname token.
  const lastSuffix = `% ${lastName.toLowerCase()}`;  // e.g. "% rivera"
  const firstSuffix = `% ${firstName.toLowerCase()}`; // e.g. "% carlos" not used here

  const step2 = db
    .prepare(
      `${BASE}
       where p.child_dob = ?
         and (
           -- entered last name matches end of stored last name (compound surname)
           (lower(trim(p.child_first_name)) = lower(?)
            and (lower(trim(p.child_last_name)) = lower(?)
                 or lower(trim(p.child_last_name)) like ?))
           or
           -- entered first name matches start of stored first name (compound given name)
           -- AND last names share a token
           (lower(trim(p.child_last_name)) = lower(?)
            and (lower(trim(p.child_first_name)) = lower(?)
                 or lower(trim(p.child_first_name)) like lower(?) || ' %'))
         )
       order by pr.name asc`,
    )
    .all(
      dobNorm,
      // compound-last branch
      firstName, lastName, lastSuffix,
      // compound-first branch
      lastName, firstName, firstName,
    ) as PatientRow[];

  if (step2.length > 0) return step2;

  // ── Step 3: exact column match (safety net) ───────────────────────────────
  return db
    .prepare(
      `${BASE}
       where lower(trim(p.child_first_name)) = lower(?)
         and lower(trim(p.child_last_name)) = lower(?)
         and p.child_dob = ?
       order by pr.name asc`,
    )
    .all(firstName, lastName, dobNorm) as PatientRow[];
}

/** Create a root organization (organization_id = NULL). */
export function createOrganization(name: string): { id: string; name: string; slug: string } {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 60);
  const id = randomUUID();
  db.prepare(
    `insert into practices (id, name, slug, logo_url, settings_json, created_at)
     values (?, ?, ?, null, ?, ?)`,
  ).run(
    id,
    name.trim(),
    slug,
    JSON.stringify({ enabled_visit_types: ['new_patient', 'well_child', 'sick', 'follow_up'] }),
    nowIso(),
  );
  return { id, name: name.trim(), slug };
}

/** Backward-compat alias — treats every call as creating a root org. */
export function createPractice(name: string): { id: string; name: string; slug: string } {
  return createOrganization(name);
}

/** Slugify for clinic/location rows (legacy — used for lookup of existing rows). */
function buildClinicSlugLegacy(organizationId: string, locationName: string): string {
  return (organizationId + '-' + locationName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 80);
}

/** Guaranteed-unique slug when legacy form would collide (different labels, same slug). */
function buildClinicSlugUnique(organizationId: string, locationName: string): string {
  const hash = createHash('sha256')
    .update(`${organizationId}\0${locationName.trim()}`)
    .digest('hex')
    .slice(0, 10);
  const base = buildClinicSlugLegacy(organizationId, locationName).slice(0, 68);
  return `${base}-${hash}`.slice(0, 80);
}

function isSqliteUniqueError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function backfillClinicGroupIfNeeded(
  clinicId: string,
  group: string | null,
  existingGroup: string | null | undefined,
): void {
  if (group && !existingGroup) {
    db.prepare(`update practices set facility_group_name = ? where id = ?`).run(group, clinicId);
  }
}

/**
 * Create a location/branch under an existing organization.
 * Returns the new location row (reuses existing clinic row when name/slug already exists).
 */
export function createLocation(input: {
  organizationId: string;
  locationName: string;
  state?: string | null;
  city?: string | null;
  facilityGroupName?: string | null;
}): { id: string; name: string; slug: string; organizationId: string } {
  const trimmed = input.locationName.trim();
  const clinicId = findOrCreateClinicLocation(
    input.organizationId,
    trimmed,
    input.facilityGroupName ?? null,
  );
  if (!clinicId) {
    throw new Error('LOCATION_NAME_REQUIRED');
  }
  if (input.state?.trim() || input.city?.trim()) {
    db.prepare(
      `update practices set state = coalesce(?, state), city = coalesce(?, city) where id = ?`,
    ).run(input.state?.trim() ?? null, input.city?.trim() ?? null, clinicId);
  }
  const row = db.prepare('select id, name, slug from practices where id = ?').get(clinicId) as {
    id: string;
    name: string;
    slug: string;
  };
  return { id: row.id, name: row.name, slug: row.slug, organizationId: input.organizationId };
}

/**
 * Find a location by name + parent org id.
 * Case-insensitive match on location_name.
 */
export function findLocationByName(
  organizationId: string,
  locationName: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(
      `select * from practices
       where organization_id = ?
         and lower(trim(location_name)) = lower(trim(?))`,
    )
    .get(organizationId, locationName.trim()) as Record<string, unknown> | undefined;
}

/** List all locations/branches under an org. */
export function listLocationsForOrg(organizationId: string): Array<Record<string, unknown>> {
  return db
    .prepare(`select * from practices where organization_id = ? order by facility_group_name asc, location_name asc`)
    .all(organizationId) as Array<Record<string, unknown>>;
}

/**
 * Resolve or create a clinic location from EMR data.
 *
 * The 3-level hierarchy:
 *   organizationId (root practice) → facilityGroupName (region) → facilityName (clinic)
 *
 * Matching is case-insensitive on location_name (= facility name).
 * If an existing row already has the same name but no group yet, the group is back-filled.
 * Returns the clinic's practice row id, or null if facilityName is empty.
 */
export function findOrCreateClinicLocation(
  organizationId: string,
  facilityName: string | null | undefined,
  facilityGroupName: string | null | undefined,
): string | null {
  const name = facilityName?.trim();
  if (!name) return null;

  const group = facilityGroupName?.trim() || null;

  const findByName = db.prepare(
    `select id, facility_group_name from practices
     where organization_id = ?
       and lower(trim(location_name)) = lower(trim(?))
     limit 1`,
  );
  const findBySlug = db.prepare(
    `select id, facility_group_name from practices where slug = ? limit 1`,
  );

  const existingByName = findByName.get(organizationId, name) as
    | { id: string; facility_group_name: string | null }
    | undefined;
  if (existingByName) {
    backfillClinicGroupIfNeeded(existingByName.id, group, existingByName.facility_group_name);
    return existingByName.id;
  }

  // EMR label variants (e.g. "Sunshine Pediatrics – Houston" vs "SUNSHINE PEDIATRICS HOUSTON")
  // can produce the same slug — reuse that row instead of crashing.
  const legacySlug = buildClinicSlugLegacy(organizationId, name);
  const existingBySlug = findBySlug.get(legacySlug) as
    | { id: string; facility_group_name: string | null }
    | undefined;
  if (existingBySlug) {
    backfillClinicGroupIfNeeded(existingBySlug.id, group, existingBySlug.facility_group_name);
    return existingBySlug.id;
  }

  const insertClinic = (slug: string): string => {
    const id = randomUUID();
    db.prepare(
      `insert into practices
         (id, name, slug, organization_id, location_name, facility_group_name,
          state, city, logo_url, settings_json, created_at)
       values (?, ?, ?, ?, ?, ?, null, null, null, ?, ?)`,
    ).run(
      id,
      name,
      slug,
      organizationId,
      name,
      group,
      JSON.stringify({ enabled_visit_types: ['new_patient', 'well_child', 'sick', 'follow_up'] }),
      nowIso(),
    );
    return id;
  };

  try {
    return insertClinic(legacySlug);
  } catch (err) {
    if (!isSqliteUniqueError(err)) throw err;
    const raced = findBySlug.get(legacySlug) as { id: string } | undefined;
    if (raced) return raced.id;
    try {
      return insertClinic(buildClinicSlugUnique(organizationId, name));
    } catch (err2) {
      if (!isSqliteUniqueError(err2)) throw err2;
      const uniqueSlug = buildClinicSlugUnique(organizationId, name);
      const raced2 = findBySlug.get(uniqueSlug) as { id: string } | undefined;
      if (raced2) return raced2.id;
      throw err2;
    }
  }
}

export function createStaffUser(input: {
  email: string;
  passwordHash: string;
  practiceId: string;
  role: 'admin' | 'staff';
  locationId?: string | null;
}): { id: string; email: string; practiceId: string; role: string; locationId: string | null } {
  const id = randomUUID();
  db.prepare(
    `insert into staff_users (id, email, password_hash, practice_id, location_id, role, is_active, created_at)
     values (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    input.email.toLowerCase().trim(),
    input.passwordHash,
    input.practiceId,
    input.locationId ?? null,
    input.role,
    nowIso(),
  );
  return {
    id,
    email: input.email.toLowerCase().trim(),
    practiceId: input.practiceId,
    role: input.role,
    locationId: input.locationId ?? null,
  };
}

export function createPatientAccount(input: {
  email: string;
  passwordHash: string;
  practiceId: string;
}): { id: string; email: string; practiceId: string } {
  const id = randomUUID();
  db.prepare(
    `insert into patient_accounts (id, email, password_hash, practice_id, created_at, last_login_at)
     values (?, ?, ?, ?, ?, null)`,
  ).run(id, input.email, input.passwordHash, input.practiceId, nowIso());

  return { id, email: input.email, practiceId: input.practiceId };
}

const placeholderFirstNames = ['Avery', 'Milo', 'Luna', 'Noah', 'Maya', 'Leo', 'Ivy', 'Owen'];
const placeholderLastNames = ['Parker', 'Hayes', 'Bennett', 'Reed', 'Foster', 'Brooks', 'Wells', 'Carter'];

function hashSeed(value: string): number {
  let hash = 0;
  for (const ch of value) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

export function ensureLinkedPatientForAccount(input: {
  accountId: string;
  practiceId: string;
  seed?: string;
}): void {
  const existing = db.prepare('select id from patients where account_id = ? limit 1').get(input.accountId) as { id: string } | undefined;
  if (existing) return;

  const seed = input.seed?.trim() || input.accountId;
  const hash = hashSeed(seed);
  const firstName = placeholderFirstNames[hash % placeholderFirstNames.length];
  const lastName = placeholderLastNames[Math.floor(hash / placeholderFirstNames.length) % placeholderLastNames.length];
  const now = nowIso();

  db.prepare(
    `insert into patients (
      id, practice_id, account_id, child_first_name, child_last_name, child_dob, visit_type,
      preferred_language, sex, race_ethnicity, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)`,
  ).run(
    randomUUID(),
    input.practiceId,
    input.accountId,
    firstName,
    lastName,
    '2026-01-01',
    'new_patient',
    now,
    now,
  );
}

export function getPatientAccountByEmail(email: string):
  | { id: string; email: string; password_hash: string; practice_id: string }
  | undefined {
  return db
    .prepare('select id, email, password_hash, practice_id from patient_accounts where lower(email) = lower(?)')
    .get(email) as { id: string; email: string; password_hash: string; practice_id: string } | undefined;
}

export function touchPatientLogin(accountId: string): void {
  db.prepare('update patient_accounts set last_login_at = ? where id = ?').run(nowIso(), accountId);
}

export function listSubmissionsForAccount(accountId: string, practiceId: string): Array<Record<string, unknown>> {
  return db
    .prepare(
      `select s.id, s.status, s.submitted_at, s.updated_at, s.confirmation_code,
              s.form_id, s.template_id, s.visit_type,
              p.child_first_name, p.child_last_name, p.child_dob, p.id as patient_id
       from submissions s
       join patients p on p.id = s.patient_id
       where p.account_id = ? and s.practice_id = ?
       order by s.created_at desc`,
    )
    .all(accountId, practiceId) as Array<Record<string, unknown>>;
}

export function getStaffByEmail(email: string):
  | { id: string; email: string; password_hash: string; practice_id: string; location_id: string | null; role: 'staff' | 'admin'; is_active: number }
  | undefined {
  return db
    .prepare('select id, email, password_hash, practice_id, location_id, role, is_active from staff_users where lower(email) = lower(?)')
    .get(email) as
    | { id: string; email: string; password_hash: string; practice_id: string; location_id: string | null; role: 'staff' | 'admin'; is_active: number }
    | undefined;
}

// Expire in_progress submissions older than `olderThanHours` hours.
// Returns the number of rows marked expired.
export function expireStaleSubmissions(olderThanHours = 48): number {
  const result = db
    .prepare(
      `update submissions
       set status = 'expired', updated_at = ?
       where status = 'in_progress'
         and created_at < datetime('now', '-' || ? || ' hours')`,
    )
    .run(nowIso(), olderThanHours);
  return result.changes as number;
}

/** Permanently delete a patient and all related records in a single transaction. */
export function deletePatientCascade(patientId: string, practiceId: string): boolean {
  const patient = db
    .prepare('select id, account_id from patients where id = ? and practice_id = ?')
    .get(patientId, practiceId) as { id: string; account_id: string | null } | undefined;
  if (!patient) return false;

  db.transaction(() => {
    // grandchild tables first
    db.prepare(
      'delete from submission_events where submission_id in (select id from submissions where patient_id = ?)',
    ).run(patientId);
    db.prepare(
      'delete from asq_submission_values where submission_id in (select id from asq_submissions where patient_id = ?)',
    ).run(patientId);

    // all tables with a direct patient_id column
    const directTables = [
      'asq_submissions',
      'patient_documents',
      'form_assignments',
      'assignment_bundles',
      'submissions',
      'appointments',
      'consents_signatures',
      'provider_preferences',
      'social_history',
      'family_history',
      'immunizations',
      'medications',
      'allergies',
      'concerns',
      'medical_history',
      'pharmacies',
      'insurance_policies',
      'guardians',
    ];
    for (const table of directTables) {
      db.prepare(`delete from ${table} where patient_id = ?`).run(patientId);
    }

    db.prepare('delete from patients where id = ?').run(patientId);

    // delete the linked parent-portal account if the patient had one
    if (patient.account_id) {
      db.prepare('delete from patient_accounts where id = ?').run(patient.account_id);
    }
  })();

  return true;
}
