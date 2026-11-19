// notifications.ts - notification projection helpers for the right-rail panel.
// The shell consumes canonical ops_alerts rows via AppShell/useResourceList.

export interface NotifItem {
  id: string;
  tone: 'good' | 'warn' | 'danger' | 'info';
  title: string;
  body: string;
  time: string;
  route?: string;
  unread?: boolean;
}

export interface OpsAlertNotificationRow extends Record<string, unknown> {
  id: string;
  severity?: string | null;
  opened_at?: string | null;
  created_at?: string | null;
  acknowledged_at?: string | null;
  alert_type?: string | null;
  source?: string | null;
  message?: string | null;
  details?: Record<string, unknown> | null;
}

export const DEFAULT_NOTIFICATIONS: NotifItem[] = [];

function toneFromSeverity(severity: unknown): NotifItem['tone'] {
  const key = String(severity ?? '').toLowerCase();
  if (key === 'critical' || key === 'error' || key === 'danger') return 'danger';
  if (key === 'warn' || key === 'warning') return 'warn';
  if (key === 'ok' || key === 'resolved') return 'good';
  return 'info';
}

function displayTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function notificationFromOpsAlert(row: OpsAlertNotificationRow): NotifItem {
  const resolvedAt = row.details?.resolved_at;
  const unresolved = typeof resolvedAt !== 'string' || !resolvedAt;
  const source = row.alert_type ?? row.source ?? 'ops_alert';
  const severity = row.severity ?? 'info';
  return {
    id: row.id,
    tone: unresolved ? toneFromSeverity(severity) : 'good',
    title: `${String(severity).toUpperCase()} - ${String(source)}`,
    body: row.message ?? row.id,
    time: displayTime(row.opened_at ?? row.created_at),
    route: '/platform/alerts',
    unread: unresolved && !row.acknowledged_at,
  };
}
