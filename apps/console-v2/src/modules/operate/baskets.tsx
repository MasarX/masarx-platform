// baskets.tsx - dedicated Console V2 basket operations surface.
//
// Canonical backend substrate:
//   - public.baskets
//   - public.basket_items
//   - public.basket_transitions
//   - public.ui_update_basket_state_v1(p_args jsonb)

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { KPICard } from '@/components/KPICard';
import { DataTable, type DataTableColumn, type DataTableAction } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  useCreateBasket,
  useProposeSettingsChange,
  useResolveSettings,
  useResource,
  useResourceList,
  useResourceRowsByIds,
  useResortShipment,
  useUpdateBasket,
  useUpdateBasketState,
} from '@/lib/queries';
import { getLookups, lookupRow } from '@/lib/api';
import { pushToast } from '@/components/toastStore';
import { englishT, fill, useI18n, type Translate } from '@/lib/i18n';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';

interface BasketRow extends Record<string, unknown> {
  id: string;
  organization_id?: string;
  zone_id?: string | null;
  basket_type?: string | null;
  state: string;
  current_count?: number | null;
  capacity_count?: number | null;
  expires_at?: string | null;
  version?: number | null;
  created_at?: string;
  updated_at?: string;
}

interface BasketItemRow extends Record<string, unknown> {
  id: string;
  basket_id: string;
  shipment_id: string;
  shipment_client_id: string;
  added_at: string;
  removed_at?: string | null;
}

interface BasketTransitionRow extends Record<string, unknown> {
  id: string;
  basket_id: string;
  previous_state?: string | null;
  new_state: string;
  changed_at: string;
  changed_by?: string | null;
  notes?: string | null;
}

interface ZoneRow extends Record<string, unknown> {
  id: string;
  name?: string;
  slug?: string;
}

interface ShipmentRow extends Record<string, unknown> {
  id: string;
  tracking_number?: string;
  client_reference_number?: string;
}

type BasketLegacyFocusResource = 'basket_items' | 'basket_transitions';

function legacyBasketFocusResource(raw: string | null): BasketLegacyFocusResource | null {
  return raw === 'basket_items' || raw === 'basket_transitions' ? raw : null;
}

function queryErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function transitionColumns(t: Translate): DataTableColumn<BasketTransitionRow>[] {
  return [
    { key: 'previous_state', label: t('baskets.fields.from'), lookup: 'basket_state', filterable: true },
    { key: 'new_state', label: t('baskets.fields.to'), lookup: 'basket_state', filterable: true },
    { key: 'changed_at', label: t('baskets.fields.changed'), format: 'datetime', sortable: true },
    {
      key: 'changed_by',
      label: t('baskets.fields.changedBy'),
      render: (raw) => (raw ? <span>{t('baskets.values.operator')}</span> : <span>{t('baskets.values.system')}</span>),
    },
    { key: 'notes', label: t('baskets.fields.notes') },
  ];
}

function stateMeta(state: string | null | undefined): Record<string, unknown> {
  return lookupRow('basket_state', state ?? '')?.metadata ?? {};
}

function stateTone(state: string | null | undefined): ChipKind {
  const tone = lookupRow('basket_state', state ?? '')?.tone;
  return (tone as ChipKind | undefined) ?? 'neutral';
}

function stateLabel(state: string | null | undefined): string {
  return lookupRow('basket_state', state ?? '')?.label ?? String(state ?? '-');
}

function basketTypeLabel(type: string | null | undefined): string {
  return lookupRow('basket_type', type ?? '')?.label ?? String(type ?? '-');
}

function nextStatesFor(row: BasketRow): string[] {
  const fromMetadata = stateMeta(row.state).next_states;
  if (Array.isArray(fromMetadata)) {
    return fromMetadata.map(String).filter((value) => value && value !== row.state);
  }
  return getLookups('basket_state')
    .map((entry) => String(entry.value))
    .filter((value) => value && value !== row.state);
}

function capacityText(row: BasketRow, t: Translate = englishT): string {
  const current = Number(row.current_count ?? 0);
  const capacity = row.capacity_count == null ? null : Number(row.capacity_count);
  return capacity == null ? fill(t('baskets.values.openLoad'), { current }) : `${current}/${capacity}`;
}

function basketDisplayLabel(row: BasketRow, zone?: ZoneRow | null, t: Translate = englishT): string {
  const zoneLabel = zone?.name ?? t('baskets.values.unzoned');
  return `${basketTypeLabel(row.basket_type)} - ${zoneLabel} - ${capacityText(row, t)}`;
}

function zoneOptionLabel(zone: ZoneRow, t: Translate = englishT): string {
  return zone.name ?? zone.slug ?? t('baskets.values.unnamedZone');
}

// A missing or unparsable value shows '-' rather than the epoch; `format` is the app-locale formatter.
function formatBasketDateTime(value: unknown, format: (iso: string) => string): string {
  if (typeof value !== 'string' || !value.trim()) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return format(value);
}

function shipmentDisplayLabel(row: ShipmentRow | undefined, fallback: string): string {
  return row?.tracking_number ?? row?.client_reference_number ?? fallback;
}

function booleanSetting(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function textSetting(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pathSettingText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join('|');
  return textSetting(value);
}

function numberSettingText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function csvSettingText(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : '';
}

function parseCsvSetting(value: string): string[] | null {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function operatorLabelForSettingValue(value: string): string {
  const lookupLabel = basketTypeLabel(value);
  if (lookupLabel && lookupLabel !== value) return lookupLabel;
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function routeSelectorValues(value: string): string[] {
  return value
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

function routeSelectorText(values: string[]): string {
  return Array.from(new Set(values)).join('|');
}

function parseOptionalPositiveInteger(label: string, value: string, t: Translate = englishT): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(fill(t('baskets.policy.positiveWhole'), { label }));
  }
  return parsed;
}

type BasketPolicySubmissionResult = {
  blast_radius: string;
  approval_required: boolean;
  settings_resolution_id: string;
  dry_run: boolean;
};

function formatPriorityBands(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((band) => {
      if (!band || typeof band !== 'object') return '';
      const record = band as Record<string, unknown>;
      return [
        textSetting(record.key),
        record.min_score == null ? '' : String(record.min_score),
        record.max_score == null ? '' : String(record.max_score),
      ].join(' | ');
    })
    .filter(Boolean)
    .join('\n');
}

function parsePriorityBands(value: string, t: Translate = englishT): Array<Record<string, number | string>> | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return lines.map((line) => {
    const [keyRaw, minRaw = '', maxRaw = ''] = line.split('|').map((part) => part.trim());
    if (!keyRaw) throw new Error(t('baskets.policy.bandNeedsLabel'));
    const band: Record<string, number | string> = { key: keyRaw };
    if (minRaw) {
      const min = Number(minRaw);
      if (!Number.isFinite(min)) throw new Error(fill(t('baskets.policy.bandMin'), { band: keyRaw }));
      band.min_score = min;
    }
    if (maxRaw) {
      const max = Number(maxRaw);
      if (!Number.isFinite(max)) throw new Error(fill(t('baskets.policy.bandMax'), { band: keyRaw }));
      band.max_score = max;
    }
    return band;
  });
}

function BasketPolicyChangeForm({
  initialValue,
  onClose,
  onSubmit,
}: {
  initialValue: Record<string, unknown>;
  onClose: () => void;
  onSubmit: (args: { value: Record<string, unknown>; dryRun: boolean }) => Promise<BasketPolicySubmissionResult>;
}) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(() => booleanSetting(initialValue.enabled));
  const [basketType, setBasketType] = useState(() => textSetting(initialValue.basket_type));
  const [openStates, setOpenStates] = useState(() => csvSettingText(initialValue.open_states));
  const [createIfMissing, setCreateIfMissing] = useState(() => booleanSetting(initialValue.create_if_missing, true));
  const [requireZone, setRequireZone] = useState(() => booleanSetting(initialValue.require_zone, true));
  const [capacity, setCapacity] = useState(() => numberSettingText(initialValue.capacity_count));
  const [expiresMinutes, setExpiresMinutes] = useState(() => numberSettingText(initialValue.expires_in_minutes));
  const [groupByBranch, setGroupByBranch] = useState(() => booleanSetting(initialValue.group_by_branch));
  const [groupByService, setGroupByService] = useState(() => booleanSetting(initialValue.group_by_service));
  const [serviceMatchField, setServiceMatchField] = useState(() => textSetting(initialValue.service_match_field));
  const [groupByRoute, setGroupByRoute] = useState(() => booleanSetting(initialValue.group_by_route));
  const [routeKeyPaths, setRouteKeyPaths] = useState(() => pathSettingText(initialValue.route_key_paths));
  const [groupByPriority, setGroupByPriority] = useState(() => booleanSetting(initialValue.group_by_priority));
  const [priorityBands, setPriorityBands] = useState(() => formatPriorityBands(initialValue.priority_bands));
  const [notice, setNotice] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<BasketPolicySubmissionResult | null>(null);
  const basketTypeOptions = getLookups('basket_type');
  const serviceMatchOptions = getLookups('basket_policy_service_match_field');
  const routeSelectorOptions = getLookups('basket_policy_route_key_path');
  const selectedRouteSelectors = routeSelectorValues(routeKeyPaths);
  const customRouteSelectorCount = selectedRouteSelectors.filter(
    (value) => !routeSelectorOptions.some((option) => String(option.value) === value),
  ).length;

  function toggleRouteSelector(value: string, checked: boolean) {
    const current = routeSelectorValues(routeKeyPaths);
    const next = checked ? [...current, value] : current.filter((item) => item !== value);
    setRouteKeyPaths(routeSelectorText(next));
  }

  async function submit(dryRun: boolean) {
    try {
      const parsed: Record<string, unknown> = {
        ...initialValue,
        version: typeof initialValue.version === 'number' ? initialValue.version : 1,
        enabled,
        basket_type: basketType.trim() || null,
        open_states: parseCsvSetting(openStates),
        create_if_missing: createIfMissing,
        require_zone: requireZone,
        capacity_count: parseOptionalPositiveInteger(t('baskets.fields.capacity'), capacity, t),
        expires_in_minutes: parseOptionalPositiveInteger(t('baskets.policy.expirationWindow'), expiresMinutes, t),
        group_by_branch: groupByBranch,
        group_by_service: groupByService,
        service_match_field: serviceMatchField || null,
        group_by_route: groupByRoute,
        route_key_paths: routeKeyPaths.trim() || null,
        group_by_priority: groupByPriority,
        priority_bands: parsePriorityBands(priorityBands, t),
      };
      const result = await onSubmit({ value: parsed, dryRun });
      setLastResult(result);
      setNotice(dryRun ? t('baskets.policy.previewDone') : t('baskets.policy.submittedNotice'));
    } catch (error) {
      setLastResult(null);
      const message = error instanceof Error ? error.message : t('baskets.policy.checkValues');
      setNotice(fill(t('baskets.policy.invalid'), { message }));
    }
  }

  return (
    <div data-testid="basket-policy-modal">
      <p className="state__hint">
        {t('baskets.policy.intro')}
      </p>
      <div className="dt-form-grid" style={{ marginTop: 10 }}>
        <label>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{' '}
          {t('baskets.policy.enable')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={createIfMissing}
            onChange={(event) => setCreateIfMissing(event.target.checked)}
          /> {t('baskets.policy.createIfMissing')}
        </label>
        <label>
          <input type="checkbox" checked={requireZone} onChange={(event) => setRequireZone(event.target.checked)} />{' '}
          {t('baskets.policy.requireZone')}
        </label>
        <label className="mono" htmlFor="basket-policy-type">{t('baskets.aria.type')}</label>
        <select
          id="basket-policy-type"
          className="dt-inline-input"
          aria-label={t('baskets.aria.type')}
          value={basketType}
          onChange={(event) => setBasketType(event.target.value)}
        >
          <option value="">{t('baskets.policy.useTenantDefault')}</option>
          {basketTypeOptions.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
          ))}
          {basketType && !basketTypeOptions.some((option) => String(option.value) === basketType) ? (
            <option value={basketType}>{operatorLabelForSettingValue(basketType)}</option>
          ) : null}
        </select>
        <label className="mono" htmlFor="basket-policy-open-states">{t('baskets.policy.openStates')}</label>
        <input
          id="basket-policy-open-states"
          className="dt-inline-input"
          aria-label={t('baskets.policy.openStates')}
          value={openStates}
          onChange={(event) => setOpenStates(event.target.value)}
          dir="ltr"
          placeholder="forming, ready" // i18n-literal-ok: example basket_state codes the operator types
        />
        <label className="mono" htmlFor="basket-policy-capacity">{t('baskets.fields.capacity')}</label>
        <input
          id="basket-policy-capacity"
          className="dt-inline-input"
          aria-label={t('baskets.fields.capacity')}
          inputMode="numeric"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
        />
        <label className="mono" htmlFor="basket-policy-expiry">{t('baskets.policy.expirationWindow')}</label>
        <input
          id="basket-policy-expiry"
          className="dt-inline-input"
          aria-label={t('baskets.policy.expirationWindow')}
          inputMode="numeric"
          value={expiresMinutes}
          onChange={(event) => setExpiresMinutes(event.target.value)}
          placeholder={t('baskets.values.minutes')}
        />
        <label>
          <input type="checkbox" checked={groupByBranch} onChange={(event) => setGroupByBranch(event.target.checked)} />{' '}
          {t('baskets.policy.groupByBranch')}
        </label>
        <label>
          <input type="checkbox" checked={groupByService} onChange={(event) => setGroupByService(event.target.checked)} />{' '}
          {t('baskets.policy.groupByService')}
        </label>
        <label className="mono" htmlFor="basket-policy-service-field">{t('baskets.policy.serviceMatch')}</label>
        <select
          id="basket-policy-service-field"
          className="dt-inline-input"
          aria-label={t('baskets.policy.serviceMatch')}
          value={serviceMatchField}
          onChange={(event) => setServiceMatchField(event.target.value)}
        >
          <option value="">{t('baskets.policy.noServiceGrouping')}</option>
          {serviceMatchOptions.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
          {serviceMatchField && !serviceMatchOptions.some((option) => String(option.value) === serviceMatchField) ? (
            <option value={serviceMatchField}>{operatorLabelForSettingValue(serviceMatchField)}</option>
          ) : null}
        </select>
        <label>
          <input type="checkbox" checked={groupByRoute} onChange={(event) => setGroupByRoute(event.target.checked)} />{' '}
          {t('baskets.policy.groupByRoute')}
        </label>
        <fieldset className="card" aria-label={t('baskets.policy.routeSelectors')} style={{ margin: 0 }}>
          <legend className="mono" style={{ padding: '0 4px' }}>{t('baskets.policy.routeSelectors')}</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {routeSelectorOptions.map((option) => (
              <label key={String(option.value)}>
                <input
                  type="checkbox"
                  checked={selectedRouteSelectors.includes(String(option.value))}
                  onChange={(event) => toggleRouteSelector(String(option.value), event.target.checked)}
                /> {option.label}
              </label>
            ))}
            {customRouteSelectorCount > 0 ? (
              <span className="state__hint">
                {fill(
                  t(customRouteSelectorCount === 1 ? 'baskets.policy.customSelectorsOne' : 'baskets.policy.customSelectorsOther'),
                  { n: customRouteSelectorCount },
                )}
              </span>
            ) : null}
          </div>
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={groupByPriority}
            onChange={(event) => setGroupByPriority(event.target.checked)}
          /> {t('baskets.policy.groupByPriority')}
        </label>
        <label className="mono" htmlFor="basket-policy-priority-bands">{t('baskets.policy.priorityBands')}</label>
        <textarea
          id="basket-policy-priority-bands"
          aria-label={t('baskets.policy.priorityBands')}
          className="dt-inline-input"
          value={priorityBands}
          onChange={(event) => setPriorityBands(event.target.value)}
          rows={3}
          dir="ltr"
          placeholder={'urgent | 80 |\nstandard | | 79.999'} // i18n-literal-ok: band key | min | max format example
          style={{ width: '100%', resize: 'vertical' }}
        />
      </div>
      {notice ? (
        <p role="status" className="state__hint" style={{ marginTop: 8 }}>
          {notice}
        </p>
      ) : null}
      {lastResult ? (
        <div className="state__hint" data-testid="basket-policy-readback" style={{ marginTop: 8 }}>
          <div>
            {t('baskets.policy.readback')}{' '}
            {lastResult.settings_resolution_id ? (
              <bdi className="mono">{lastResult.settings_resolution_id}</bdi>
            ) : (
              <span className="mono">{t('baskets.policy.pending')}</span>
            )}
          </div>
          <div>
            {t('baskets.policy.scopeImpact')} <bdi>{lastResult.blast_radius}</bdi>
          </div>
          <div>
            {t('baskets.policy.approval')}{' '}
            {lastResult.approval_required ? t('baskets.policy.required') : t('baskets.policy.notRequired')}
          </div>
          <div>
            {t('baskets.policy.mode')} {lastResult.dry_run ? t('common.preview') : t('baskets.policy.submitted')}
          </div>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={t('common.preview')}
          iconName="eye"
          kind="ghost"
          capability={CAP.BASKETS_WRITE}
          onClick={() => void submit(true)}
        />
        <Button
          label={t('baskets.actions.submitPolicy')}
          iconName="check"
          kind="primary"
          capability={CAP.BASKETS_WRITE}
          onClick={() => void submit(false)}
        />
      </div>
    </div>
  );
}

function defaultLookup(category: string): string {
  const rows = getLookups(category);
  const row = rows.find((entry) => entry.is_default === true) ?? rows[0];
  return String(row?.value ?? '');
}

function BasketCreateForm({
  zones,
  tenantId,
  onClose,
  onSubmit,
}: {
  zones: ZoneRow[];
  tenantId?: string | null;
  onClose: () => void;
  onSubmit: (args: {
    organization_id?: string | null;
    zone_id?: string | null;
    basket_type?: string | null;
    state?: string | null;
    capacity_count?: number | null;
    expires_in_minutes?: number | null;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? '');
  const [basketType, setBasketType] = useState(defaultLookup('basket_type'));
  const [state, setState] = useState(defaultLookup('basket_state'));
  const [capacity, setCapacity] = useState('50');
  const [expiresMinutes, setExpiresMinutes] = useState('240');
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const capacityValue = capacity.trim() === '' ? null : Number(capacity);
    const expiresValue = expiresMinutes.trim() === '' ? null : Number(expiresMinutes);
    if (capacityValue != null && (!Number.isFinite(capacityValue) || capacityValue < 1)) {
      setNotice(t('baskets.create.capacityPositive'));
      return;
    }
    if (expiresValue != null && (!Number.isFinite(expiresValue) || expiresValue < 1)) {
      setNotice(t('baskets.create.expiryPositive'));
      return;
    }
    try {
      await onSubmit({
        organization_id: tenantId ?? null,
        zone_id: zoneId || null,
        basket_type: basketType || null,
        state: state || null,
        capacity_count: capacityValue,
        expires_in_minutes: expiresValue,
      });
      onClose();
    } catch {
      setNotice(t('baskets.create.failed'));
    }
  }

  return (
    <form data-testid="basket-create-modal" onSubmit={(event) => void submit(event)}>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
        <label className="mono" htmlFor="basket-create-zone">{t('baskets.fields.zone')}</label>
        <select
          id="basket-create-zone"
          className="dt-inline-input"
          aria-label={t('baskets.aria.zone')}
          value={zoneId}
          onChange={(event) => setZoneId(event.target.value)}
        >
          <option value="">{t('baskets.values.noZone')}</option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zoneOptionLabel(zone, t)}
            </option>
          ))}
        </select>

        <label className="mono" htmlFor="basket-create-type">{t('baskets.fields.type')}</label>
        <select
          id="basket-create-type"
          className="dt-inline-input"
          aria-label={t('baskets.aria.type')}
          value={basketType}
          onChange={(event) => setBasketType(event.target.value)}
        >
          {getLookups('basket_type').map((entry) => (
            <option key={entry.value} value={String(entry.value)}>
              {entry.label}
            </option>
          ))}
        </select>

        <label className="mono" htmlFor="basket-create-state">{t('baskets.fields.state')}</label>
        <select
          id="basket-create-state"
          className="dt-inline-input"
          aria-label={t('baskets.aria.state')}
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          {getLookups('basket_state').map((entry) => (
            <option key={entry.value} value={String(entry.value)}>
              {entry.label}
            </option>
          ))}
        </select>

        <label className="mono" htmlFor="basket-create-capacity">{t('baskets.fields.capacity')}</label>
        <input
          id="basket-create-capacity"
          className="dt-inline-input"
          aria-label={t('baskets.aria.capacity')}
          inputMode="numeric"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
        />

        <label className="mono" htmlFor="basket-create-expiry">{t('baskets.fields.expiresIn')}</label>
        <input
          id="basket-create-expiry"
          className="dt-inline-input"
          aria-label={t('baskets.aria.expiresInMinutes')}
          inputMode="numeric"
          value={expiresMinutes}
          onChange={(event) => setExpiresMinutes(event.target.value)}
        />
      </div>
      {notice ? (
        <p role="status" className="state__hint" style={{ marginTop: 8 }}>
          {notice}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={t('baskets.actions.createBasket')}
          iconName="plus"
          kind="primary"
          type="submit"
          capability={CAP.BASKETS_WRITE}
        />
      </div>
    </form>
  );
}

function BasketEditForm({
  row,
  zones,
  onClose,
  onSubmit,
}: {
  row: BasketRow;
  zones: ZoneRow[];
  onClose: () => void;
  onSubmit: (args: { basket_id: string; patch: Record<string, unknown> }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [zoneId, setZoneId] = useState(row.zone_id ?? '');
  const [basketType, setBasketType] = useState(row.basket_type ?? '');
  const [capacity, setCapacity] = useState(row.capacity_count == null ? '' : String(row.capacity_count));
  const [expiresAt, setExpiresAt] = useState(row.expires_at ?? '');
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const patch: Record<string, unknown> = {};
      const normalizedZoneId = zoneId.trim() || null;
      if (normalizedZoneId !== (row.zone_id ?? null)) patch.zone_id = normalizedZoneId;

      const normalizedType = basketType.trim() || null;
      if (normalizedType !== (row.basket_type ?? null)) patch.basket_type = normalizedType;

      const capacityValue = parseOptionalPositiveInteger(t('baskets.fields.capacity'), capacity, t);
      if (capacityValue !== (row.capacity_count ?? null)) patch.capacity_count = capacityValue;

      const expiresValue = expiresAt.trim() || null;
      if (expiresValue !== (row.expires_at ?? null)) patch.expires_at = expiresValue;

      if (Object.keys(patch).length === 0) {
        setNotice(t('baskets.edit.noChanges'));
        return;
      }

      await onSubmit({ basket_id: row.id, patch });
      onClose();
    } catch {
      setNotice(t('baskets.edit.failed'));
    }
  }

  return (
    <form data-testid="basket-edit-modal" onSubmit={(event) => void submit(event)}>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
        <label className="mono" htmlFor="basket-edit-zone">{t('baskets.fields.zone')}</label>
        <select
          id="basket-edit-zone"
          className="dt-inline-input"
          aria-label={t('baskets.aria.zone')}
          value={zoneId}
          onChange={(event) => setZoneId(event.target.value)}
        >
          <option value="">{t('baskets.values.noZone')}</option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zoneOptionLabel(zone, t)}
            </option>
          ))}
        </select>

        <label className="mono" htmlFor="basket-edit-type">{t('baskets.fields.type')}</label>
        <select
          id="basket-edit-type"
          className="dt-inline-input"
          aria-label={t('baskets.aria.type')}
          value={basketType}
          onChange={(event) => setBasketType(event.target.value)}
        >
          {getLookups('basket_type').map((entry) => (
            <option key={entry.value} value={String(entry.value)}>
              {entry.label}
            </option>
          ))}
          {basketType && !getLookups('basket_type').some((entry) => String(entry.value) === basketType) ? (
            <option value={basketType}>{operatorLabelForSettingValue(basketType)}</option>
          ) : null}
        </select>

        <label className="mono" htmlFor="basket-edit-capacity">{t('baskets.fields.capacity')}</label>
        <input
          id="basket-edit-capacity"
          className="dt-inline-input"
          aria-label={t('baskets.aria.capacity')}
          inputMode="numeric"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
        />

        <label className="mono" htmlFor="basket-edit-expiry">{t('baskets.fields.expiresAt')}</label>
        <input
          id="basket-edit-expiry"
          className="dt-inline-input"
          aria-label={t('baskets.aria.expiresAt')}
          placeholder="2026-05-05T12:00:00Z"
          value={expiresAt}
          onChange={(event) => setExpiresAt(event.target.value)}
        />
      </div>
      <p className="state__hint" style={{ marginTop: 8 }}>
        {t('baskets.edit.hint')}
      </p>
      {notice ? (
        <p role="status" className="state__hint" style={{ marginTop: 8 }}>
          {notice}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={t('baskets.actions.saveBasket')}
          iconName="check"
          kind="primary"
          type="submit"
          capability={CAP.BASKETS_WRITE}
        />
      </div>
    </form>
  );
}

interface BasketItemDrawerRow extends BasketItemRow {
  shipment_label: string;
}

function BasketDrawerContent({
  row,
  zone,
  onOpenShipment,
  onResortShipment,
}: {
  row: BasketRow;
  zone?: ZoneRow | null;
  onOpenShipment: (shipmentId: string, shipment?: ShipmentRow | null) => void;
  onResortShipment: (item: BasketItemDrawerRow) => Promise<void>;
}) {
  const { t, fmtDateTime } = useI18n();
  const transitionCols = useMemo(() => transitionColumns(t), [t]);
  const itemsQuery = useResourceList<BasketItemRow>('basket_items', {
    filter: { basket_id: row.id },
    sort: { key: 'added_at', dir: 'desc' },
    page_size: 500,
  });
  const transitionsQuery = useResourceList<BasketTransitionRow>('basket_transitions', {
    filter: { basket_id: row.id },
    sort: { key: 'changed_at', dir: 'desc' },
    page_size: 500,
  });
  const rowItems = useMemo(() => itemsQuery.data?.rows ?? [], [itemsQuery.data]);
  const shipmentIds = useMemo(
    () => Array.from(new Set(rowItems.map((item) => item.shipment_id).filter(Boolean))).sort(),
    [rowItems],
  );
  const shipmentsQuery = useResourceRowsByIds<ShipmentRow>('shipments', shipmentIds, {
    enabled: shipmentIds.length > 0,
  });
  const shipmentById = useMemo(() => {
    const map = new Map<string, ShipmentRow>();
    for (const shipment of shipmentsQuery.data?.rows ?? []) map.set(shipment.id, shipment);
    return map;
  }, [shipmentsQuery.data]);

  const kvRows: KvRow[] = [
    { key: 'summary', label: t('baskets.fields.basket'), value: basketDisplayLabel(row, zone, t), editable: false },
    { key: 'zone_id', label: t('baskets.fields.zone'), value: zone?.name ?? t('baskets.values.unzoned'), editable: false },
    { key: 'basket_type', label: t('baskets.fields.type'), value: basketTypeLabel(row.basket_type), editable: false },
    { key: 'state', label: t('baskets.fields.state'), value: stateLabel(row.state), editable: false },
    { key: 'load', label: t('baskets.fields.load'), value: capacityText(row, t), mono: true, editable: false },
    { key: 'expires_at', label: t('baskets.fields.expires'), value: formatBasketDateTime(row.expires_at, fmtDateTime), editable: false },
    { key: 'version', label: t('baskets.fields.version'), value: row.version ?? '-', mono: true, editable: false },
    { key: 'updated_at', label: t('baskets.fields.updated'), value: formatBasketDateTime(row.updated_at, fmtDateTime), editable: false },
  ];

  const isLoading =
    itemsQuery.isLoading ||
    transitionsQuery.isLoading ||
    (shipmentIds.length > 0 && shipmentsQuery.isLoading);
  const error = itemsQuery.error ?? transitionsQuery.error ?? shipmentsQuery.error;

  const itemRows: BasketItemDrawerRow[] = rowItems.map((item) => ({
    ...item,
    shipment_label: shipmentDisplayLabel(shipmentById.get(item.shipment_id), t('baskets.values.shipmentLinked')),
  }));

  return (
    <div data-testid="baskets-drawer">
      <div className="section-eyebrow">{t('baskets.drawer.profile')}</div>
      <KvGrid rows={kvRows} />

      {isLoading ? (
        <StateView kind="loading" />
      ) : error ? (
        <StateView
          kind="error"
          title={t('baskets.drawer.detailsUnavailable')}
          hint={queryErrorMessage(error, t('baskets.drawer.detailsHint'))}
        />
      ) : (
        <>
          <div className="section-eyebrow" style={{ marginTop: 12 }}>
            {t('baskets.drawer.items')}
          </div>
          <DataTable<BasketItemDrawerRow>
            columns={[
              { key: 'shipment_label', label: t('baskets.fields.shipment'), sortable: true, filterable: true },
              { key: 'added_at', label: t('baskets.fields.added'), format: 'datetime', sortable: true },
              { key: 'removed_at', label: t('baskets.fields.removed'), format: 'datetime', sortable: true },
            ]}
            rows={itemRows}
            viewKey={`basket_items_${row.id}`}
            entityKind={t('baskets.entity.items')}
            allowSelection={false}
            emptyText={t('baskets.drawer.noItems')}
            onRowClick={(item) => onOpenShipment(item.shipment_id, shipmentById.get(item.shipment_id))}
            rowDeepLink={(item) => `/operate/shipments?focus=${encodeURIComponent(item.shipment_id)}`}
            rowActions={[
              {
                label: t('baskets.actions.openShipment'),
                icon: 'eye',
                onClick: (item) => onOpenShipment(item.shipment_id, shipmentById.get(item.shipment_id)),
              },
              {
                label: t('baskets.actions.reapplyPolicy'),
                icon: 'rotate',
                capability: CAP.SHIPMENTS_WRITE,
                meta: t('baskets.actions.reapplyMeta'),
                onClick: (item) => {
                  void onResortShipment(item);
                },
              },
            ]}
          />

          <div className="section-eyebrow" style={{ marginTop: 12 }}>
            {t('baskets.drawer.history')}
          </div>
          <DataTable<BasketTransitionRow>
            columns={transitionCols}
            rows={transitionsQuery.data?.rows ?? []}
            viewKey={`basket_transitions_${row.id}`}
            entityKind={t('baskets.entity.history')}
            allowSelection={false}
            emptyText={t('baskets.drawer.noTransitions')}
          />
        </>
      )}
    </div>
  );
}

export function BasketsModule() {
  const { t, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const { scope, currentTenantId } = useIdentity();
  const canRead = useCapability(CAP.BASKETS_READ);
  const canWrite = useCapability(CAP.BASKETS_WRITE);
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const tenantSettingsScope = useMemo(
    () => (tenantId ? { tenant: { id: tenantId } } : undefined),
    [tenantId],
  );

  const basketsQuery = useResourceList<BasketRow>('baskets', tenantListOpts);
  const zonesQuery = useResourceList<ZoneRow>('zones', tenantListOpts);
  const createBasketMutation = useCreateBasket();
  const updateBasketMutation = useUpdateBasket();
  const transitionMutation = useUpdateBasketState();
  const resortShipmentMutation = useResortShipment();
  const basketPolicyQuery = useResolveSettings('basket_policy', tenantSettingsScope);
  const proposeBasketPolicyMutation = useProposeSettingsChange();

  const rows = useMemo(() => basketsQuery.data?.rows ?? [], [basketsQuery.data]);
  const zones = useMemo(() => zonesQuery.data?.rows ?? [], [zonesQuery.data]);
  const searchParams = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const focusParam = searchParams?.get('focus') ?? null;
  const legacyFocusResource = legacyBasketFocusResource(searchParams?.get('legacy_resource') ?? null);
  const legacyFocusParam = legacyFocusResource ? (searchParams?.get('legacy_focus') ?? focusParam) : null;
  const directBasketFocusParam = legacyFocusResource ? null : focusParam;
  const legacyFocusQuery = useResource<BasketItemRow | BasketTransitionRow>(
    legacyFocusResource ?? 'basket_items',
    legacyFocusResource && legacyFocusParam ? legacyFocusParam : undefined,
  );
  const legacyBasketFocusParam =
    typeof legacyFocusQuery.data?.basket_id === 'string' && legacyFocusQuery.data.basket_id.trim()
      ? legacyFocusQuery.data.basket_id
      : null;
  const basketFocusParam = directBasketFocusParam ?? legacyBasketFocusParam;
  const focusedRowFromList = basketFocusParam ? rows.find((basket) => basket.id === basketFocusParam) : undefined;
  const focusedBasketQuery = useResource<BasketRow>(
    'baskets',
    basketFocusParam && !focusedRowFromList ? basketFocusParam : undefined,
  );
  const openedFocusRef = useRef<string | null>(null);
  const basketPolicyValue = useMemo(
    () => (basketPolicyQuery.data?.value as Record<string, unknown> | undefined) ?? {},
    [basketPolicyQuery.data],
  );

  const zoneById = useMemo(() => {
    const map = new Map<string, ZoneRow>();
    for (const zone of zones) map.set(zone.id, zone);
    return map;
  }, [zones]);

  const columns = useMemo<DataTableColumn<BasketRow>[]>(() => [
    {
      key: 'basket_label',
      label: t('baskets.fields.basket'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => {
        const zone = row.zone_id ? zoneById.get(row.zone_id) : null;
        // The label joins lookup and zone names, which are record data.
        return <bdi>{basketDisplayLabel(row, zone, t)}</bdi>;
      },
    },
    {
      key: 'zone_id',
      label: t('baskets.fields.zone'),
      sortable: true,
      filterable: true,
      render: (raw) => {
        const zoneId = typeof raw === 'string' ? raw : null;
        if (!zoneId) return <span>{t('baskets.values.unzoned')}</span>;
        const zone = zoneById.get(zoneId);
        return zone?.name ? <bdi>{zone.name}</bdi> : <span>{t('baskets.values.zoneNotLinked')}</span>;
      },
    },
    { key: 'basket_type', label: t('baskets.fields.type'), lookup: 'basket_type', sortable: true, filterable: true },
    { key: 'state', label: t('baskets.fields.state'), lookup: 'basket_state', sortable: true, filterable: true },
    {
      key: 'current_count',
      label: t('baskets.fields.load'),
      align: 'right',
      sortable: true,
      render: (_raw, row) => <bdi className="mono">{capacityText(row, t)}</bdi>,
    },
    {
      key: 'expires_at',
      label: t('baskets.fields.expires'),
      sortable: true,
      render: (raw) => formatBasketDateTime(raw, fmtDateTime),
    },
    { key: 'version', label: t('baskets.fields.version'), mono: true, align: 'right', sortable: true },
    { key: 'updated_at', label: t('baskets.fields.updated'), format: 'datetime', sortable: true },
  ], [zoneById, t, fmtDateTime]);

  const kpis = useMemo(() => {
    const total = rows.length;
    const open = rows.filter((row) => stateMeta(row.state).is_open === true).length;
    const ready = rows.filter((row) => stateMeta(row.state).is_ready === true).length;
    const atCapacity = rows.filter((row) => {
      const capacity = Number(row.capacity_count ?? 0);
      return capacity > 0 && Number(row.current_count ?? 0) >= capacity;
    }).length;
    const exceptions = rows.filter((row) => stateMeta(row.state).is_exception === true).length;
    return [
      { key: 'total', label: t('baskets.kpi.total'), value: total, tone: 'neutral' as const },
      { key: 'open', label: t('common.open'), value: open, tone: 'info' as const },
      { key: 'ready', label: t('baskets.kpi.ready'), value: ready, tone: 'good' as const },
      { key: 'capacity', label: t('baskets.kpi.atCapacity'), value: atCapacity, tone: atCapacity > 0 ? 'warn' as const : 'neutral' as const },
      { key: 'expired', label: t('baskets.kpi.expired'), value: exceptions, tone: exceptions > 0 ? 'danger' as const : 'neutral' as const },
    ];
  }, [rows, t]);

  useEffect(() => {
    if (!basketFocusParam) {
      openedFocusRef.current = null;
      return undefined;
    }
    if (openedFocusRef.current === basketFocusParam) return undefined;
    const target = focusedRowFromList ?? focusedBasketQuery.data;
    if (!target) return undefined;
    const timer = window.setTimeout(() => {
      openBasketDrawer(target);
      openedFocusRef.current = basketFocusParam;
    }, 100);
    return () => window.clearTimeout(timer);
    // openBasketDrawer closes over current query data and drawer state; focus target is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketFocusParam, focusedRowFromList, focusedBasketQuery.data]);

  function openTransitionModal(row: BasketRow) {
    const nextStates = nextStatesFor(row);
    let nextState = nextStates[0] ?? '';
    let reason = '';

    modal.open({
      title: fill(t('baskets.transition.title'), { basket: basketDisplayLabel(row, row.zone_id ? zoneById.get(row.zone_id) : null, t) }),
      body: (
        <div data-testid="basket-transition-modal">
          <p className="state__hint">
            {t('baskets.transition.hint')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center', marginTop: 8 }}>
            <label className="mono">{t('baskets.fields.current')}</label>
            <Chip label={stateLabel(row.state)} kind={stateTone(row.state)} size="xs" />
            <label className="mono">{t('baskets.fields.nextState')}</label>
            <select
              className="dt-inline-input"
              aria-label={t('baskets.fields.nextState')}
              defaultValue={nextState}
              disabled={nextStates.length === 0}
              onChange={(event) => {
                nextState = event.target.value;
              }}
            >
              {nextStates.map((state) => (
                <option key={state} value={state}>
                  {stateLabel(state)}
                </option>
              ))}
            </select>
            <label className="mono">{t('baskets.fields.reason')}</label>
            <input
              className="dt-inline-input"
              aria-label={t('baskets.aria.transitionReason')}
              placeholder={t('baskets.values.optional')}
              onChange={(event) => {
                reason = event.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('baskets.actions.applyTransition')}
            iconName="check"
            kind="primary"
            capability={CAP.BASKETS_WRITE}
            disabled={!canWrite || nextStates.length === 0}
            onClick={() => {
              transitionMutation.mutate(
                { basket_id: row.id, state: nextState, reason },
                {
                  onSuccess: () => {
                    pushToast(fill(t('baskets.transition.moved'), { state: stateLabel(nextState) }), 'good');
                    modal.close();
                    drawer.close();
                  },
                  onError: () =>
                    pushToast(t('baskets.transition.failed'), 'danger'),
                },
              );
            }}
          />
        </div>
      ),
    });
  }

  function openEditBasketModal(row: BasketRow) {
    modal.open({
      title: fill(t('baskets.edit.title'), { basket: basketDisplayLabel(row, row.zone_id ? zoneById.get(row.zone_id) : null, t) }),
      body: (
        <BasketEditForm
          row={row}
          zones={zones}
          onClose={() => modal.close()}
          onSubmit={async (args) => {
            await updateBasketMutation.mutateAsync(args);
            pushToast(t('baskets.edit.updated'), 'good');
          }}
        />
      ),
    });
  }

  function openBasketDrawer(row: BasketRow) {
    const zone = row.zone_id ? zoneById.get(row.zone_id) : null;
    drawer.open({
      title: basketDisplayLabel(row, zone, t),
      size: 'lg',
      body: (
        <BasketDrawerContent
          row={row}
          zone={zone}
          onOpenShipment={(shipmentId, shipment) => {
            openShipmentContextDrawer(drawer, shipmentId, {
              fallbackShipment: shipment
                ? {
                    id: shipment.id,
                    tracking_number: shipment.tracking_number ?? shipmentId,
                    client_reference_number: shipment.client_reference_number,
                  }
                : null,
            });
          }}
          onResortShipment={async (item) => {
            await resortShipmentMutation.mutateAsync(item.shipment_id);
            pushToast(fill(t('baskets.drawer.reapplied'), { shipment: item.shipment_label }), 'good');
          }}
        />
      ),
      footer: (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            label={t('baskets.actions.editBasket')}
            iconName="edit"
            kind="ghost"
            capability={CAP.BASKETS_WRITE}
            disabled={!canWrite}
            onClick={() => openEditBasketModal(row)}
          />
          <Button
            label={t('baskets.actions.transitionState')}
            iconName="git"
            kind="primary"
            capability={CAP.BASKETS_WRITE}
            disabled={!canWrite}
            onClick={() => openTransitionModal(row)}
          />
          <span className="state__hint">{t('baskets.drawer.footerHint')}</span>
        </div>
      ),
    });
  }

  function openCreateBasketModal() {
    modal.open({
      title: t('baskets.actions.newBasket'),
      body: (
        <BasketCreateForm
          zones={zones}
          tenantId={tenantId}
          onClose={() => modal.close()}
          onSubmit={async (args) => {
            const result = await createBasketMutation.mutateAsync(args);
            pushToast(t('baskets.create.created'), 'good');
          }}
        />
      ),
    });
  }

  function openBasketPolicyModal() {
    if (!tenantId) {
      pushToast(t('baskets.policy.noTenant'), 'warn');
      return;
    }
    modal.open({
      title: t('baskets.actions.policy'),
      body: (
        <BasketPolicyChangeForm
          initialValue={basketPolicyValue}
          onClose={() => modal.close()}
          onSubmit={async ({ value, dryRun }) => {
            const result = await proposeBasketPolicyMutation.mutateAsync({
              category: 'basket_policy',
              scope: { tenant: { id: tenantId } },
              value,
              dryRun,
              justification: `Operator ${dryRun ? 'previewed' : 'submitted'} basket policy from Console V2`,
            });
            pushToast(
              dryRun ? t('baskets.policy.previewToast') : t('baskets.policy.submittedToast'),
              'good',
            );
            return result;
          }}
        />
      ),
    });
  }

  const rowActions: DataTableAction<BasketRow>[] = [
    {
      label: t('baskets.actions.editBasket'),
      icon: 'edit',
      capability: CAP.BASKETS_WRITE,
      onClick: openEditBasketModal,
    },
    {
      label: t('baskets.actions.transitionState'),
      icon: 'git',
      capability: CAP.BASKETS_WRITE,
      onClick: openTransitionModal,
    },
  ];

  if (!canRead) {
    return (
      <div className="page" data-testid="baskets-page">
        <PageHeader
          eyebrow={t('nav.operate')}
          titleAccent={t('baskets.header.accent')}
          titlePlain={t('baskets.header.plain')}
          pills={[
            <span key="cap" className="chip chip--xs">{t('baskets.pills.accessRequired')}</span>,
          ] as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.BASKETS_READ}
          hint={t('baskets.list.deniedHint')}
        />
      </div>
    );
  }

  return (
    <div className="page" data-testid="baskets-page">
      <PageHeader
        moduleKey="baskets"
        eyebrow={t('nav.operate')}
        titleAccent={t('baskets.header.accent')}
        titlePlain={t('baskets.header.plain')}
        pills={[
          <span key="baskets" className="chip chip--xs">{t('baskets.pills.tenantSortGroups')}</span>,
          <span key="items" className="chip chip--xs">{t('baskets.pills.shipmentMembership')}</span>,
          <span key="transitions" className="chip chip--xs">{t('baskets.pills.transitionHistory')}</span>,
          <span key="caps" className="chip chip--xs">{t('baskets.pills.policyControlled')}</span>,
        ] as ReactNode[]}
        actions={[
          <Button
            key="create"
            label={t('baskets.actions.newBasket')}
            iconName="plus"
            kind="primary"
            capability={CAP.BASKETS_WRITE}
            onClick={openCreateBasketModal}
          />,
          <Button
            key="policy"
            label={t('baskets.actions.policy')}
            iconName="settings"
            kind="ghost"
            capability={CAP.BASKETS_WRITE}
            onClick={openBasketPolicyModal}
          />,
        ]}
      />

      <div className="kpi-strip" data-testid="baskets-kpi-strip">
        {kpis.map((kpi) => (
          <KPICard key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} />
        ))}
      </div>

      {basketsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : basketsQuery.error ? (
        <StateView
          kind="error"
          title={t('baskets.list.unavailable')}
          hint={queryErrorMessage(basketsQuery.error, t('baskets.list.rowsHint'))}
        />
      ) : rows.length === 0 ? (
        <StateView kind="empty" hint={t('baskets.list.empty')} />
      ) : (
        <DataTable<BasketRow>
          columns={columns}
          rows={rows}
          viewKey="baskets"
          entityKind={t('baskets.entity.baskets')}
          onRowClick={openBasketDrawer}
          rowActions={rowActions}
          rowDeepLink={(row) => `/operate/baskets?focus=${encodeURIComponent(row.id)}`}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}
