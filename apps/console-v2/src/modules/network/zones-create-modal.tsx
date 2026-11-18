// zones-create-modal.tsx — CLAIM-NETWORK-ZONES.
// Extracted out of zones.tsx so the entry chunk stays under the 16 KB raw
// budget; this modal only mounts when "New zone" is clicked.
//
// Phase C2 wires the Submit button through the canonical `zone_create_v1` RPC
// adapter (lib/queries → useCreateZone). Backend RPC is currently pending; the
// adapter routes through phaseC6Rpc so the swap is environment-only.

import { useState, type ReactNode } from 'react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { useCreateZone, useResolveSettings } from '@/lib/queries';
import { CAP } from '@/lib/capabilities';
import { getLookups } from '@/lib/api';
import { pushToast } from '@/components/toastStore';

// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §11. Canonical
// `public.canonical_districts` (id, organization_id, city_id,
// name_canonical, name_arabic, ...). FE row uses display aliases:
//   city_code → resolved via city_id → canonical_cities.name_canonical
//   name      → canonical: name_canonical
interface CanonicalDistrictRow extends Record<string, unknown> {
  id: string;                    // → canonical_districts.id
  /** Resolved via city_id → canonical_cities.name_canonical. Not a column. */
  city_code?: string;
  city_label?: string;
  city_id?: string;
  city_name?: string;
  name_canonical?: string;
  name_arabic?: string;
  name_ar?: string;
  /** FE alias for canonical name_canonical. */
  name?: string;
}

interface BranchCoverageChoiceRow extends Record<string, unknown> {
  id: string;
  name?: string | null;
  code?: string | null;
  slug?: string | null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function zoneDistrictDisplayName(district: CanonicalDistrictRow): string {
  return (
    firstString(
      district.name_canonical,
      district.name,
      district.name_arabic,
      district.name_ar,
      district.id,
    ) ?? district.id
  );
}

export function zoneDistrictCityLabel(district: CanonicalDistrictRow): string | null {
  return firstString(district.city_label, district.city_code, district.city_name);
}

function branchCoverageChoiceLabel(branch: BranchCoverageChoiceRow): string {
  const name = firstString(branch.name, branch.code, branch.slug, branch.id) ?? branch.id;
  const code = firstString(branch.code, branch.slug);
  return code && code !== name ? `${name} (${code})` : name;
}

// W52 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
// color tokens resolve strictly from canonical `zone_color_token` lookup
// rows (apps/console-v2/src/lib/seed-raw/lookups.js, seeded by W24b).
// Each row carries (value, label, tone) — the modal shows the swatch via
// the canonical `tone` (semantic CSS var --good/--info/...) and submits
// the canonical `value` ('sky'/'emerald'/...) to `zone_create_v1`.
// NO inline COLOR_TOKENS array; missing canonical lookup renders a
// danger StateView so the gap is visible to operators.

export interface ZonesCreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (zoneId: string, context?: { branchId?: string }) => void | Promise<void>;
  tenantId?: string;
  canonicalDistricts: CanonicalDistrictRow[];
  branchChoices?: BranchCoverageChoiceRow[];
}

export function ZonesCreateModal({
  open,
  onClose,
  onCreated,
  tenantId,
  canonicalDistricts,
  branchChoices = [],
}: ZonesCreateModalProps) {
  const colorTokens = getLookups('zone_color_token') ?? [];
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(colorTokens[0]?.value ?? '');
  const [districts, setDistricts] = useState<Set<string>>(new Set());
  const [branchId, setBranchId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const createZoneMut = useCreateZone();

  // W73-Network Cycle F-R-13 closure (P2-4): post-success modal close cadence
  // resolves through canonical `ux_safety_policy.modal_close_after_success_ms`
  // (apps/console-v2/src/lib/seed-raw/policies.js#sv_110). AGENTS.md §2 + §6.
  // Strict no-fallback: when the policy value is missing the modal stays
  // open so the operator manually closes — the gap is observable, not masked.
  const uxSafetyPolicy = useResolveSettings('ux_safety_policy', undefined);
  const modalCloseAfterSuccessMs = (
    uxSafetyPolicy.data?.value as { modal_close_after_success_ms?: number } | undefined
  )?.modal_close_after_success_ms;

  function reset() {
    setName('');
    setColor(colorTokens[0]?.value ?? '');
    setDistricts(new Set());
    setBranchId('');
    setNotice(null);
  }

  function handleClose() {
    onClose();
    reset();
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNotice('Zone name is required.');
      return;
    }
    createZoneMut
      .mutateAsync({
        name: trimmed,
        color_token: color,
        ...(tenantId ? { organization_id: tenantId } : {}),
        initial_district_ids: [...districts],
      })
      .then(async (res) => {
        const zoneId = (res as { zone_id?: string }).zone_id ?? '';
        pushToast(`Created zone "${trimmed}" with ${districts.size} districts.`, 'good');
        if (zoneId && onCreated) {
          await onCreated(zoneId, branchId ? { branchId } : undefined);
          return;
        }
        setNotice(zoneId ? `Created zone ${zoneId}.` : 'Created.');
        // W73-Network Cycle F-R-13 closure (P2-4): close-after-success
        // cadence resolves through canonical
        // `ux_safety_policy.modal_close_after_success_ms`. AGENTS.md §2
        // (ZERO HARDCODING) + §6 (row-driven by configuration). When the
        // policy value is missing the modal does NOT auto-close (operator
        // must close manually) — strict no-fallback per W73 contract.
        if (typeof modalCloseAfterSuccessMs === 'number') {
          setTimeout(() => handleClose(), modalCloseAfterSuccessMs);
        }
      })
      .catch(() => {
        pushToast('Create zone failed — see audit log.', 'danger');
        setNotice('Create zone failed.');
      });
  }

  const footer: ReactNode = (
    <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
      <Button label="Cancel" kind="ghost" onClick={handleClose} />
      <Button label="Submit" kind="primary" capability={CAP.ZONES_WRITE} onClick={submit} />
    </div>
  );

  return (
    <Modal open={open} title="Create zone" onClose={handleClose} footer={footer}>
      <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <label style={{ display: 'block' }}>
          <div className="state__hint" style={{ fontSize: '11px', marginBottom: '4px' }}>
            Zone name
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Riyadh East"
            aria-label="New zone name"
            style={{
              width: '100%',
              padding: '6px 8px',
              fontFamily: 'inherit',
              fontSize: '13px',
              borderRadius: '4px',
              border: '1px solid var(--ink-3, rgba(0,0,0,0.2))',
              background: 'var(--surface-1, transparent)',
              color: 'inherit',
            }}
          />
        </label>

        <div>
          <div className="state__hint" style={{ fontSize: '11px', marginBottom: '4px' }}>
            Color token
          </div>
          {colorTokens.length === 0 ? (
            <StateView
              kind="error"
              title="Zone color options are not available"
              hint="Color options must be configured before a zone can be created."
            />
          ) : (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {colorTokens.map((c) => {
                // W27 Cycle D Network closure (P3 #12): tone is loud-
                // missing rather than silently substituting `'neutral'`.
                // When a canonical color-token row lacks a tone, render
                // the swatch with `(no tone)` label so the gap is
                // visible to operators rather than masked by a fallback.
                const hasTone = typeof c.tone === 'string' && c.tone.length > 0;
                const tone = hasTone ? c.tone : null;
                const swatchVar = tone == null || tone === 'neutral' ? 'ink-3' : tone;
                const labelText = hasTone ? c.label : `${c.label} (no tone)`;
                return (
                  <button
                    key={c.value}
                    type="button"
                    aria-pressed={color === c.value}
                    className={'btn btn--ghost btn--sm' + (color === c.value ? ' is-active' : '')}
                    onClick={() => setColor(c.value)}
                    style={{ borderColor: color === c.value ? 'var(--ink-1)' : 'transparent' }}
                    title={hasTone ? undefined : 'Canonical row has no tone — operator-visible gap.'}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        marginRight: 4,
                        background: `oklch(from var(--${swatchVar}) l c h / 0.6)`,
                      }}
                    />
                    {labelText}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <label style={{ display: 'block' }}>
          <div className="state__hint" style={{ fontSize: '11px', marginBottom: '4px' }}>
            Initial branch coverage
          </div>
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            aria-label="Initial branch coverage"
            style={{
              width: '100%',
              padding: '6px 8px',
              fontFamily: 'inherit',
              fontSize: '13px',
              borderRadius: '4px',
              border: '1px solid var(--ink-3, rgba(0,0,0,0.2))',
              background: 'var(--surface-1, transparent)',
              color: 'inherit',
            }}
          >
            <option value="">No branch coverage yet</option>
            {branchChoices.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branchCoverageChoiceLabel(branch)}
              </option>
            ))}
          </select>
        </label>

        <div>
          <div className="state__hint" style={{ fontSize: '11px', marginBottom: '4px' }}>
            Initial districts ({districts.size} selected)
          </div>
          <div
            style={{
              display: 'flex',
              gap: '6px',
              flexWrap: 'wrap',
              maxHeight: 180,
              overflowY: 'auto',
              padding: '4px 0',
            }}
          >
            {canonicalDistricts.map((d) => {
              const checked = districts.has(d.id);
              const displayName = zoneDistrictDisplayName(d);
              const cityLabel = zoneDistrictCityLabel(d);
              const districtActionLabel = cityLabel
                ? `Toggle district ${displayName} (${cityLabel})`
                : `Toggle district ${displayName}`;
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-label={districtActionLabel}
                  aria-pressed={checked}
                  title={districtActionLabel}
                  onClick={() =>
                    setDistricts((prev) => {
                      const next = new Set(prev);
                      if (next.has(d.id)) next.delete(d.id);
                      else next.add(d.id);
                      return next;
                    })
                  }
                  className="btn btn--ghost btn--sm"
                  style={{ borderColor: checked ? 'var(--good)' : 'transparent' }}
                >
                  {displayName}
                  {cityLabel ? (
                    <span className="state__hint mono" style={{ fontSize: '10px', marginLeft: 4 }}>
                      {cityLabel}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {notice ? (
          <p
            role="status"
            className="state__hint"
            style={{
              fontSize: '12px',
              padding: '6px 10px',
              background: 'oklch(from var(--info) l c h / 0.12)',
              borderLeft: '3px solid var(--info)',
            }}
          >
            {notice}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export default ZonesCreateModal;
