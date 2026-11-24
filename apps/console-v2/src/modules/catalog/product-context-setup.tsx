import { useState } from 'react';
import { Button } from '@/components/Button';
import { pushToast } from '@/components/toastStore';
import { CAP } from '@/lib/capabilities';
import { getLookups, lookupRow } from '@/lib/api';
import type * as api from '@/lib/api';
import type {
  BranchRow,
  ProductContextSetupReadback,
  ServiceLevelRow,
  ServiceOfferingRow,
  ZoneRow,
} from './service-offerings.types';
import { fill, useI18n } from '@/lib/i18n';

interface ProductContextSetupDraft {
  service_level_id: string;
  service_level_name: string;
  service_level_description: string;
  service_level_tier: string;
  service_level_priority_rank: string;
  service_level_sla_minutes: string;
  service_level_sla_label: string;
  branch_id: string;
  branch_name: string;
  branch_code: string;
  branch_type: string;
  branch_status: string;
  branch_timezone: string;
  branch_city: string;
  branch_address: string;
  branch_capacity_per_day: string;
  create_zone: boolean;
  zone_id: string;
  zone_name: string;
  zone_color_token: string;
  offering_display_name: string;
  offering_display_slug: string;
  offering_priority: string;
  offering_base_price: string;
  offering_currency: string;
  offering_max_weight_kg: string;
}

export interface ProductContextSetupFormProps {
  levels: ServiceLevelRow[];
  branches: BranchRow[];
  zones: ZoneRow[];
  offerings: ServiceOfferingRow[];
  activeTenantId: string;
  tenantTimezoneIana: string;
  tenantCurrencyIso: string | null;
  canWriteZones: boolean;
  createServiceLevel: (args: api.ServiceLevelCreateArgs) => Promise<api.ServiceLevelCreateResult>;
  createBranch: (
    args: api.BranchCreateArgs,
  ) => Promise<Record<string, unknown> & { branch_id?: string; id?: string }>;
  createZone: (args: api.ZoneCreateArgs) => Promise<api.ZoneCreateResult>;
  assignBranchZone: (args: api.BranchZoneAssignArgs) => Promise<unknown>;
  createOffering: (args: api.ServiceOfferingCreateArgs) => Promise<api.ServiceOfferingCreateResult>;
  refetchReadback: (args: {
    levelId: string;
    branchId: string;
    zoneId: string | null;
    offeringId: string;
  }) => Promise<ProductContextSetupReadback>;
  serviceLevelOptionLabel: (level: ServiceLevelRow) => string;
  serviceLevelKeyFromName: (name: string) => string;
  isOfferingActive: (offering: ServiceOfferingRow) => boolean;
  offeringStatusDefault: string | null;
  onReady: (readback: ProductContextSetupReadback, displayName: string) => void;
  onCancel: () => void;
}

function serviceOfferingSlugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function defaultLookupValue(category: string): string {
  return (
    (getLookups(category) as Array<{ value: string; is_default?: boolean }> | undefined) ?? []
  ).find((row) => row.is_default)?.value ?? '';
}

function lookupBooleanMetadata(category: string, value: string, key: string): boolean | undefined {
  const raw = lookupRow(category, value)?.metadata?.[key];
  return typeof raw === 'boolean' ? raw : undefined;
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function ProductContextSetupForm({
  const { t } = useI18n();
  levels,
  branches,
  zones,
  offerings,
  activeTenantId,
  tenantTimezoneIana,
  tenantCurrencyIso,
  canWriteZones,
  createServiceLevel,
  createBranch,
  createZone,
  assignBranchZone,
  createOffering,
  refetchReadback,
  serviceLevelOptionLabel,
  serviceLevelKeyFromName,
  isOfferingActive,
  offeringStatusDefault,
  onReady,
  onCancel,
}: ProductContextSetupFormProps) {
  const branchTypeOptions = getLookups('branch_type');
  const branchStatusOptions = getLookups('branch_status');
  const zoneColorOptions = getLookups('zone_color_token');
  const [draft, setDraft] = useState<ProductContextSetupDraft>({
    service_level_id: levels[0]?.id ?? '',
    service_level_name: '',
    service_level_description: '',
    service_level_tier: '',
    service_level_priority_rank: '',
    service_level_sla_minutes: '',
    service_level_sla_label: '',
    branch_id: branches[0]?.id ?? '',
    branch_name: '',
    branch_code: '',
    branch_type: defaultLookupValue('branch_type'),
    branch_status: defaultLookupValue('branch_status'),
    branch_timezone: tenantTimezoneIana,
    branch_city: '',
    branch_address: '',
    branch_capacity_per_day: '',
    create_zone: false,
    zone_id: zones[0]?.id ?? '',
    zone_name: '',
    zone_color_token: defaultLookupValue('zone_color_token'),
    offering_display_name: '',
    offering_display_slug: '',
    offering_priority: '0',
    offering_base_price: '',
    offering_currency: tenantCurrencyIso ?? '',
    offering_max_weight_kg: '',
  });
  const [pending, setPending] = useState(false);
  const serviceLevelId = draft.service_level_id || levels[0]?.id || '';
  const branchId = draft.branch_id || branches[0]?.id || '';
  const zoneId = draft.zone_id || zones[0]?.id || '';
  const createsServiceLevel = !serviceLevelId;
  const createsBranch = !branchId;
  const createsZone = draft.create_zone && !zoneId;

  async function submit() {
    if (pending) return;
    if (createsServiceLevel && !draft.service_level_name.trim()) {
      pushToast(t('catalogProductContextSetup.productContextSetupForm.serviceLevelNameIs'), 'warn');
      return;
    }
    if (createsBranch) {
      if (!draft.branch_name.trim()) {
        pushToast(t('catalogProductContextSetup.productContextSetupForm.branchNameIsRequired'), 'warn');
        return;
      }
      if (!draft.branch_type.trim()) {
        pushToast(t('catalogProductContextSetup.productContextSetupForm.branchTypeIsRequired'), 'warn');
        return;
      }
      if (!draft.branch_status.trim()) {
        pushToast(t('catalogProductContextSetup.productContextSetupForm.branchStatusIsRequired'), 'warn');
        return;
      }
      if (!draft.branch_timezone.trim()) {
        pushToast(t('catalogProductContextSetup.productContextSetupForm.branchTimezoneIsRequired'), 'warn');
        return;
      }
    }
    if (createsZone && !draft.zone_name.trim()) {
      pushToast(t('catalogProductContextSetup.productContextSetupForm.zoneNameIsRequired'), 'warn');
      return;
    }
    if (draft.create_zone && !canWriteZones) {
      pushToast(t('catalogProductContextSetup.productContextSetupForm.zoneSetupRequiresZones'), 'warn');
      return;
    }
    const displayName = draft.offering_display_name.trim();
    const displaySlug = draft.offering_display_slug.trim() || serviceOfferingSlugFromName(displayName);
    if (!displayName || !displaySlug) {
      pushToast(t('catalogProductContextSetup.productContextSetupForm.offeringDisplayNameIs'), 'warn');
      return;
    }

    setPending(true);
    try {
      let resolvedLevelId = serviceLevelId;
      if (!resolvedLevelId) {
        const name = draft.service_level_name.trim();
        const key = serviceLevelKeyFromName(name);
        if (!key) throw new Error(t('catalogProductContextSetup.productContextSetupForm.serviceLevelKeyCould'));
        const metadata: Record<string, unknown> = {};
        if (draft.service_level_tier.trim()) metadata.tier = draft.service_level_tier.trim();
        const rank = positiveNumber(draft.service_level_priority_rank);
        if (rank != null) metadata.priority_rank = rank;
        const slaMinutes = positiveNumber(draft.service_level_sla_minutes);
        if (slaMinutes != null) metadata.sla_minutes = slaMinutes;
        if (draft.service_level_sla_label.trim()) {
          metadata.sla_label = draft.service_level_sla_label.trim();
        }
        const result = await createServiceLevel({
          key,
          name,
          description: draft.service_level_description.trim() || undefined,
          organization_id: activeTenantId || undefined,
          metadata,
        });
        resolvedLevelId = result.service_level_id;
      }

      let resolvedBranchId = branchId;
      if (!resolvedBranchId) {
        const metadata: Record<string, unknown> = {
          lifecycle: draft.branch_status.trim(),
        };
        const capacity = nonNegativeNumber(draft.branch_capacity_per_day);
        if (capacity != null) metadata.initial_capacity_per_day = capacity;
        const branchPayload: api.BranchCreateArgs = {
          name: draft.branch_name.trim(),
          branch_type: draft.branch_type.trim(),
          timezone: draft.branch_timezone.trim(),
          metadata,
        };
        if (activeTenantId) branchPayload.organization_id = activeTenantId;
        if (draft.branch_code.trim()) branchPayload.code = draft.branch_code.trim();
        const address: Record<string, unknown> = {};
        if (draft.branch_city.trim()) address.city = draft.branch_city.trim();
        if (draft.branch_address.trim()) address.formatted = draft.branch_address.trim();
        if (Object.keys(address).length > 0) branchPayload.address = address;
        const isActive = lookupBooleanMetadata(
          'branch_status',
          draft.branch_status.trim(),
          'is_active_branch_status',
        );
        if (typeof isActive === 'boolean') branchPayload.is_active = isActive;
        const result = await createBranch(branchPayload);
        resolvedBranchId = result.branch_id ?? result.id ?? '';
      }

      let resolvedZoneId: string | null = draft.create_zone ? zoneId || null : null;
      if (draft.create_zone && !resolvedZoneId) {
        const zonePayload: api.ZoneCreateArgs = {
          name: draft.zone_name.trim(),
          ...(activeTenantId ? { organization_id: activeTenantId } : {}),
        };
        if (draft.zone_color_token.trim()) zonePayload.color_token = draft.zone_color_token.trim();
        const result = await createZone(zonePayload);
        resolvedZoneId = result.zone_id;
      }
      if (resolvedZoneId) {
        await assignBranchZone({
          branch_id: resolvedBranchId,
          zone_id: resolvedZoneId,
          priority: 0,
        });
      }

      let resolvedOfferingId =
        offerings.find((row) =>
          row.service_level_id === resolvedLevelId
          && row.branch_id === resolvedBranchId
          && (row.zone_id ?? null) === (resolvedZoneId ?? null)
          && isOfferingActive(row)
        )?.id ?? '';
      if (!resolvedOfferingId) {
        const metadata: Record<string, unknown> = {
          display: {
            name: displayName,
            slug: displaySlug,
            ...(offeringStatusDefault ? { status: offeringStatusDefault } : {}),
          },
          currency: draft.offering_currency || tenantCurrencyIso || '',
        };
        const price = positiveNumber(draft.offering_base_price);
        if (price != null) metadata.base_price = price;
        const weight = positiveNumber(draft.offering_max_weight_kg);
        if (weight != null) metadata.max_weight_kg = weight;
        const result = await createOffering({
          service_level_id: resolvedLevelId,
          branch_id: resolvedBranchId,
          zone_id: resolvedZoneId,
          priority: Number(draft.offering_priority) || 0,
          metadata,
        });
        resolvedOfferingId = result.service_offering_id;
      }

      const readback = await refetchReadback({
        levelId: resolvedLevelId,
        branchId: resolvedBranchId,
        zoneId: resolvedZoneId,
        offeringId: resolvedOfferingId,
      });
      onReady(readback, displayName);
      pushToast(fill(t('catalogProductContextSetup.productContextSetupForm.productContextReadyDisplayname'), { displayName: String(displayName) }), 'good');
    } catch (err) {
      pushToast((err as Error).message, 'danger');
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="product-context-setup-body">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '150px 1fr',
          gap: '8px',
          alignItems: 'center',
          padding: '0 4px',
          marginTop: 8,
        }}
      >
        {levels.length > 0 ? (
          <>
            <label className="mono" htmlFor="setup-level">{t('catalogProductContextSetup.productContextSetupForm.serviceLevel')}</label>
            <select
              id="setup-level"
              className="dt-inline-input"
              value={draft.service_level_id}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_id: e.target.value }))}
            >
              {levels.map((level) => (
                <option key={level.id} value={level.id}>{serviceLevelOptionLabel(level)}</option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label className="mono" htmlFor="setup-level-name">{t('catalogProductContextSetup.productContextSetupForm.serviceLevelName')}</label>
            <input
              id="setup-level-name"
              className="dt-inline-input"
              value={draft.service_level_name}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_name: e.target.value }))}
              autoFocus
            />
            <label className="mono" htmlFor="setup-level-description">{t('catalogProductContextSetup.productContextSetupForm.levelDescription')}</label>
            <input
              id="setup-level-description"
              className="dt-inline-input"
              value={draft.service_level_description}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_description: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-level-tier">{t('catalogProductContextSetup.productContextSetupForm.levelTier')}</label>
            <input
              id="setup-level-tier"
              className="dt-inline-input"
              value={draft.service_level_tier}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_tier: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-level-rank">{t('catalogProductContextSetup.productContextSetupForm.priorityRank')}</label>
            <input
              id="setup-level-rank"
              type="number"
              className="dt-inline-input"
              value={draft.service_level_priority_rank}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_priority_rank: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-level-sla-minutes">{t('catalogProductContextSetup.productContextSetupForm.slaMinutes')}</label>
            <input
              id="setup-level-sla-minutes"
              type="number"
              className="dt-inline-input"
              value={draft.service_level_sla_minutes}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_sla_minutes: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-level-sla-label">{t('catalogProductContextSetup.productContextSetupForm.slaLabel')}</label>
            <input
              id="setup-level-sla-label"
              className="dt-inline-input"
              value={draft.service_level_sla_label}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_sla_label: e.target.value }))}
            />
          </>
        )}

        {branches.length > 0 ? (
          <>
            <label className="mono" htmlFor="setup-branch">{t('catalogProductContextSetup.productContextSetupForm.branch')}</label>
            <select
              id="setup-branch"
              className="dt-inline-input"
              value={draft.branch_id}
              onChange={(e) => setDraft((s) => ({ ...s, branch_id: e.target.value }))}
            >
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label className="mono" htmlFor="setup-branch-name">{t('catalogProductContextSetup.productContextSetupForm.branchName')}</label>
            <input
              id="setup-branch-name"
              className="dt-inline-input"
              value={draft.branch_name}
              onChange={(e) => setDraft((s) => ({ ...s, branch_name: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-branch-code">{t('catalogProductContextSetup.productContextSetupForm.branchCode')}</label>
            <input
              id="setup-branch-code"
              className="dt-inline-input"
              value={draft.branch_code}
              onChange={(e) => setDraft((s) => ({ ...s, branch_code: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-branch-type">{t('catalogProductContextSetup.productContextSetupForm.branchType')}</label>
            {branchTypeOptions.length > 0 ? (
              <select
                id="setup-branch-type"
                className="dt-inline-input"
                value={draft.branch_type}
                onChange={(e) => setDraft((s) => ({ ...s, branch_type: e.target.value }))}
              >
                <option value="">{t('catalogProductContextSetup.productContextSetupForm.selectBranchType')}</option>
                {branchTypeOptions.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
              </select>
            ) : (
              <input
                id="setup-branch-type"
                className="dt-inline-input"
                value={draft.branch_type}
                onChange={(e) => setDraft((s) => ({ ...s, branch_type: e.target.value }))}
              />
            )}
            <label className="mono" htmlFor="setup-branch-status">{t('catalogProductContextSetup.productContextSetupForm.branchStatus')}</label>
            {branchStatusOptions.length > 0 ? (
              <select
                id="setup-branch-status"
                className="dt-inline-input"
                value={draft.branch_status}
                onChange={(e) => setDraft((s) => ({ ...s, branch_status: e.target.value }))}
              >
                <option value="">{t('catalogProductContextSetup.productContextSetupForm.selectBranchStatus')}</option>
                {branchStatusOptions.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
              </select>
            ) : (
              <input
                id="setup-branch-status"
                className="dt-inline-input"
                value={draft.branch_status}
                onChange={(e) => setDraft((s) => ({ ...s, branch_status: e.target.value }))}
              />
            )}
            <label className="mono" htmlFor="setup-branch-timezone">{t('catalogProductContextSetup.productContextSetupForm.branchTimezone')}</label>
            <input
              id="setup-branch-timezone"
              className="dt-inline-input"
              value={draft.branch_timezone}
              onChange={(e) => setDraft((s) => ({ ...s, branch_timezone: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-branch-city">{t('catalogProductContextSetup.productContextSetupForm.branchCity')}</label>
            <input
              id="setup-branch-city"
              className="dt-inline-input"
              value={draft.branch_city}
              onChange={(e) => setDraft((s) => ({ ...s, branch_city: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-branch-address">{t('catalogProductContextSetup.productContextSetupForm.branchAddress')}</label>
            <input
              id="setup-branch-address"
              className="dt-inline-input"
              value={draft.branch_address}
              onChange={(e) => setDraft((s) => ({ ...s, branch_address: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-branch-capacity">{t('catalogProductContextSetup.productContextSetupForm.dailyCapacity')}</label>
            <input
              id="setup-branch-capacity"
              type="number"
              min="0"
              className="dt-inline-input"
              value={draft.branch_capacity_per_day}
              onChange={(e) => setDraft((s) => ({ ...s, branch_capacity_per_day: e.target.value }))}
            />
          </>
        )}

        <label className="mono" htmlFor="setup-create-zone">{t('catalogProductContextSetup.productContextSetupForm.coverageZone')}</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="setup-create-zone"
            type="checkbox"
            checked={draft.create_zone}
            onChange={(e) => setDraft((s) => ({ ...s, create_zone: e.target.checked }))}
          />
          <span className="state__hint">{t('catalogProductContextSetup.productContextSetupForm.attachZoneCoverage')}</span>
        </label>
        {draft.create_zone && zones.length > 0 ? (
          <>
            <label className="mono" htmlFor="setup-zone">{t('catalogProductContextSetup.productContextSetupForm.zone')}</label>
            <select
              id="setup-zone"
              className="dt-inline-input"
              value={draft.zone_id}
              onChange={(e) => setDraft((s) => ({ ...s, zone_id: e.target.value }))}
            >
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>{zone.name}</option>
              ))}
            </select>
          </>
        ) : draft.create_zone ? (
          <>
            <label className="mono" htmlFor="setup-zone-name">{t('catalogProductContextSetup.productContextSetupForm.zoneName')}</label>
            <input
              id="setup-zone-name"
              className="dt-inline-input"
              value={draft.zone_name}
              onChange={(e) => setDraft((s) => ({ ...s, zone_name: e.target.value }))}
            />
            <label className="mono" htmlFor="setup-zone-color">{t('catalogProductContextSetup.productContextSetupForm.zoneColor')}</label>
            {zoneColorOptions.length > 0 ? (
              <select
                id="setup-zone-color"
                className="dt-inline-input"
                value={draft.zone_color_token}
                onChange={(e) => setDraft((s) => ({ ...s, zone_color_token: e.target.value }))}
              >
                <option value="">{t('catalogProductContextSetup.productContextSetupForm.noColorToken')}</option>
                {zoneColorOptions.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
              </select>
            ) : (
              <input
                id="setup-zone-color"
                className="dt-inline-input"
                value={draft.zone_color_token}
                onChange={(e) => setDraft((s) => ({ ...s, zone_color_token: e.target.value }))}
              />
            )}
          </>
        ) : null}

        <label className="mono" htmlFor="setup-offering-name">{t('catalogProductContextSetup.productContextSetupForm.offeringName')}</label>
        <input
          id="setup-offering-name"
          className="dt-inline-input"
          value={draft.offering_display_name}
          onChange={(e) => setDraft((s) => ({ ...s, offering_display_name: e.target.value }))}
        />
        <label className="mono" htmlFor="setup-offering-slug">{t('catalogProductContextSetup.productContextSetupForm.offeringSlug')}</label>
        <input
          id="setup-offering-slug"
          className="dt-inline-input"
          value={draft.offering_display_slug}
          onChange={(e) => setDraft((s) => ({ ...s, offering_display_slug: e.target.value }))}
        />
        <label className="mono" htmlFor="setup-offering-priority">{t('catalogProductContextSetup.productContextSetupForm.offeringPriority')}</label>
        <input
          id="setup-offering-priority"
          type="number"
          className="dt-inline-input"
          value={draft.offering_priority}
          onChange={(e) => setDraft((s) => ({ ...s, offering_priority: e.target.value }))}
        />
        <label className="mono" htmlFor="setup-offering-price">{t('catalogProductContextSetup.productContextSetupForm.basePrice')}</label>
        <input
          id="setup-offering-price"
          type="number"
          className="dt-inline-input"
          value={draft.offering_base_price}
          onChange={(e) => setDraft((s) => ({ ...s, offering_base_price: e.target.value }))}
        />
        <label className="mono" htmlFor="setup-offering-currency">{t('catalogProductContextSetup.productContextSetupForm.currency')}</label>
        <input
          id="setup-offering-currency"
          className="dt-inline-input"
          value={draft.offering_currency}
          onChange={(e) => setDraft((s) => ({ ...s, offering_currency: e.target.value.toUpperCase() }))}
        />
        <label className="mono" htmlFor="setup-offering-weight">{t('catalogProductContextSetup.productContextSetupForm.maxWeightKg')}</label>
        <input
          id="setup-offering-weight"
          type="number"
          className="dt-inline-input"
          value={draft.offering_max_weight_kg}
          onChange={(e) => setDraft((s) => ({ ...s, offering_max_weight_kg: e.target.value }))}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('catalogProductContextSetup.productContextSetupForm.cancel')} kind="ghost" onClick={onCancel} disabled={pending} />
        <Button
          label={pending ? t('catalogProductContextSetup.productContextSetupForm.provisioning') : t('catalogProductContextSetup.productContextSetupForm.provisionSetup')}
          kind="primary"
          capabilities={[CAP.SERVICE_OFFERINGS_WRITE, CAP.AGREEMENTS_WRITE, CAP.BRANCHES_WRITE]}
          disabled={pending}
          onClick={submit}
        />
      </div>
    </div>
  );
}
