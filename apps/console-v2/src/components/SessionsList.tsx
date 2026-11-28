// SessionsList.tsx — reusable per-user auth sessions roster (Phase E2).
//
// SURFACES THAT EMBED THIS COMPONENT
//   1. UserMenuDrawer (Account → "Your sessions" tab) — caller passes the
//      current user's id and capability gate `users.read`. The user can only
//      revoke *their own* sessions; the row Revoke button is hidden when the
//      caller lacks `users.manage`.
//   2. /platform/users drawer (Sessions tab; landing as part of D4) — caller
//      passes `userId` of the operator-selected user with capability
//      `users.manage`. Cross-user revoke is permitted.
//
// BACKEND SSOT (anchored)
//   • Read seam: `useUserSessions()` -> `api.ui_list_user_sessions_v1`, which
//     wraps `public.ui_list_user_sessions_v1`. The RPC reads scoped
//     `auth.sessions` + `public.revocation_audit` evidence without exposing
//     a raw auth table to Console V2.
//   • Revoke seam: `useRevokeSession()` → `revoke_session_v1` per
//     supabase/migrations/202604280212_revoke_session_v1.sql. The RPC writes a
//     revocation INTENT row to `public.revocation_audit` (status='pending')
//     and emits `domain_events.session.revocation_requested`; the actual
//     `auth.sessions` termination is performed out-of-band by the edge worker
//     calling Supabase Admin API `auth.admin.signOut(user_id)`. This is why
//     the row Revoke button shows a "Revoke pending" state from backend
//     readback instead of requiring a browser reload.
//
// CAPABILITIES
//   read  → 'users.read'   (gate the Sessions section as a whole)
//   write → 'users.manage' (gate the per-row Revoke action)
//
// ZERO HARDCODING
//   • Row shape and lookup tones come from registry.js + lookups.session_aal.
//   • Capability strings are literal but match the canonical entries in
//     supabase/migrations/202601022113_access_control_policy_core.sql:216-217.
//   • No tenant- or scope-specific branches inside this file; all gating runs
//     through `useCapability(capability)`.
import { useState, type ReactNode } from 'react';
import { useRevokeSession, useUserSessions } from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { lookupRow } from '@/lib/api';
import { Button } from './Button';
import { Chip, type ChipKind } from './Chip';
import { StateView } from './StateView';
import { CapabilityLock } from './CapabilityLock';
import { pushToast } from './toastStore';
import { fill, useT } from '@/lib/i18n';

type Translate = (path: string, fallback?: string) => string;

export interface UserSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  organization_id?: string | null;
  user_email?: string | null;
  user_agent?: string | null;
  ip?: string | null;
  /** AAL tier — aal1 / aal2 / aal3 (mirrors auth.sessions.aal). */
  aal?: string | null;
  factor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  not_after?: string | null;
  is_current?: boolean | null;
  revocation_audit_id?: string | null;
  revocation_status?: string | null;
  revocation_reason?: string | null;
  revocation_requested_at?: string | null;
  revocation_processed_at?: string | null;
  revocation_correlation_id?: string | null;
}

export interface SessionsListProps {
  /** When set, only sessions for that user are rendered (own-sessions tab).
   *  When omitted (or null), every session in scope is rendered (admin tab). */
  userId?: string | null;
  /**
   * Capability gating override. Defaults:
   *   readCapability  = 'users.read'   — gate the section visibility
   *   writeCapability = 'users.manage' — gate the per-row Revoke action
   * Both anchor on the backend SSOT
   * (supabase/migrations/202601022113_access_control_policy_core.sql:216-217).
   */
  readCapability?: string;
  writeCapability?: string;
  /** Optional title rendered above the list (default: 'Active sessions'). */
  title?: ReactNode;
  /** Optional className for layout overrides. */
  className?: string;
  /** When true the component skips the section title (for embeds where the
   *  surrounding tab already supplies it). */
  hideTitle?: boolean;
}


function formatRelativeMinutes(ts: string | undefined, t: Translate): string {
  if (!ts) return '—';
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return t('shell.time.justNow');
  if (minutes < 60) return fill(t('shell.time.minutesAgo'), { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fill(t('shell.time.hoursAgo'), { n: hours });
  const days = Math.round(hours / 24);
  return fill(t('shell.time.daysAgo'), { n: days });
}

function shortenAgent(ua: string | undefined, t: Translate): string {
  if (!ua) return t('shell.sessions.unknownAgent');
  // Trim long UA strings to a recognizable prefix without hardcoding a brand
  // table — the readable token (Browser/Version) typically lives between the
  // first parens block and the next semicolon. We keep at most ~64 chars so
  // the row stays scannable.
  if (ua.length <= 64) return ua;
  return `${ua.slice(0, 60)}…`;
}

function revocationStatusOf(row: UserSessionRow): string {
  return String(row.revocation_status ?? '').trim().toLowerCase();
}

function revocationStatusLabel(status: string, t: Translate): string {
  return t(`shell.revocation.${status}`, status);
}

function formatRevocation(row: UserSessionRow, t: Translate): string {
  const status = revocationStatusOf(row);
  if (!status) return '';
  let line = fill(t('shell.sessions.revocation'), { status: revocationStatusLabel(status, t) });
  if (row.revocation_requested_at) {
    line = fill(t('shell.sessions.revocationAt'), { line, time: new Date(row.revocation_requested_at).toLocaleString() });
  }
  if (row.revocation_reason) line = fill(t('shell.sessions.revocationReason'), { line, reason: row.revocation_reason });
  return line;
}

export function SessionsList({
  userId,
  readCapability = 'users.read',
  writeCapability = 'users.manage',
  title: titleProp,
  className,
  hideTitle = false,
}: SessionsListProps) {
  const t = useT();
  const title = titleProp ?? t('shell.sessions.title');
  const canRead = useCapability(readCapability);
  const canManage = useCapability(writeCapability);

  // Fetch the full list and filter client-side when `userId` is set. The
  // resource registry already gates the read on `users.read`, so when
  // canRead=false we don't even mount the query — fail-closed, matches the
  // backend posture for `revoke_session_v1`.
  const canQuery = canRead && (Boolean(userId) || canManage);
  const list = useUserSessions(userId ?? null, 50, canQuery);

  const revoke = useRevokeSession();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [revokeFormId, setRevokeFormId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const revokeReasonValid = revokeReason.trim().length > 0;

  const classes = ['sessions-list', className].filter(Boolean).join(' ');

  if (!canRead) {
    return (
      <section className={classes} data-testid="sessions-list">
        {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
        <StateView kind="denied" capability={readCapability} />
      </section>
    );
  }

  if (!userId && !canManage) {
    return (
      <section className={classes} data-testid="sessions-list">
        {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
        <StateView kind="denied" capability={writeCapability} />
      </section>
    );
  }

  if (list.isLoading) {
    return (
      <section className={classes} data-testid="sessions-list">
        {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
        <StateView kind="loading" />
      </section>
    );
  }

  if (list.isError) {
    return (
      <section className={classes} data-testid="sessions-list">
        {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
        <StateView
          kind="error"
          hint={(list.error as Error | undefined)?.message ?? t('shell.sessions.loadFailed')}
        />
      </section>
    );
  }

  const rows = list.data?.rows ?? [];

  const handleRevoke = async (row: UserSessionRow) => {
    if (!canManage) return;
    const trimmedReason = revokeReason.trim();
    if (!trimmedReason) {
      pushToast(t('shell.sessions.reasonRequiredToast'), 'warn');
      return;
    }
    setPendingId(row.id);
    try {
      await revoke.mutateAsync({
        target_user_id: row.user_id,
        session_id: row.id,
        reason: trimmedReason,
      });
      pushToast(t('shell.sessions.revokeQueued'), 'good');
      setRevokeFormId(null);
      setRevokeReason('');
    } catch (e) {
      pushToast(fill(t('shell.sessions.revokeFailed'), { reason: (e as Error)?.message ?? t('shell.unknown') }), 'danger');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className={classes} data-testid="sessions-list">
      {hideTitle ? null : <div className="section-eyebrow">{title}</div>}

      {rows.length === 0 ? (
        <StateView kind="empty" />
      ) : (
        <ul
          className="sessions-list__items"
          aria-label={t('shell.sessions.listLabel')}
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {rows.map((row) => {
            // AGENTS.md §2/§4: chip tone resolves strictly from canonical
            // `auth_assurance_level` lookup_values.metadata.tone — no
            // FE fallback. Missing canonical row renders the AAL value with
            // a danger-toned chip so the gap is visible.
            const aalRow = lookupRow('session_aal', row.aal ?? '');
            const aalTone: ChipKind = (aalRow?.tone as ChipKind | undefined) ?? 'danger';
            const aalLabel = aalRow ? <bdi>{row.aal!.toUpperCase()}</bdi> : fill(t('shell.sessions.aalMissing'), { aal: (row.aal ?? 'aal?').toUpperCase() });
            const isPending = pendingId === row.id;
            const revocationStatus = revocationStatusOf(row);
            const isRevokeFormOpen = revokeFormId === row.id;
            const revokeBlocked = ['pending', 'processing', 'completed'].includes(revocationStatus);
            const revocationTone: ChipKind =
              revocationStatus === 'completed'
                ? 'danger'
                : revocationStatus === 'failed'
                  ? 'warn'
                  : revocationStatus
                    ? 'info'
                    : 'neutral';
            return (
              <li
                key={row.id}
                className="sessions-list__item"
                data-testid={`sessions-list-item-${row.id}`}
                data-current={row.is_current ? 'true' : undefined}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 8,
                  padding: '10px 4px',
                  borderTop: '1px solid var(--border-2, var(--border))',
                  alignItems: 'start',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Chip label={aalLabel} kind={aalTone} />
                    {row.is_current ? (
                      <Chip label={t('shell.sessions.current')} kind="info" />
                    ) : null}
                    {revocationStatus ? (
                      <Chip label={fill(t('shell.sessions.revokeChip'), { status: revocationStatusLabel(revocationStatus, t) })} kind={revocationTone} />
                    ) : null}
                    {row.user_email ? (
                      <span
                        className="mono"
                        style={{ fontSize: 12, color: 'var(--ink-2)' }}
                      >
                        {row.user_email}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="sessions-list__agent"
                    style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}
                  >
                    {shortenAgent(row.user_agent ?? undefined, t)}
                  </div>
                  <div
                    className="sessions-list__meta mono"
                    style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}
                  >
                    {fill(t('shell.sessions.seen'), { ip: row.ip ?? '—', when: formatRelativeMinutes(row.updated_at ?? undefined, t) })}
                  </div>
                  {revocationStatus ? (
                    <div
                      className="sessions-list__revocation"
                      data-testid={`sessions-list-revocation-${row.id}`}
                      style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 4 }}
                    >
                      {formatRevocation(row, t)}
                    </div>
                  ) : null}
                  {isRevokeFormOpen && !revokeBlocked ? (
                    <div
                      data-testid={`sessions-list-revoke-form-${row.id}`}
                      style={{ display: 'grid', gap: 8, marginTop: 8, maxWidth: 420 }}
                    >
                      <label className="field__label" htmlFor={`session-revoke-reason-${row.id}`}>
                        {t('shell.revokeReason')}
                      </label>
                      <input
                        id={`session-revoke-reason-${row.id}`}
                        value={revokeReason}
                        onChange={(event) => setRevokeReason(event.target.value)}
                        placeholder={t('shell.sessions.reasonPlaceholder')}
                      />
                      {!revokeReasonValid ? (
                        <div
                          className="state__hint"
                          data-testid={`sessions-list-revoke-reason-required-${row.id}`}
                          style={{ fontSize: 11.5 }}
                        >
                          {t('shell.sessions.reasonRequired')}
                        </div>
                      ) : null}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Button
                          label={t('common.cancel')}
                          kind="ghost"
                          size="sm"
                          onClick={() => {
                            setRevokeFormId(null);
                            setRevokeReason('');
                          }}
                        />
                        <Button
                          label={isPending ? t('shell.revoking') : t('shell.confirmRevoke')}
                          kind="danger"
                          size="sm"
                          disabled={isPending || revoke.isPending || !revokeReasonValid}
                          onClick={() => handleRevoke(row)}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {canManage && !revokeBlocked ? (
                    <Button
                      label={isPending ? t('shell.revoking') : t('shell.revoke')}
                      kind="danger"
                      size="sm"
                      onClick={() => {
                        setRevokeFormId(row.id);
                        setRevokeReason('');
                      }}
                      ariaLabel={fill(t('shell.sessions.revokeLabel'), { id: row.id })}
                      disabled={isPending || revoke.isPending}
                    />
                  ) : canManage ? (
                    <Button
                      label={revocationStatus === 'completed' ? t('shell.revoked') : t('shell.revokePending')}
                      kind="ghost"
                      size="sm"
                      disabled
                    />
                  ) : (
                    <CapabilityLock capability={writeCapability} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
