import { useState } from 'react';
import { Button } from './Button';
import { Chip } from './Chip';
import { useResourceList } from '@/lib/queries';
import * as api from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import type { ScopeType } from '@/types/domain';

export interface SettingsScopeTypeRegistryRow {
  id: string;
  scope_type: string;
  description?: string;
  ladder_rank: number;
  is_enabled?: boolean;
}

interface LookupRow {
  value: string;
  label: string;
  tone?: string;
}

export interface SettingsChangePreviewResult {
  diff: { from: unknown; to: unknown };
  blast_radius: string;
  approval_required: boolean;
  settings_resolution_id: string;
  dry_run: boolean;
  justification: string | null;
}

export interface SettingsChangeFormProps {
  category: string;
  allowedScopes: ScopeType[];
  defaultScopeType?: ScopeType;
  initialValue?: unknown;
  canAutoApply?: boolean;
  onClose: () => void;
  onSubmit: (args: {
    scopeType: ScopeType;
    value: string;
    justification: string;
    dryRun: boolean;
  }) => Promise<SettingsChangePreviewResult | undefined>;
  onApply: (args: {
    scopeType: ScopeType;
    value: string;
    justification: string;
  }) => Promise<api.ApplySettingsValueResult | undefined>;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatSettingsLabel(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return 'Not configured';
  return normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function DiffPreview({ from, to }: { from: unknown; to: unknown }) {
  const renderJson = (value: unknown) => {
    if (value == null || value === 'previous') return '-- previous --';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
      <div className="card" style={{ padding: '8px', borderColor: 'var(--line)' }}>
        <div className="eyebrow" style={{ fontSize: '10.5px' }}>Previous</div>
        <pre className="mono" style={{ margin: 0, fontSize: '11px', whiteSpace: 'pre-wrap' }}>{renderJson(from)}</pre>
      </div>
      <div className="card" style={{ padding: '8px', borderColor: 'var(--accent-soft)', background: 'var(--accent-soft)' }}>
        <div className="eyebrow" style={{ fontSize: '10.5px' }}>Proposed</div>
        <pre className="mono" style={{ margin: 0, fontSize: '11px', whiteSpace: 'pre-wrap' }}>{renderJson(to)}</pre>
      </div>
    </div>
  );
}

export function SettingsChangeForm({
  category,
  allowedScopes,
  defaultScopeType,
  initialValue,
  canAutoApply,
  onClose,
  onSubmit,
  onApply,
}: SettingsChangeFormProps) {
  const scopeTypes = (api.getLookups('scope_type') as LookupRow[] | undefined) || [];
  const scopeRegistryQuery = useResourceList<SettingsScopeTypeRegistryRow>('scope_type_registry');
  const scopeLabelByType = (scopeRegistryQuery.data?.rows ?? []).reduce<Record<string, string>>((acc, row) => {
    acc[row.scope_type] = row.scope_type.charAt(0).toUpperCase() + row.scope_type.slice(1);
    return acc;
  }, {});
  const filtered = scopeTypes.filter((scope) => (allowedScopes as string[]).includes(scope.value)).length
    ? scopeTypes.filter((scope) => (allowedScopes as string[]).includes(scope.value))
    : (allowedScopes as string[]).map((scope) => ({
        value: scope,
        label: scopeLabelByType[scope] ?? scope.charAt(0).toUpperCase() + scope.slice(1),
      }));

  const initialScopeType: ScopeType =
    defaultScopeType && filtered.some((scope) => scope.value === defaultScopeType)
      ? defaultScopeType
      : ((filtered[0]?.value as ScopeType | undefined) ?? 'tenant');
  const [scopeType, setScopeType] = useState<ScopeType>(initialScopeType);
  const [value, setValue] = useState(() => safeJsonStringify(initialValue ?? ''));
  const [justification, setJustification] = useState('');
  const [preview, setPreview] = useState<SettingsChangePreviewResult | null>(null);
  const [submitError, setSubmitError] = useState('');

  const runPreview = async () => {
    setSubmitError('');
    try {
      const result = await onSubmit({ scopeType, value, justification, dryRun: true });
      if (result) {
        setPreview(result);
        return;
      }
      setSubmitError('Settings change was not submitted. Review the policy error and try again.');
    } catch (err) {
      setSubmitError((err as Error).message || 'Settings change was not submitted.');
    }
  };

  const runSubmit = async () => {
    setSubmitError('');
    try {
      const result = canAutoApply
        ? await onApply({ scopeType, value, justification })
        : await onSubmit({ scopeType, value, justification, dryRun: false });
      if (result) return;
      setSubmitError('Settings change was not submitted. Review the policy error and try again.');
    } catch (err) {
      setSubmitError((err as Error).message || 'Settings change was not submitted.');
    }
  };

  return (
    <div data-testid="change-request-form">
      <p className="state__hint">
        {canAutoApply
          ? 'Saves approved categories immediately. Changes that need approval stay in the review queue.'
          : 'Sends the change for review. Approval-required categories stay in the review queue with the expected impact.'}
      </p>
      <div className="field">
        <label className="field__label">Scope (allowed by this category)</label>
        <select className="field" value={scopeType} onChange={(event) => setScopeType(event.target.value as ScopeType)}>
          {filtered.map((scope) => (
            <option key={scope.value} value={scope.value}>
              {scope.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label">Proposed settings</label>
        <textarea
          rows={4}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', width: '100%' }}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label">Reason for this change</label>
        <input
          type="text"
          placeholder="Required by Exampleparcel KSA contract amendment"
          value={justification}
          onChange={(event) => setJustification(event.target.value)}
        />
      </div>

      {preview ? (
        <div style={{ marginTop: '10px' }}>
          <div className="eyebrow">Impact preview</div>
          <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
            <Chip label={`Estimated impact - ${formatSettingsLabel(preview.blast_radius)}`} kind="warn" size="xs" />
            <Chip
              label={preview.approval_required ? 'Approval needed' : 'Ready to apply'}
              kind={preview.approval_required ? 'warn' : 'good'}
              size="xs"
            />
            <Chip label="Settings checked" kind="info" size="xs" />
            {preview.justification ? (
              <Chip label={`Reason - ${preview.justification.slice(0, 32)}`} size="xs" />
            ) : null}
          </div>
          <div style={{ marginTop: '8px' }}>
            <DiffPreview from={preview.diff.from} to={preview.diff.to} />
          </div>
        </div>
      ) : null}
      {submitError ? (
        <div role="alert" className="state__hint" style={{ color: 'var(--danger)', marginTop: '10px' }}>
          {submitError}
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
        <Button label="Cancel" kind="ghost" onClick={onClose} />
        <Button
          label="Preview impact"
          iconName="search"
          kind="primary"
          anyCapabilities={[CAP.SETTINGS_WRITE, CAP.SYSTEM_WRITE]}
          onClick={runPreview}
        />
        <Button
          label={canAutoApply ? 'Apply active' : 'Submit request'}
          iconName="check"
          kind="primary"
          anyCapabilities={[CAP.SETTINGS_WRITE, CAP.SYSTEM_WRITE]}
          onClick={runSubmit}
        />
      </div>
      <p className="state__hint" style={{ marginTop: '8px' }}>
        {`Category - ${category}`}
      </p>
    </div>
  );
}
