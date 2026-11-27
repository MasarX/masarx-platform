import { useMemo, useState, type ReactNode } from 'react';
import { useResourceList, useRevokeDevice } from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { lookupRow } from '@/lib/api';
import { Button } from './Button';
import { Chip, type ChipKind } from './Chip';
import { StateView } from './StateView';
import { CapabilityLock } from './CapabilityLock';
import { pushToast } from './toastStore';
import { fill, useT } from '@/lib/i18n';

type Translate = ReturnType<typeof useT>;

export interface UserDeviceRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  user_id: string;
  device_id?: string | null;
  device_identifier_sha256?: string | null;
  device_label?: string | null;
  platform?: string | null;
  device_platform?: string | null;
  model?: string | null;
  os_version?: string | null;
  app_version?: string | null;
  last_seen_at?: string | null;
  revoked_at?: string | null;
  revoked_by_user_id?: string | null;
  revoked_reason?: string | null;
  is_revoked?: boolean | null;
  push_token_cleared?: boolean | null;
  attestation_status?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UserDevicesListProps {
  userId?: string | null;
  title?: ReactNode;
  hideTitle?: boolean;
  className?: string;
  readCapability?: string;
  writeCapability?: string;
}

function metadataString(row: UserDeviceRow, key: string): string | undefined {
  const value = row.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nestedMetadataString(row: UserDeviceRow, parent: string, key: string): string | undefined {
  const value = row.metadata?.[parent];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === 'string' && nested.trim() ? nested : undefined;
}

function deviceIdOf(row: UserDeviceRow): string {
  return String(row.device_id ?? row.device_identifier_sha256 ?? row.id);
}

function platformOf(row: UserDeviceRow, t: Translate): string {
  return String(row.platform ?? row.device_platform ?? t('shell.devices.unknownPlatform'));
}

function modelOf(row: UserDeviceRow, t: Translate): string {
  return row.model?.trim() || metadataString(row, 'model') || t('shell.devices.unknownModel');
}

function attestationStatusOf(row: UserDeviceRow): string {
  return (
    row.attestation_status?.trim() ||
    nestedMetadataString(row, 'attestation', 'status') ||
    'missing'
  ).toLowerCase();
}

function formatSeen(ts: string | null | undefined, t: Translate): string {
  if (!ts) return t('shell.devices.neverSeen');
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return t('shell.devices.seenUnknown');
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return t('shell.devices.seenJustNow');
  if (minutes < 60) return fill(t('shell.devices.seenMinutes'), { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fill(t('shell.devices.seenHours'), { n: hours });
  return fill(t('shell.devices.seenDays'), { n: Math.round(hours / 24) });
}

function formatRevokedAt(ts: string | null | undefined, t: Translate): string {
  if (!ts) return t('shell.devices.revokedUnknown');
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return t('shell.devices.revokedUnknown');
  return fill(t('shell.devices.revokedAt'), { time: new Date(parsed).toLocaleString() });
}

function isRevoked(row: UserDeviceRow): boolean {
  return row.is_revoked === true || Boolean(row.revoked_at);
}

export function UserDevicesList({
  userId,
  title: titleProp,
  hideTitle = false,
  className,
  readCapability = CAP.USER_DEVICES_READ,
  writeCapability = CAP.USER_DEVICES_WRITE,
}: UserDevicesListProps) {
  const t = useT();
  const title = titleProp ?? t('shell.devices.title');
  const canRead = useCapability(readCapability);
  const canManage = useCapability(writeCapability);
  const devices = useResourceList<UserDeviceRow>(
    'user_device_summary',
    userId ? { filter: { user_id: userId } } : undefined,
    { enabled: canRead },
  );
  const revokeDevice = useRevokeDevice();
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const rows = useMemo(() => devices.data?.rows ?? [], [devices.data?.rows]);
  const classes = ['user-devices-list', className].filter(Boolean).join(' ');

  async function confirmRevoke(row: UserDeviceRow) {
    const deviceRecordId = row.id;
    const deviceId = deviceIdOf(row);
    const trimmed = reason.trim();
    if (!trimmed) {
      pushToast(t('shell.devices.reasonRequiredToast'), 'warn');
      return;
    }
    try {
      await revokeDevice.mutateAsync({ deviceId: deviceRecordId, revokedReason: trimmed });
      pushToast(fill(t('shell.devices.revoked'), { id: deviceId }), 'good');
      setRevokeId(null);
      setReason('');
    } catch (err) {
      pushToast(fill(t('shell.devices.revokeFailed'), { reason: (err as Error)?.message || t('shell.unknownError') }), 'danger');
    }
  }

  if (!canRead) {
    return (
      <section className={classes} data-testid="user-devices-list">
        {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
        <StateView kind="denied" capability={readCapability} />
      </section>
    );
  }

  if (devices.isLoading) {
    return (
      <section className={classes} data-testid="user-devices-list">
        {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
        <StateView kind="loading" />
      </section>
    );
  }

  if (devices.isError) {
    return (
      <section className={classes} data-testid="user-devices-list">
        {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
        <StateView
          kind="error"
          title={t('shell.devices.loadFailed')}
          hint={(devices.error as Error | undefined)?.message ?? t('shell.devices.loadFailedHint')}
        />
      </section>
    );
  }

  return (
    <section className={classes} data-testid="user-devices-list">
      {hideTitle ? null : <div className="section-eyebrow">{title}</div>}
      {rows.length === 0 ? (
        <StateView
          kind="empty"
          title={t('shell.devices.empty')}
          hint={t('shell.devices.emptyHint')}
        />
      ) : (
        <ul
          className="user-devices-list__items"
          aria-label={t('shell.devices.listLabel')}
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {rows.map((row) => {
            const deviceId = deviceIdOf(row);
            const attestation = attestationStatusOf(row);
            const attestationLookup = lookupRow('mobile_attestation_status', attestation);
            const tone: ChipKind = (attestationLookup?.tone as ChipKind | undefined) ?? 'warn';
            const isRevoking = revokeId === row.id;
            const revoked = isRevoked(row);
            return (
              <li
                key={row.id}
                data-testid={`user-devices-list-item-${row.id}`}
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
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip label={<bdi>{attestation}</bdi>} kind={tone} />
                    {revoked ? <Chip label={t('shell.devices.revokedChip')} kind="danger" /> : null}
                    <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                      {deviceId}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
                    <bdi>{platformOf(row, t)}</bdi> - <bdi>{modelOf(row, t)}</bdi>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                    {`${row.app_version ?? t('shell.devices.appUnknown')} - ${row.os_version ?? t('shell.devices.osUnknown')} - ${formatSeen(row.last_seen_at, t)}`}
                  </div>
                  {revoked ? (
                    <div
                      data-testid={`user-devices-revoked-state-${row.id}`}
                      style={{ display: 'grid', gap: 2, marginTop: 8, fontSize: 12, color: 'var(--ink-2)' }}
                    >
                      <span>{formatRevokedAt(row.revoked_at, t)}</span>
                      <span>{fill(t('shell.devices.reason'), { reason: row.revoked_reason ?? t('shell.devices.noReason') })}</span>
                      {row.push_token_cleared ? <span>{t('shell.devices.pushCleared')}</span> : null}
                    </div>
                  ) : null}
                  {isRevoking && !revoked ? (
                    <div
                      data-testid={`user-devices-revoke-form-${row.id}`}
                      style={{ display: 'grid', gap: 8, marginTop: 8, maxWidth: 420 }}
                    >
                      <label className="field__label" htmlFor={`device-revoke-reason-${row.id}`}>
                        {t('shell.revokeReason')}
                      </label>
                      <input
                        id={`device-revoke-reason-${row.id}`}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder={t('shell.devices.reasonPlaceholder')}
                      />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Button
                          label={t('common.cancel')}
                          size="sm"
                          kind="ghost"
                          onClick={() => {
                            setRevokeId(null);
                            setReason('');
                          }}
                        />
                        <Button
                          label={revokeDevice.isPending ? t('shell.revoking') : t('shell.confirmRevoke')}
                          size="sm"
                          kind="danger"
                          capability={writeCapability}
                          disabled={revokeDevice.isPending}
                          onClick={() => void confirmRevoke(row)}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {revoked ? (
                    <Button
                      label={t('shell.revoked')}
                      kind="ghost"
                      size="sm"
                      capability={writeCapability}
                      disabled
                    />
                  ) : canManage ? (
                    <Button
                      label={t('shell.revoke')}
                      kind="danger"
                      size="sm"
                      capability={writeCapability}
                      ariaLabel={fill(t('shell.devices.revokeLabel'), { id: deviceId })}
                      disabled={revokeDevice.isPending}
                      onClick={() => {
                        setRevokeId(row.id);
                        setReason('');
                      }}
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
