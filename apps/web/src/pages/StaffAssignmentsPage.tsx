import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, authHeader } from '../lib/api';

type Props = {
  token: string | null;
};

type PublishedTemplate = {
  id: string;
  name: string;
  template_key: string;
};

type AssignmentRecord = {
  id: string;
  token: string;
  status: string;
  expires_at: string;
  created_at: string;
  patient_id: string;
  child_first_name: string;
  child_last_name: string;
  child_dob: string;
  template_name: string;
  assigned_by_email: string;
  submission_id: string | null;
  next_appointment_date: string | null;
  next_appointment_time: string | null;
};

/** One row per patient, aggregating every form assigned to them. */
type PatientFormRow = {
  patientId: string;
  child_first_name: string;
  child_last_name: string;
  child_dob: string;
  next_appointment_date: string | null;
  next_appointment_time: string | null;
  forms: Array<{ assignmentId: string; template_name: string; status: string }>;
};

function groupByPatient(assignments: AssignmentRecord[]): PatientFormRow[] {
  const byPatient = new Map<string, PatientFormRow>();
  for (const a of assignments) {
    let row = byPatient.get(a.patient_id);
    if (!row) {
      row = {
        patientId: a.patient_id,
        child_first_name: a.child_first_name,
        child_last_name: a.child_last_name,
        child_dob: a.child_dob,
        next_appointment_date: a.next_appointment_date,
        next_appointment_time: a.next_appointment_time,
        forms: [],
      };
      byPatient.set(a.patient_id, row);
    }
    row.forms.push({ assignmentId: a.id, template_name: a.template_name, status: a.status });
  }
  const rows = Array.from(byPatient.values());
  // Most recent (soonest) appointment first; patients with no appointment date sort last.
  rows.sort((a, b) => {
    const av = a.next_appointment_date ?? '9999-99-99';
    const bv = b.next_appointment_date ?? '9999-99-99';
    if (av !== bv) return av < bv ? -1 : 1;
    const at = a.next_appointment_time ?? '';
    const bt = b.next_appointment_time ?? '';
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
  return rows;
}

function formStatusStyle(status: string) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    pending:     { bg: '#cfe2ff', color: '#084298', label: 'Form Sent' },
    in_progress: { bg: '#fff3cd', color: '#856404', label: 'Started' },
    completed:   { bg: '#d4edda', color: '#155724', label: 'Completed' },
    expired:     { bg: '#f8d7da', color: '#721c24', label: 'Expired' },
  };
  return map[status] ?? { bg: '#f3f4f6', color: '#374151', label: status };
}

type PatientSearchResult = {
  id: string;
  child_first_name: string;
  child_last_name: string;
  child_dob: string;
  patient_acct_no: string | null;
  account_email: string | null;
};

export function StaffAssignmentsPage({ token }: Props) {
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<PublishedTemplate[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRecord[]>([]);
  const [error, setError] = useState('');

  const patientRows = useMemo(() => groupByPatient(assignments), [assignments]);

  const [showForm, setShowForm] = useState(false);
  const [patientMode, setPatientMode] = useState<'existing' | 'new'>('existing');

  // Existing patient search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PatientSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState<PatientSearchResult | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // New patient fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');

  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [assignedMessage, setAssignedMessage] = useState<string | null>(null);

  async function loadTemplates() {
    if (!token) return;
    try {
      const result = await api<any[]>('/api/staff/templates', { headers: authHeader(token) });
      setTemplates(
        result
          .filter((t: any) => t.status === 'published')
          .map((t: any) => ({ id: t.id, name: t.name, template_key: t.template_key })),
      );
    } catch {
      // non-fatal
    }
  }

  async function loadAssignments() {
    if (!token) return;
    try {
      const result = await api<AssignmentRecord[]>('/api/staff/assignments', { headers: authHeader(token) });
      setAssignments(result);
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    if (!token) {
      navigate('/staff/login');
      return;
    }
    loadTemplates();
    loadAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    setSelectedPatient(null);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!value.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    searchDebounceRef.current = setTimeout(async () => {
      if (!token) return;
      setSearchLoading(true);
      try {
        const results = await api<PatientSearchResult[]>(
          `/api/staff/patients?search=${encodeURIComponent(value.trim())}`,
          { headers: authHeader(token) },
        );
        setSearchResults(results);
        setShowDropdown(true);
      } catch {
        // non-fatal
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }

  function selectPatient(p: PatientSearchResult) {
    setSelectedPatient(p);
    setSearchQuery(`${p.child_first_name} ${p.child_last_name}`);
    setShowDropdown(false);
    setSearchResults([]);
  }

  function toggleTemplate(id: string) {
    setSelectedTemplateIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }

  function canCreate() {
    if (selectedTemplateIds.length === 0) return false;
    if (patientMode === 'existing') return !!selectedPatient;
    return !!firstName.trim() && !!lastName.trim() && !!dob;
  }

  async function handleCreate() {
    if (!token || !canCreate()) return;
    setSubmitting(true);
    setError('');
    try {
      const body =
        patientMode === 'existing'
          ? { patient_id: selectedPatient!.id, template_ids: selectedTemplateIds }
          : { first_name: firstName.trim(), last_name: lastName.trim(), dob, template_ids: selectedTemplateIds };

      await api('/api/staff/assignments', {
        method: 'POST',
        headers: authHeader(token),
        body: JSON.stringify(body),
      });

      const patientName =
        patientMode === 'existing'
          ? `${selectedPatient!.child_first_name} ${selectedPatient!.child_last_name}`
          : `${firstName.trim()} ${lastName.trim()}`;

      setAssignedMessage(patientName);
      setShowForm(false);
      setSelectedPatient(null);
      setSearchQuery('');
      setFirstName('');
      setLastName('');
      setDob('');
      setSelectedTemplateIds([]);
      await loadAssignments();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteAssignment(id: string) {
    if (!token) return;
    if (!window.confirm('Delete this assignment? This cannot be undone.')) return;
    try {
      await api(`/api/staff/assignments/${id}`, { method: 'DELETE', headers: authHeader(token) });
      await loadAssignments();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Form assignments</h2>
          <button
            onClick={() => {
              setShowForm((v) => !v);
              setAssignedMessage(null);
              setError('');
            }}
          >
            {showForm ? 'Cancel' : '+ Assign forms'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

        {showForm && (
          <div className="card" style={{ background: '#f0f7ff', marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Assign forms to patient</h3>

            {/* Patient mode toggle */}
            <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 6, overflow: 'hidden', border: '1px solid #c5d8f0', width: 'fit-content' }}>
              <button
                onClick={() => setPatientMode('existing')}
                style={{
                  borderRadius: 0,
                  border: 'none',
                  background: patientMode === 'existing' ? '#2563eb' : '#fff',
                  color: patientMode === 'existing' ? '#fff' : '#333',
                  padding: '6px 16px',
                  fontWeight: patientMode === 'existing' ? 600 : 400,
                  cursor: 'pointer',
                }}
              >
                Existing Patient
              </button>
              <button
                onClick={() => setPatientMode('new')}
                style={{
                  borderRadius: 0,
                  border: 'none',
                  borderLeft: '1px solid #c5d8f0',
                  background: patientMode === 'new' ? '#2563eb' : '#fff',
                  color: patientMode === 'new' ? '#fff' : '#333',
                  padding: '6px 16px',
                  fontWeight: patientMode === 'new' ? 600 : 400,
                  cursor: 'pointer',
                }}
              >
                New Patient
              </button>
            </div>

            {patientMode === 'existing' ? (
              <div style={{ marginBottom: 12 }}>
                <div className="field" ref={dropdownRef} style={{ position: 'relative', maxWidth: 360 }}>
                  <label>Search Patient</label>
                  <input
                    value={searchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    placeholder="Search by first or last name..."
                    autoComplete="off"
                  />
                  {searchLoading && (
                    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Searching...</div>
                  )}
                  {showDropdown && searchResults.length > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      background: '#fff',
                      border: '1px solid #c5d8f0',
                      borderRadius: 6,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                      zIndex: 100,
                      maxHeight: 220,
                      overflowY: 'auto',
                    }}>
                      {searchResults.map((p) => (
                        <div
                          key={p.id}
                          onClick={() => selectPatient(p)}
                          style={{
                            padding: '10px 14px',
                            cursor: 'pointer',
                            borderBottom: '1px solid #f0f0f0',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f7ff')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                        >
                          <div style={{ fontWeight: 600 }}>{p.child_first_name} {p.child_last_name}</div>
                          <div style={{ fontSize: 12, color: '#666' }}>{p.patient_acct_no ? `Chart #${p.patient_acct_no}` : ''}  {p.account_email ? ` · ${p.account_email}` : ''}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {showDropdown && searchResults.length === 0 && !searchLoading && searchQuery.trim() && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      background: '#fff',
                      border: '1px solid #c5d8f0',
                      borderRadius: 6,
                      padding: '10px 14px',
                      fontSize: 13,
                      color: '#888',
                      zIndex: 100,
                    }}>
                      No patients found. Try "New Patient" to create one.
                    </div>
                  )}
                </div>
                {selectedPatient && (
                  <div style={{ marginTop: 8, padding: '8px 12px', background: '#dbeafe', borderRadius: 6, border: '1px solid #3b82f6', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, maxWidth: 360 }}>
                    <span style={{ flex: 1 }}>
                      <strong>{selectedPatient.child_first_name} {selectedPatient.child_last_name}</strong>
                      {selectedPatient.patient_acct_no && <span style={{ color: '#555', marginLeft: 8 }}>Chart #{selectedPatient.patient_acct_no}</span>}
                    </span>
                    <button
                      onClick={() => { setSelectedPatient(null); setSearchQuery(''); }}
                      style={{ fontSize: 11, padding: '2px 8px', color: '#c00', borderColor: '#c00', background: 'transparent' }}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="row" style={{ marginBottom: 0 }}>
                <div className="field">
                  <label>First Name</label>
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" />
                </div>
                <div className="field">
                  <label>Last Name</label>
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" />
                </div>
                <div className="field">
                  <label>Date of Birth</label>
                  <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
                </div>
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 8 }}>
                Forms to send
                {selectedTemplateIds.length > 0 && (
                  <span style={{ fontWeight: 400, color: '#555', marginLeft: 8 }}>
                    ({selectedTemplateIds.length} selected)
                  </span>
                )}
              </label>
              {templates.length === 0 ? (
                <p style={{ fontSize: 13, color: '#888' }}>No active forms available.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {templates.map((t) => (
                    <label
                      key={t.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: selectedTemplateIds.includes(t.id) ? '#dbeafe' : '#fff',
                        border: `1px solid ${selectedTemplateIds.includes(t.id) ? '#3b82f6' : '#ddd'}`,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTemplateIds.includes(t.id)}
                        onChange={() => toggleTemplate(t.id)}
                        style={{ width: 16, height: 16 }}
                      />
                      <span>{t.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <button onClick={handleCreate} disabled={submitting || !canCreate()}>
              {submitting ? 'Assigning...' : `Assign ${selectedTemplateIds.length > 1 ? `${selectedTemplateIds.length} forms` : 'form'}`}
            </button>
            {patientMode === 'new' && (
              <p style={{ fontSize: 12, color: '#666', marginTop: 8, marginBottom: 0 }}>
                If no patient record exists for this name + DOB, one will be created automatically.
              </p>
            )}
          </div>
        )}

        {assignedMessage && (
          <div style={{ marginTop: 16, padding: 16, background: '#f0fdf4', borderRadius: 8, border: '1px solid #86efac' }}>
            <p style={{ margin: '0 0 6px', fontWeight: 600, color: '#166534' }}>
              Forms assigned to {assignedMessage}
            </p>
            <p style={{ margin: 0, fontSize: 13, color: '#374151' }}>
              Ask the patient to sign in at{' '}
              <strong>admin.pediformpro.com/parent/login</strong>{' '}
              using their first name, last name, and date of birth to access their forms.
            </p>
          </div>
        )}

        {assignments.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h3>All sent forms</h3>
            <p style={{ marginTop: -8, marginBottom: 12, fontSize: 13, color: '#666' }}>
              Sorted by soonest appointment first. Each patient&apos;s forms show whether they were opened
              (Started) or submitted (Completed) — not just sent.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>DOB</th>
                  <th>Appointment</th>
                  <th>Form-Status</th>
                </tr>
              </thead>
              <tbody>
                {patientRows.map((row) => (
                  <tr key={row.patientId}>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {row.child_first_name} {row.child_last_name}
                    </td>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{row.child_dob ?? '—'}</td>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                      {row.next_appointment_date
                        ? `${row.next_appointment_date}${row.next_appointment_time ? ' ' + row.next_appointment_time : ''}`
                        : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {row.forms.map((f) => {
                          const s = formStatusStyle(f.status);
                          return (
                            <span
                              key={f.assignmentId}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                background: s.bg,
                                color: s.color,
                                borderRadius: 4,
                                padding: '3px 4px 3px 8px',
                                fontSize: 12,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              <strong>{f.template_name}:</strong> {s.label}
                              <button
                                type="button"
                                title={`Delete ${f.template_name} assignment`}
                                onClick={() => handleDeleteAssignment(f.assignmentId)}
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  color: s.color,
                                  cursor: 'pointer',
                                  fontSize: 13,
                                  lineHeight: 1,
                                  padding: '0 2px',
                                  opacity: 0.6,
                                }}
                              >
                                ×
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {assignments.length === 0 && !showForm && (
          <p style={{ marginTop: 24, color: '#666' }}>No forms assigned yet. Click "+ Assign forms" to get started.</p>
        )}
      </div>
    </div>
  );
}
