import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, authHeader } from '../lib/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
import {
  formatSubmissionStatus,
  formatVisitType,
} from '../lib/staffLabels';

type Props = {
  token: string | null;
};

type AutoAssignSummary = {
  patient_name: string;
  age_group: string | null;
  form_labels: string[];
  assignments_created: number;
  assignments_skipped?: number;
  existing_patient?: boolean;
};

type BulkUploadResult = {
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
  auto_form_assignments?: AutoAssignSummary[];
};

type Patient = Record<string, unknown> & {
  id: string;
  child_first_name: string;
  child_last_name: string;
  child_dob: string | null;
  patient_acct_no: string | null;
  visit_type: string | null;
  latest_submission_status: string | null;
  account_email: string | null;
  next_appointment_date: string | null;
  next_appointment_time: string | null;
  /** Clinic / branch name (Appointment Facility Name) */
  location_name: string | null;
  /** Regional grouping (Appointment Facility Group Name) */
  facility_group_name: string | null;
  location_state: string | null;
  location_city: string | null;
  location_id: string | null;
  /** When this patient row was created (i.e. uploaded via schedule import) */
  created_at: string;
  /** 1 if a form was assigned the same calendar day this patient was uploaded, else 0 */
  assigned_same_day: number;
};

function formatNextAppt(patient: Patient): string {
  const d = patient.next_appointment_date;
  const t = patient.next_appointment_time;
  if (!d && !t) return '—';
  if (d && t) return `${d} ${t}`;
  return String(d ?? t ?? '—');
}

/** Sortable-column state: which key, and which direction. */
type SortKey = 'appointment' | 'uploaded';
type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null;

function apptSortValue(p: Patient): string {
  // Sort patients with no appointment to the bottom regardless of direction.
  if (!p.next_appointment_date) return '9999-99-99';
  return `${p.next_appointment_date} ${p.next_appointment_time ?? ''}`;
}

const VISIT_TYPE_OPTIONS = [
  { value: '', label: 'All visit types' },
  { value: 'well_child', label: 'Well visit' },
  { value: 'new_patient', label: 'New patient' },
  { value: 'sick', label: 'Sick visit' },
  { value: 'follow_up', label: 'Follow-up' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'none', label: 'No forms submitted' },
  { value: 'in_progress', label: 'Started' },
  { value: 'completed', label: 'Completed' },
  { value: 'exported', label: 'Downloaded' },
];

const PORTAL_OPTIONS = [
  { value: '', label: 'Any portal status' },
  { value: 'yes', label: 'Has portal account' },
  { value: 'no', label: 'No portal account' },
];

const APPT_OPTIONS = [
  { value: '', label: 'Any appointment' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'none', label: 'No appointment' },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function weekEndStr() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

export function StaffPatientsPage({ token }: Props) {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [error, setError] = useState('');
  const [uploadMsg, setUploadMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Delete patient ────────────────────────────────────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDeletePatient = patients.find((p) => p.id === confirmDeleteId) ?? null;

  function handleDeleteConfirm() {
    if (!confirmDeleteId || !token) return;
    setDeleting(true);
    api(`/api/staff/patients/${confirmDeleteId}`, {
      method: 'DELETE',
      headers: authHeader(token),
    })
      .then(() => {
        setPatients((prev) => prev.filter((p) => p.id !== confirmDeleteId));
        setConfirmDeleteId(null);
      })
      .catch(() => setError('Failed to delete patient. Please try again.'))
      .finally(() => setDeleting(false));
  }

  // ── Filters ──────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [filterVisit, setFilterVisit] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPortal, setFilterPortal] = useState('');
  const [filterRegion, setFilterRegion] = useState('');   // Facility Group / Region
  const [filterLocation, setFilterLocation] = useState(''); // Clinic / Facility
  const [filterAppt, setFilterAppt] = useState('');

  // ── Sort ─────────────────────────────────────────────────────────────────
  const [sort, setSort] = useState<SortState>(null);

  function toggleSort(key: SortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null; // third click clears sort, back to upload-order default
    });
  }

  function sortIndicator(key: SortKey): string {
    if (!sort || sort.key !== key) return '';
    return sort.dir === 'asc' ? ' ▲' : ' ▼';
  }

  const hasActiveFilters =
    search || filterVisit || filterStatus || filterPortal || filterRegion || filterLocation || filterAppt;

  function clearFilters() {
    setSearch('');
    setFilterVisit('');
    setFilterStatus('');
    setFilterPortal('');
    setFilterRegion('');
    setFilterLocation('');
    setFilterAppt('');
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadPatients = useCallback(() => {
    if (!token) return Promise.resolve();
    setError('');
    return api<Patient[]>('/api/staff/patients', {
      headers: authHeader(token),
    })
      .then(setPatients)
      .catch((e) => setError((e as Error).message));
  }, [token]);

  useEffect(() => {
    if (!token) {
      navigate('/staff/login');
      return;
    }
    void loadPatients();
  }, [token, navigate, loadPatients]);

  // ── Derived: unique region + clinic option lists ──────────────────────────
  const { regionOptions, locationOptions } = useMemo(() => {
    const seenRegion = new Set<string>();
    const seenLoc = new Set<string>();
    const rOpts: { value: string; label: string }[] = [{ value: '', label: 'All regions' }];
    const lOpts: { value: string; label: string }[] = [{ value: '', label: 'All clinics' }];

    for (const p of patients) {
      // Region options (facility_group_name is a string key, not an id)
      if (p.facility_group_name && !seenRegion.has(p.facility_group_name)) {
        seenRegion.add(p.facility_group_name);
        rOpts.push({ value: p.facility_group_name, label: p.facility_group_name });
      }
      // Clinic options
      if (p.location_id && p.location_name && !seenLoc.has(p.location_id)) {
        seenLoc.add(p.location_id);
        const suffix = [p.facility_group_name, p.location_state].filter(Boolean).join(' · ');
        const label = suffix ? `${p.location_name}  (${suffix})` : p.location_name;
        lOpts.push({ value: p.location_id, label });
      }
    }
    return { regionOptions: rOpts, locationOptions: lOpts };
  }, [patients]);

  // ── Client-side filtering ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const today = todayStr();
    const weekEnd = weekEndStr();

    return patients.filter((p) => {
      // Name / chart # / region / clinic text search
      if (q) {
        const fullName = `${p.child_first_name} ${p.child_last_name}`.toLowerCase();
        const chart = (p.patient_acct_no ?? '').toLowerCase();
        const clinic = (p.location_name ?? '').toLowerCase();
        const region = (p.facility_group_name ?? '').toLowerCase();
        const state = (p.location_state ?? '').toLowerCase();
        if (
          !fullName.includes(q) &&
          !chart.includes(q) &&
          !clinic.includes(q) &&
          !region.includes(q) &&
          !state.includes(q)
        ) {
          return false;
        }
      }

      // Visit type
      if (filterVisit && p.visit_type !== filterVisit) return false;

      // Submission status
      if (filterStatus) {
        if (filterStatus === 'none' && p.latest_submission_status) return false;
        if (filterStatus !== 'none' && p.latest_submission_status !== filterStatus) return false;
      }

      // Parent portal
      if (filterPortal === 'yes' && !p.account_email) return false;
      if (filterPortal === 'no' && p.account_email) return false;

      // Region (facility_group_name)
      if (filterRegion && p.facility_group_name !== filterRegion) return false;

      // Clinic (location_id)
      if (filterLocation && p.location_id !== filterLocation) return false;

      // Appointment date
      if (filterAppt) {
        const appt = p.next_appointment_date;
        if (filterAppt === 'none' && appt) return false;
        if (filterAppt === 'today' && appt !== today) return false;
        if (filterAppt === 'week' && (!appt || appt < today || appt > weekEnd)) return false;
      }

      return true;
    });
  }, [patients, search, filterVisit, filterStatus, filterPortal, filterRegion, filterLocation, filterAppt]);

  // ── Sort (applied after filtering) ────────────────────────────────────────
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sort.key === 'appointment' ? apptSortValue(a) : (a.created_at ?? '');
      const bv = sort.key === 'appointment' ? apptSortValue(b) : (b.created_at ?? '');
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [filtered, sort]);

  // ── Pagination (applied after filtering + sorting) ────────────────────────
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Any change to the filtered/sorted result set invalidates the current page.
  useEffect(() => {
    setPage(1);
  }, [search, filterVisit, filterStatus, filterPortal, filterRegion, filterLocation, filterAppt, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const paged = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sorted, currentPage, pageSize],
  );

  // ── Upload stats: patients uploaded today, and how many already got a same-day form assignment ──
  const uploadStats = useMemo(() => {
    const today = todayStr();
    const uploadedToday = patients.filter((p) => (p.created_at ?? '').slice(0, 10) === today);
    const assignedSameDay = uploadedToday.filter((p) => p.assigned_same_day);
    return { uploadedToday: uploadedToday.length, assignedSameDay: assignedSameDay.length };
  }, [patients]);

  // ── Excel upload ──────────────────────────────────────────────────────────
  async function handleUploadExcel() {
    const f = fileRef.current?.files?.[0];
    if (!f || !token) {
      setUploadMsg('Choose an Excel file first.');
      return;
    }
    setUploading(true);
    setUploadMsg('');
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', f);
      const result = await api<BulkUploadResult>('/api/staff/patients/bulk-upload', {
        method: 'POST',
        headers: authHeader(token),
        body: fd,
      });
      const noteLines = result.errors.slice(0, 8);
      const auto = result.auto_form_assignments ?? [];
      const autoSummary =
        auto.length > 0
          ? ` Auto-assigned forms for ${auto.length} well-visit patient(s) (${auto.reduce((n, a) => n + a.assignments_created, 0)} new assignment(s)).`
          : '';
      const preview =
        result.imported_patients.length > 0
          ? ` First import: ${result.imported_patients[0].child_last_name}, ${result.imported_patients[0].child_first_name}` +
            (result.imported_patients[0].patient_acct_no
              ? ` (Chart # ${result.imported_patients[0].patient_acct_no})`
              : '')
          : '';
      setUploadMsg(
        `✅ Upload successful — inserted ${result.inserted}, skipped ${result.skipped}, total sheet rows ${result.total_rows}.${preview}${autoSummary}${
          noteLines.length ? ` Notes: ${noteLines.join('; ')}` : ''
        }`,
      );
      if (fileRef.current) fileRef.current.value = '';
      await loadPatients();
    } catch (e) {
      setUploadMsg(`❌ Upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <div className="page-header">
          <h2 className="page-title">Today&apos;s Patients</h2>
          <p className="text-muted" style={{ margin: 0 }}>
            Need to manage forms? <Link to="/staff/templates">Open form builder</Link>
          </p>
        </div>

        {/* ── Upload stats ── */}
        <div
          style={{
            display: 'flex',
            gap: 14,
            marginBottom: 16,
            flexWrap: 'wrap',
          }}
        >
          <StatTile label="Patients uploaded today" value={uploadStats.uploadedToday} />
          <StatTile
            label="Forms assigned same day as upload"
            value={`${uploadStats.assignedSameDay} / ${uploadStats.uploadedToday}`}
            warn={uploadStats.uploadedToday > 0 && uploadStats.assignedSameDay < uploadStats.uploadedToday}
          />
        </div>

        {/* ── Filter bar ── */}
        <div
          style={{
            background: 'var(--color-surface, #f9fafb)',
            border: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: 10,
            padding: '14px 16px',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-brand, #2563eb)' }}>
              Filters
            </span>
            {hasActiveFilters && (
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={clearFilters}
                style={{ fontSize: 12 }}
              >
                Clear all
              </button>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
              gap: '10px 14px',
            }}
          >
            {/* Name / chart # / location text search */}
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 12 }}>Name / Chart # / Location</label>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                style={{ fontSize: 13 }}
              />
            </div>

            {/* Visit type */}
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 12 }}>Visit type</label>
              <select
                value={filterVisit}
                onChange={(e) => setFilterVisit(e.target.value)}
                style={{ fontSize: 13 }}
              >
                {VISIT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Form status */}
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 12 }}>Form status</label>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                style={{ fontSize: 13 }}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Region / Facility Group (only if present) */}
            {regionOptions.length > 1 && (
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12 }}>Region / Facility Group</label>
                <select
                  value={filterRegion}
                  onChange={(e) => {
                    setFilterRegion(e.target.value);
                    setFilterLocation(''); // reset clinic when region changes
                  }}
                  style={{ fontSize: 13 }}
                >
                  {regionOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Clinic / Facility Name */}
            {locationOptions.length > 1 && (
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12 }}>Clinic / Facility</label>
                <select
                  value={filterLocation}
                  onChange={(e) => setFilterLocation(e.target.value)}
                  style={{ fontSize: 13 }}
                >
                  {/* When a region is selected, only show clinics in that region */}
                  {locationOptions
                    .filter(
                      (o) =>
                        !o.value ||
                        !filterRegion ||
                        patients.some(
                          (p) => p.location_id === o.value && p.facility_group_name === filterRegion,
                        ),
                    )
                    .map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
              </div>
            )}

            {/* Appointment date */}
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 12 }}>Appointment</label>
              <select
                value={filterAppt}
                onChange={(e) => setFilterAppt(e.target.value)}
                style={{ fontSize: 13 }}
              >
                {APPT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Parent portal */}
            <div className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 12 }}>Parent portal</label>
              <select
                value={filterPortal}
                onChange={(e) => setFilterPortal(e.target.value)}
                style={{ fontSize: 13 }}
              >
                {PORTAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* ── Result count + active filter chips ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: '#555', fontWeight: 500 }}>
            {filtered.length} patient{filtered.length !== 1 ? 's' : ''}
            {filtered.length !== patients.length && (
              <span style={{ color: '#888', fontWeight: 400 }}> (of {patients.length} total)</span>
            )}
          </span>

          {/* Active filter chips */}
          {filterVisit && (
            <FilterChip
              label={`Visit: ${VISIT_TYPE_OPTIONS.find((o) => o.value === filterVisit)?.label ?? filterVisit}`}
              onRemove={() => setFilterVisit('')}
            />
          )}
          {filterStatus && (
            <FilterChip
              label={`Status: ${STATUS_OPTIONS.find((o) => o.value === filterStatus)?.label ?? filterStatus}`}
              onRemove={() => setFilterStatus('')}
            />
          )}
          {filterRegion && (
            <FilterChip
              label={`Region: ${filterRegion}`}
              onRemove={() => { setFilterRegion(''); setFilterLocation(''); }}
            />
          )}
          {filterLocation && (
            <FilterChip
              label={`Clinic: ${locationOptions.find((o) => o.value === filterLocation)?.label ?? filterLocation}`}
              onRemove={() => setFilterLocation('')}
            />
          )}
          {filterAppt && (
            <FilterChip
              label={`Appt: ${APPT_OPTIONS.find((o) => o.value === filterAppt)?.label ?? filterAppt}`}
              onRemove={() => setFilterAppt('')}
            />
          )}
          {filterPortal && (
            <FilterChip
              label={PORTAL_OPTIONS.find((o) => o.value === filterPortal)?.label ?? filterPortal}
              onRemove={() => setFilterPortal('')}
            />
          )}
        </div>

        {/* ── Excel import ── */}
        <div className="row" style={{ marginTop: '0.5rem', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
          <div className="field">
            <label>Import patient schedule</label>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            />
          </div>
          <button type="button" disabled={uploading || !token} onClick={() => void handleUploadExcel()}>
            {uploading ? 'Importing…' : 'Import schedule'}
          </button>
        </div>
        {uploadMsg && (
          <p
            style={{
              marginTop: '0.5rem',
              color: uploadMsg.startsWith('✅') ? 'green' : 'red',
              fontWeight: 500,
              fontSize: 13,
            }}
          >
            {uploadMsg}
          </p>
        )}

        {error ? <div className="error">{error}</div> : null}

        {/* ── Delete confirm modal ── */}
        {confirmDeletePatient && (
          <div
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
            }}
            onClick={() => !deleting && setConfirmDeleteId(null)}
          >
            <div
              style={{
                background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 420, width: '90%',
                boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 700 }}>Delete patient?</h3>
              <p style={{ margin: '0 0 20px', color: '#4b5563', fontSize: 14, lineHeight: 1.5 }}>
                This will permanently delete{' '}
                <strong>
                  {confirmDeletePatient.child_first_name} {confirmDeletePatient.child_last_name}
                </strong>
                {confirmDeletePatient.patient_acct_no ? ` (Chart #${confirmDeletePatient.patient_acct_no})` : ''}
                {' '}and all their records — submissions, assignments, appointments, and portal account. This cannot be undone.
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={deleting}
                  onClick={() => setConfirmDeleteId(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleDeleteConfirm}
                  style={{
                    background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6,
                    padding: '6px 16px', fontWeight: 600, fontSize: 13, cursor: 'pointer',
                  }}
                >
                  {deleting ? 'Deleting…' : 'Yes, delete'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Table ── */}
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th>First name</th>
                <th>Last name</th>
                <th>Chart #</th>
                {(regionOptions.length > 1 || locationOptions.length > 1) && <th>Region / Clinic</th>}
                <th>DOB</th>
                <th
                  onClick={() => toggleSort('appointment')}
                  style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                  title="Click to sort by appointment date"
                >
                  Appointment{sortIndicator('appointment')}
                </th>
                <th
                  onClick={() => toggleSort('uploaded')}
                  style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                  title="Click to sort by the date this patient's record was uploaded"
                >
                  Uploaded{sortIndicator('uploaded')}
                </th>
                <th>Visit type</th>
                <th>Form status</th>
                <th>Parent portal</th>
                <th>Action</th>
                <th>Reg PDF</th>
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={(regionOptions.length > 1 || locationOptions.length > 1) ? 13 : 12}
                    style={{ textAlign: 'center', color: '#888', padding: '24px 0' }}
                  >
                    {patients.length === 0
                      ? 'No patients yet. Import a schedule to get started.'
                      : 'No patients match the current filters.'}
                  </td>
                </tr>
              )}
              {paged.map((patient) => (
                <tr key={patient.id}>
                  <td style={{ fontWeight: 600 }}>{patient.child_first_name}</td>
                  <td style={{ fontWeight: 600 }}>{patient.child_last_name}</td>
                  <td>{patient.patient_acct_no ?? '—'}</td>
                  {(regionOptions.length > 1 || locationOptions.length > 1) && (
                    <td>
                      {patient.location_name ? (
                        <div style={{ lineHeight: 1.4 }}>
                          {/* Region row */}
                          {patient.facility_group_name && (
                            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>
                              {patient.facility_group_name}
                            </div>
                          )}
                          {/* Clinic row */}
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>
                            {patient.location_name}
                          </div>
                          {/* State/City */}
                          {(patient.location_state || patient.location_city) && (
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>
                              {[patient.location_city, patient.location_state].filter(Boolean).join(', ')}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: '#bbb' }}>—</span>
                      )}
                    </td>
                  )}
                  <td style={{ fontSize: 13 }}>{patient.child_dob ?? '—'}</td>
                  <td style={{ fontSize: 13 }}>{formatNextAppt(patient)}</td>
                  <td style={{ fontSize: 13 }}>
                    {patient.created_at ? patient.created_at.slice(0, 10) : '—'}
                    {!patient.assigned_same_day &&
                      patient.created_at?.slice(0, 10) === todayStr() && (
                        <span
                          title="Uploaded today but no form assigned yet"
                          style={{ color: '#dc2626', marginLeft: 4 }}
                        >
                          ⚠
                        </span>
                      )}
                  </td>
                  <td>
                    <VisitBadge type={patient.visit_type} />
                  </td>
                  <td>
                    <StatusBadge status={patient.latest_submission_status} />
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {patient.account_email ? (
                      <span style={{ color: 'var(--color-brand, #2563eb)', fontWeight: 500 }}>Active</span>
                    ) : (
                      <span style={{ color: '#bbb' }}>None</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Link to={`/staff/patients/${patient.id}`} className="btn-ghost btn-sm">
                      View
                    </Link>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      title="Download registration PDF"
                      onClick={() => {
                        fetch(`${API_BASE}/api/staff/patients/${patient.id}/registration-pdf`, {
                          headers: { Authorization: `Bearer ${token}` },
                        }).then((r) => {
                          if (!r.ok) { alert('No registration on file for this patient.'); return; }
                          return r.blob().then((blob) => {
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `registration_${patient.child_first_name ?? ''}_${patient.child_last_name ?? ''}.pdf`;
                            a.click();
                            URL.revokeObjectURL(url);
                          });
                        });
                      }}
                      style={{
                        background: 'transparent',
                        border: '1px solid #93c5fd',
                        borderRadius: 5,
                        color: '#1d4ed8',
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 500,
                        padding: '3px 8px',
                        lineHeight: 1.4,
                      }}
                    >
                      Reg PDF
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(patient.id)}
                      title="Delete patient"
                      style={{
                        background: 'transparent',
                        border: '1px solid #fca5a5',
                        borderRadius: 5,
                        color: '#dc2626',
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 500,
                        padding: '3px 8px',
                        lineHeight: 1.4,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {sorted.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
              marginTop: 12,
            }}
          >
            <div style={{ fontSize: 13, color: '#555' }}>
              Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, sorted.length)} of{' '}
              {sorted.length}
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                style={{ fontSize: 12, marginLeft: 10, padding: '2px 4px' }}
              >
                {[25, 50, 100, 200].map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={currentPage <= 1}
                onClick={() => setPage(1)}
              >
                « First
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹ Prev
              </button>
              <span style={{ fontSize: 13, padding: '0 4px' }}>
                Page {currentPage} of {pageCount}
              </span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={currentPage >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                Next ›
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={currentPage >= pageCount}
                onClick={() => setPage(pageCount)}
              >
                Last »
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small helper components ───────────────────────────────────────────────────

function StatTile({
  label,
  value,
  warn,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
}) {
  return (
    <div
      style={{
        background: warn ? '#fef2f2' : 'var(--color-surface, #f9fafb)',
        border: `1px solid ${warn ? '#fecaca' : 'var(--color-border, #e5e7eb)'}`,
        borderRadius: 10,
        padding: '10px 16px',
        minWidth: 180,
      }}
    >
      <div style={{ fontSize: 12, color: warn ? '#991b1b' : '#6b7280', fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: warn ? '#dc2626' : '#111' }}>{value}</div>
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        background: 'var(--color-brand, #2563eb)',
        color: '#fff',
        borderRadius: 20,
        padding: '2px 10px 2px 10px',
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        style={{
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.8)',
          cursor: 'pointer',
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
          marginLeft: 2,
        }}
        aria-label={`Remove ${label} filter`}
      >
        ×
      </button>
    </span>
  );
}

function VisitBadge({ type }: { type: string | null }) {
  const label = formatVisitType(type);
  const colors: Record<string, { bg: string; color: string }> = {
    well_child:  { bg: '#dcfce7', color: '#166534' },
    new_patient: { bg: '#dbeafe', color: '#1e40af' },
    sick:        { bg: '#fee2e2', color: '#991b1b' },
    follow_up:   { bg: '#fef3c7', color: '#92400e' },
  };
  const style = type ? colors[type] : null;
  if (!type) return <span style={{ color: '#bbb' }}>—</span>;
  return (
    <span
      style={{
        display: 'inline-block',
        background: style?.bg ?? '#f3f4f6',
        color: style?.color ?? '#374151',
        borderRadius: 12,
        padding: '2px 9px',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span style={{ color: '#bbb', fontSize: 13 }}>—</span>;
  const colors: Record<string, { bg: string; color: string }> = {
    in_progress: { bg: '#fef9c3', color: '#854d0e' },
    completed:   { bg: '#dcfce7', color: '#166534' },
    exported:    { bg: '#dbeafe', color: '#1e40af' },
  };
  const style = colors[status];
  return (
    <span
      style={{
        display: 'inline-block',
        background: style?.bg ?? '#f3f4f6',
        color: style?.color ?? '#374151',
        borderRadius: 12,
        padding: '2px 9px',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {formatSubmissionStatus(status)}
    </span>
  );
}
