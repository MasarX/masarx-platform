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

function platformOf(row: UserDeviceRow): string {
  return String(row.platform ?? row.device_platform ?? 'Unknown platform');
}

function modelOf(row: UserDeviceRow): string {
  return row.model?.trim() || metadataString(row, 'model') || 'Unknown model';
}

function attestationStatusOf(row: UserDeviceRow): string {
  return (
    row.attestation_status?.trim() ||
    nestedMetadataString(row, 'attestation', 'status') ||
    'missing'
  ).toLowerCase();
}

function formatSeen(ts: string | null | undefined): string {
  if (!ts) return 'Never seen';
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return 'Last seen unknown';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return 'Seen just now';
  if (minutes < 60) return `Seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Seen ${hours} h ago`;
  return `Seen ${Math.round(hours / 24)} d ago`;
}

function formatRevokedAt(ts: string | null | undefined): string {
  if (!ts) return 'Revoked timestamp unavailable';
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return 'Revoked timestamp unavailable';
  return `Revoked ${new Date(parsed).toLocaleString()}`;
}

function isRevoked(row: UserDeviceRow): boolean {
  return row.is_revoked === true || Boolean(row.revoked_at);
}

export function UserDevicesList({
  userId,
  title = 'User devices',
  hideTitle = false,
  className,
  readCapability = CAP.USER_DEVICES_READ,
  writeCapability = CAP.USER_DEVICES_WRITE,
}: UserDevicesListProps) {
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
      pushToast('Device revocation reason required', 'warn');
      return;
    }
    try {
      await revokeDevice.mutateAsync({ deviceId: deviceRecordId, revokedReason: trimmed });
      pushToast(`Device revoked - ${deviceId}`, 'good');
      setRevokeId(null);
      setReason('');
    } catch (err) {
      pushToast(`Device revoke failed - ${(err as Error)?.message || 'unknown error'}`, 'danger');
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
          title="Device activity unavailable"
          hint={(devices.error as Error | undefined)?.message ?? 'The user device registry could not be read.'}
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
          title="No registered devices"
          hint="This user has no registered device activity in the current tenant scope."
        />
      ) : (
        <ul
          className="user-devices-list__items"
          aria-label="User devices"
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
                    <Chip label={attestation} kind={tone} />
                    {revoked ? <Chip label="revoked" kind="danger" /> : null}
                    <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                      {deviceId}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
                    {`${platformOf(row)} - ${modelOf(row)}`}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                    {`${row.app_version ?? 'App unknown'} - ${row.os_version ?? 'OS unknown'} - ${formatSeen(row.last_seen_at)}`}
                  </div>
                  {revoked ? (
                    <div
                      data-testid={`user-devices-revoked-state-${row.id}`}
                      style={{ display: 'grid', gap: 2, marginTop: 8, fontSize: 12, color: 'var(--ink-2)' }}
                    >
                      <span>{formatRevokedAt(row.revoked_at)}</span>
                      <span>{`Reason: ${row.revoked_reason ?? 'No reason provided'}`}</span>
                      {row.push_token_cleared ? <span>Push token cleared</span> : null}
                    </div>
                  ) : null}
                  {isRevoking && !revoked ? (
                    <div
                      data-testid={`user-devices-revoke-form-${row.id}`}
                      style={{ display: 'grid', gap: 8, marginTop: 8, maxWidth: 420 }}
                    >
                      <label className="field__label" htmlFor={`device-revoke-reason-${row.id}`}>
                        Revocation reason
                      </label>
                      <input
                        id={`device-revoke-reason-${row.id}`}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="Lost phone, replaced device, or security review"
                      />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Button
                          label="Cancel"
                          size="sm"
                          kind="ghost"
                          onClick={() => {
                            setRevokeId(null);
                            setReason('');
                          }}
                        />
                        <Button
                          label={revokeDevice.isPending ? 'Revoking...' : 'Confirm revoke'}
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
                      label="Revoked"
                      kind="ghost"
                      size="sm"
                      capability={writeCapability}
                      disabled
                    />
                  ) : canManage ? (
                    <Button
                      label="Revoke"
                      kind="danger"
                      size="sm"
                      capability={writeCapability}
                      ariaLabel={`Revoke device ${deviceId}`}
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
