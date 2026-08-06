/** Human-readable labels for staff UI (status codes, visit types, etc.). */

export function formatVisitType(visitType: string | null | undefined): string {
  if (!visitType) return '—';
  const map: Record<string, string> = {
    new_patient: 'New patient',
    follow_up: 'Follow-up',
    well_child: 'Well visit',
    sick: 'Sick visit',
  };
  return map[visitType] ?? visitType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatAssignmentStatus(status: string): string {
  const map: Record<string, string> = {
    pending: 'Form Sent',
    in_progress: 'Started',
    completed: 'Completed',
    expired: 'Expired',
  };
  return map[status] ?? status;
}

export function formatSubmissionStatus(status: string): string {
  const map: Record<string, string> = {
    in_progress: 'Started',
    completed: 'Completed',
    exported: 'Downloaded',
  };
  return map[status] ?? status;
}

export function formatTemplateStatus(status: string): string {
  if (status === 'published') return 'Active';
  if (status === 'draft') return 'Draft';
  if (status === 'archived') return 'Archived';
  return status;
}

export function formatAcroformReady(ready: boolean): string {
  return ready ? 'Ready' : 'Not ready';
}

export function formatParentPortalAccount(email: string | null | undefined): string {
  return email ?? 'No portal account';
}
