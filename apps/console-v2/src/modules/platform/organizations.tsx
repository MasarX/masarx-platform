// organizations.tsx — organizations table + tenant_signup_requests queue.
//
// Approve / Reject buttons invoke the canonical browser-safe
// `tenant-signup-review` edge function through the queries.ts hook layer. That
// edge owns invite/auth-user creation before it applies
// `tenant_signup_review_apply_v1`, so Console V2 never calls the scalar
// SECURITY DEFINER RPC directly.
//
// A row-click drawer surfaces the submitted intake context — including the
// canonical `marketing` / `metadata.attestations` envelopes (terms accepted,
// privacy accepted, KYC documents, beneficial owner disclosure, Turnstile
// verification state) — plus the decision history populated when an operator
// applies an Approve / Reject decision (`reviewed_at`, `review_decision`,
// `review_reason`, `decision_metadata`).
//
// Capability gating: read = `tenant_signup_requests.read`,
// review (approve / reject) = `tenant_signup_requests.review`. Both keys
// are sourced from `supabase/migrations/202602201020_access_control_policy_tenant_signup_requests_v1.sql`.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useResourceList,
  useTenantSignupConsoleRequest,
  useTenantSignupReview,
  useUpdateOrganizationProfile,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { pushToast } from '@/components/toastStore';
import { getLookups, getSettingsCategories, lookupRow } from '@/lib/api';
import { readUrlParam } from '@/lib/url-params';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { fill, fillNodes, useI18n, type Translate } from '@/lib/i18n';

// W10-5 schema-drift remediation (PLATFORM §6) — applies the SCHEMA-DRIFT
// inventory verdict for `public.organizations`:
//   • RENAME `status` → `billing_status` (canonical column on organizations)
//   • REMOVE fictional `tenant_type` (no canonical column; legacy demo
//     attribute resolved via metadata/settings if needed). The seed retains
//     the legacy attribute as inert metadata; the row interface no longer
//     surfaces it.
// See __audit__/SCHEMA-DRIFT/PLATFORM.md §6.
interface OrgRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug?: string;
  timezone?: string;
  locale?: string;
  billing_status?: string;
  default_settings?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

interface OrgProfileSaveEvidence {
  savedAt: string;
  organizationId: string;
  organizationLabel: string;
  correlationId: string | null;
  settingsResolutionId: string | null;
  defaultKeys: string[];
}

// SignupRow mirrors public.tenant_signup_requests; we keep the demo aliases
// (`org_name`, `industry`, `size`, `received_at`) for the queue table while
// also surfacing the canonical schema fields for the drawer.
export interface TenantSignupRequestRow extends Record<string, unknown> {
  id: string;
  // Demo aliases used by the existing queue columns.
  org_name?: string;
  industry?: string;
  size?: string;
  received_at?: string;
  status?: string;
  // Canonical schema fields (drawer + RPC payload).
  organization_name?: string;
  organization_slug?: string;
  email?: string;
  full_name?: string;
  phone?: string;
  notes?: string;
  locale?: string;
  website_url?: string;
  page_url?: string;
  referrer?: string;
  origin?: string;
  marketing?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  turnstile_verified?: boolean;
  review_decision?: string | null;
  review_reason?: string | null;
  reviewed_at?: string | null;
  reviewed_by_label?: string | null;
  decision_metadata?: Record<string, unknown>;
  approved_organization_id?: string | null;
  approved_organization_label?: string | null;
  approved_user_id?: string | null;
  approved_user_email?: string | null;
  approved_auth_user_id?: string | null;
  invite_email_sent_at?: string | null;
  invite_redirect_to?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  last_error_at?: string | null;
  reviewer_label?: string | null;
  reviewer_email?: string | null;
  attestation_count?: number;
  attestation_passed_count?: number;
  attestation_complete?: boolean;
  has_marketing_consent?: boolean;
  decision_age_seconds?: number | null;
  is_pending?: boolean;
  is_approved?: boolean;
  is_rejected?: boolean;
  task_id?: string | null;
  approved_at?: string | null;
}

// W23 paired projection — public.v_tenant_signup_request_summary
// (supabase/migrations/202604302220_v_tenant_signup_request_summary.sql).
// Surfaces FE-shaped attestation rollups (count + passed_count +
// derived `attestation_complete` BOOLEAN that AND-folds turnstile),
// reviewer / approved-org / approved-user labels, status booleans, and
// `decision_age_seconds` so the drawer reads canonical projection
// counters instead of recomputing them from the metadata jsonb on the
// FE. Production cutover is a single getSupabaseClient() branch flip in
// `ui_list_resource_v1('tenant_signup_request_summary')`. The base
// `tenant_signup_requests` read seam is unchanged so the queue degrades
// gracefully when the projection cache has not yet hydrated.
export interface TenantSignupRequestSummaryRow extends Record<string, unknown> {
  id: string;                                // SSOT: tenant_signup_requests.id
  status: string;                            // SSOT: tenant_signup_requests.status
  review_decision: string | null;            // SSOT: tenant_signup_requests.review_decision
  email: string | null;                      // SSOT: tenant_signup_requests.email
  full_name: string | null;                  // SSOT: tenant_signup_requests.full_name
  organization_name: string | null;          // SSOT: tenant_signup_requests.organization_name
  organization_slug: string | null;          // SSOT: tenant_signup_requests.organization_slug
  reviewed_at: string | null;                // SSOT: tenant_signup_requests.reviewed_at
  reviewed_by: string | null;                // SSOT: tenant_signup_requests.reviewed_by
  reviewer_label: string | null;             // SSOT: projection — users.full_name via reviewed_by join
  reviewer_email: string | null;             // SSOT: projection — users.email via reviewed_by join
  approved_organization_id: string | null;   // SSOT: tenant_signup_requests.approved_organization_id
  approved_organization_label: string | null; // SSOT: projection — organizations.name via approved_organization_id join
  approved_user_id: string | null;           // SSOT: tenant_signup_requests.approved_user_id
  approved_auth_user_id: string | null;      // SSOT: tenant_signup_requests.approved_auth_user_id
  approved_user_email: string | null;        // SSOT: projection — users.email via approved_user_id join
  invite_email_sent_at: string | null;       // SSOT: tenant_signup_requests.invite_email_sent_at
  invite_redirect_to: string | null;         // SSOT: tenant_signup_requests.invite_redirect_to
  last_error_code: string | null;            // SSOT: tenant_signup_requests.last_error_code
  last_error_message: string | null;         // SSOT: tenant_signup_requests.last_error_message
  last_error_at: string | null;              // SSOT: tenant_signup_requests.last_error_at
  attestation_count: number;                 // SSOT: projection — count(metadata.attestations boolean keys)
  attestation_passed_count: number;          // SSOT: projection — count(metadata.attestations WHERE value=true)
  attestation_complete: boolean;             // SSOT: projection — attestation_count>0 AND all passed AND turnstile_verified
  has_marketing_consent: boolean;            // SSOT: projection — marketing.consent boolean (default false)
  is_pending: boolean;                       // SSOT: projection — status='pending'
  is_approved: boolean;                      // SSOT: projection — status='approved'
  is_rejected: boolean;                      // SSOT: projection — status='rejected'
  decision_age_seconds: number | null;       // SSOT: projection — extract(epoch from now()-reviewed_at) when reviewed
}

function orgColumns(t: Translate): DataTableColumn<OrgRow>[] {
  return [
    { key: 'name', label: t('platformOrganizations.organizationsModule.name'), sortable: true, filterable: true },
    { key: 'billing_status', label: t('platformOrganizations.organizationsModule.billing'), sortable: true, filterable: true },
    { key: 'created_at', label: t('platformOrganizations.organizationsModule.created'), format: 'datetime', sortable: true },
  ];
}

function signupColumns(t: Translate): DataTableColumn<TenantSignupRequestRow>[] {
  return [
    {
      key: 'organization_name',
      label: t('platformOrganizations.organizationsModule.organization'),
      sortable: true,
      filterable: true,
      render: (raw, row) => <span className="mono">{String(raw ?? row.org_name ?? '-')}</span>,
    },
    { key: 'email', label: t('platformOrganizations.organizationsModule.adminEmail'), mono: true, sortable: true, filterable: true },
    { key: 'full_name', label: t('platformOrganizations.organizationsModule.adminName'), sortable: true, filterable: true },
    {
      key: 'created_at',
      label: t('platformOrganizations.organizationsModule.received'),
      format: 'datetime',
      sortable: true,
      render: (raw, row) => String(raw ?? row.received_at ?? '-'),
    },
    { key: 'status', label: t('platformOrganizations.organizationsModule.status'), sortable: true, filterable: true },
  ];
}

// W50 — Signup-queue status filter chips derive from the canonical
// `tenant_signup_request_status` lookup (already registered in
// supabase/migrations/202602211145_tenant_signup_lookup_contracts_status_decision_v1.sql;
// W50 backend migration adds `metadata.tone`). `'all'` sentinel prepends the
// canonical values for the "show all" chip; if the lookup is empty, the chip
// toolbar surfaces a `<StateView kind="error" />` instead of degrading.
type StatusFilter = string;

const SIGNUP_QUEUE_REFETCH_INTERVAL_MS = 2_000;
const ORG_LOGO_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const ORG_LOGO_ACCEPT_ATTR = ORG_LOGO_ACCEPTED_TYPES.join(',');

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function prettyJson(value: unknown): string {
  const record = recordValue(value);
  return Object.keys(record).length > 0 ? JSON.stringify(record, null, 2) : '{\n}';
}

function parseDefaultSettingValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

function orgProfileDraftFromRow(row: OrgRow) {
  const defaultSettings = recordValue(row.default_settings);
  const branding = recordValue(defaultSettings.branding);
  return {
    name: row.name ?? '',
    timezone: row.timezone ?? '',
    locale: row.locale ?? '',
    logo_url: stringValue(branding.logo_url),
    primary_color: stringValue(branding.primary_color),
    secondary_color: stringValue(branding.secondary_color),
    backend_logo_file_name: stringValue(branding.logo_file_name),
    backend_logo_content_type: stringValue(branding.logo_content_type),
    backend_logo_artifact_id: stringValue(branding.logo_artifact_id),
    backend_logo_storage_bucket: stringValue(branding.logo_storage_bucket),
    backend_logo_storage_key: stringValue(branding.logo_storage_key),
    file_name: '',
    file_base64: '',
    content_type: '',
    quick_default_key: '',
    quick_default_value: '',
    default_settings_patch: prettyJson(
      Object.fromEntries(
        Object.entries(defaultSettings).filter(([key]) => key !== 'branding'),
      ),
    ),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Callers show the translated message; this code only stops the save.
    throw new Error('organization_defaults_not_object');
  }
  return parsed as Record<string, unknown>;
}

interface OrgDefaultKeyOption {
  value: string;
  label: string;
  domain?: string;
}

function labelFromSettingsCategory(category: string): string {
  return category
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeSettingsCategoryOption(row: Record<string, unknown>): OrgDefaultKeyOption | null {
  const value = typeof row.category === 'string' ? row.category.trim() : '';
  if (!value || value === 'branding') return null;
  return {
    value,
    label:
      typeof row.label === 'string' && row.label.trim()
        ? row.label.trim()
        : labelFromSettingsCategory(value),
    domain: typeof row.domain === 'string' && row.domain.trim() ? row.domain.trim() : undefined,
  };
}

function orgDefaultKeyOptions(
  defaultsPatch: string,
  settingsCategoryRows: Array<Record<string, unknown>>,
  t: Translate,
): OrgDefaultKeyOption[] {
  const merged = new Map<string, OrgDefaultKeyOption>();
  let current: Record<string, unknown> = {};
  try {
    current = parseJsonObject(defaultsPatch);
  } catch {
    current = {};
  }

  Object.keys(current)
    .filter((key) => key && key !== 'branding')
    .sort((a, b) => a.localeCompare(b))
    .forEach((key) => {
      merged.set(key, {
        value: key,
        label: labelFromSettingsCategory(key),
        domain: t('platformOrganizations.orgProfileForm.currentDefaults'),
      });
    });

  settingsCategoryRows
    .map(normalizeSettingsCategoryOption)
    .filter((row): row is OrgDefaultKeyOption => Boolean(row))
    .sort((a, b) => {
      const domainCompare = String(a.domain ?? '').localeCompare(String(b.domain ?? ''));
      return domainCompare || a.label.localeCompare(b.label);
    })
    .forEach((row) => {
      if (!merged.has(row.value)) merged.set(row.value, row);
    });

  return Array.from(merged.values());
}

function orgRowFromProfileReadback(
  current: OrgRow,
  result: Record<string, unknown>,
): OrgRow | null {
  const readback = recordValue(result.readback);
  if (Object.keys(readback).length === 0) return null;
  return {
    ...current,
    ...readback,
    id: stringValue(readback.id) || stringValue(readback.organization_id) || current.id,
    name: stringValue(readback.name) || current.name,
    timezone: stringValue(readback.timezone) || current.timezone,
    locale: stringValue(readback.locale) || current.locale,
    billing_status: stringValue(readback.billing_status) || current.billing_status,
    default_settings: recordValue(readback.default_settings),
    created_at: stringValue(readback.created_at) || current.created_at,
    updated_at: stringValue(readback.updated_at) || current.updated_at,
  };
}

function orgDefaultReadbackKeys(row: OrgRow): string[] {
  return Object.keys(recordValue(row.default_settings))
    .filter((key) => key && key !== 'branding')
    .sort((a, b) => a.localeCompare(b));
}

function orgProfileSaveEvidenceFromResult(
  row: OrgRow,
  result: Record<string, unknown>,
): OrgProfileSaveEvidence {
  return {
    savedAt: new Date().toLocaleTimeString(),
    organizationId: row.id,
    organizationLabel: row.name,
    correlationId: stringValue(result.correlation_id) || null,
    settingsResolutionId: stringValue(result.settings_resolution_id) || null,
    defaultKeys: orgDefaultReadbackKeys(row),
  };
}

function OrgProfileReadbackPanel({ evidence }: { evidence: OrgProfileSaveEvidence }) {
  const { t } = useI18n();
  return (
    <div className="state__hint" role="status" data-testid="org-profile-save-readback" style={{ padding: '8px 4px 0' }}>
      <div className="section-eyebrow">{t('platformOrganizations.orgProfileReadbackPanel.savedResult')}</div>
      <div className="kvgrid">
        <KvRow label={t('platformOrganizations.orgProfileReadbackPanel.organization')}>
          <span className="mono">{evidence.organizationLabel}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.orgProfileReadbackPanel.action')}>{t('platformOrganizations.orgProfileReadbackPanel.profileUpdateConfirmed')}</KvRow>
        <KvRow label={t('platformOrganizations.orgProfileReadbackPanel.confirmedFrom')}>{t('platformOrganizations.orgProfileReadbackPanel.savedOrganizationProfile')}</KvRow>
        <KvRow label={t('platformOrganizations.orgProfileReadbackPanel.requestTrail')}>{evidence.correlationId ? t('platformOrganizations.orgProfileReadbackPanel.recorded') : t('platformOrganizations.orgProfileReadbackPanel.notReturned')}</KvRow>
        <KvRow label={t('platformOrganizations.orgProfileReadbackPanel.settingsStatus')}>{evidence.settingsResolutionId ? t('platformOrganizations.orgProfileReadbackPanel.recorded') : t('platformOrganizations.orgProfileReadbackPanel.notReturned')}</KvRow>
        <KvRow label={t('platformOrganizations.orgProfileReadbackPanel.defaults')}>
          {evidence.defaultKeys.length > 0 ? evidence.defaultKeys.join(', ') : t('platformOrganizations.orgProfileReadbackPanel.noNonBrandingDefaults')}
        </KvRow>
        <KvRow label={t('platformOrganizations.orgProfileReadbackPanel.saved')}>{evidence.savedAt}</KvRow>
      </div>
    </div>
  );
}

function queryErrorHint(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

interface TenantConsoleRequestFormProps {
  pending: boolean;
  canReview: boolean;
  onCancel: () => void;
  onSubmit: (args: {
    email: string;
    full_name: string;
    organization_name: string;
    organization_slug?: string;
    website_url?: string;
    phone?: string;
    notes?: string;
    locale?: string;
  }) => Promise<void>;
}

type TenantConsoleRequestInput = Parameters<TenantConsoleRequestFormProps['onSubmit']>[0];

function TenantConsoleRequestForm({
  pending,
  canReview,
  onCancel,
  onSubmit,
}: TenantConsoleRequestFormProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({
    email: '',
    full_name: '',
    organization_name: '',
    organization_slug: '',
    website_url: '',
    phone: '',
    notes: '',
    locale: 'en',
  });
  const valid =
    draft.email.trim().length > 0 &&
    draft.full_name.trim().length > 0 &&
    draft.organization_name.trim().length > 0;

  return (
    <div data-testid="tenant-console-request-form">
      <div className="section-eyebrow">{t('platformOrganizations.tenantConsoleRequestForm.consoleTenantRequest')}</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '150px minmax(0, 1fr)',
          gap: 8,
          alignItems: 'center',
          padding: '0 4px',
        }}
      >
        <label className="mono" htmlFor="tenant-request-org">{t('platformOrganizations.tenantConsoleRequestForm.organization')}</label>
        <input
          id="tenant-request-org"
          className="dt-inline-input"
          value={draft.organization_name}
          onChange={(e) => setDraft((s) => ({ ...s, organization_name: e.target.value }))}
        />
        <label className="mono" htmlFor="tenant-request-slug">{t('platformOrganizations.tenantConsoleRequestForm.slug')}</label>
        <input
          id="tenant-request-slug"
          className="dt-inline-input"
          value={draft.organization_slug}
          onChange={(e) => setDraft((s) => ({ ...s, organization_slug: e.target.value }))}
        />
        <label className="mono" htmlFor="tenant-request-email">{t('platformOrganizations.tenantConsoleRequestForm.adminEmail')}</label>
        <input
          id="tenant-request-email"
          className="dt-inline-input"
          type="email"
          value={draft.email}
          onChange={(e) => setDraft((s) => ({ ...s, email: e.target.value }))}
        />
        <label className="mono" htmlFor="tenant-request-name">{t('platformOrganizations.tenantConsoleRequestForm.adminName')}</label>
        <input
          id="tenant-request-name"
          className="dt-inline-input"
          value={draft.full_name}
          onChange={(e) => setDraft((s) => ({ ...s, full_name: e.target.value }))}
        />
        <label className="mono" htmlFor="tenant-request-website">{t('platformOrganizations.tenantConsoleRequestForm.website')}</label>
        <input
          id="tenant-request-website"
          className="dt-inline-input"
          value={draft.website_url}
          onChange={(e) => setDraft((s) => ({ ...s, website_url: e.target.value }))}
        />
        <label className="mono" htmlFor="tenant-request-phone">{t('platformOrganizations.tenantConsoleRequestForm.phone')}</label>
        <input
          id="tenant-request-phone"
          className="dt-inline-input"
          value={draft.phone}
          onChange={(e) => setDraft((s) => ({ ...s, phone: e.target.value }))}
        />
        <label className="mono" htmlFor="tenant-request-locale">{t('platformOrganizations.tenantConsoleRequestForm.locale')}</label>
        <input
          id="tenant-request-locale"
          className="dt-inline-input"
          value={draft.locale}
          onChange={(e) => setDraft((s) => ({ ...s, locale: e.target.value }))}
        />
        <label className="mono" htmlFor="tenant-request-notes">{t('platformOrganizations.tenantConsoleRequestForm.notes')}</label>
        <textarea
          id="tenant-request-notes"
          className="dt-inline-input"
          rows={3}
          value={draft.notes}
          onChange={(e) => setDraft((s) => ({ ...s, notes: e.target.value }))}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('platformOrganizations.tenantConsoleRequestForm.cancel')} kind="ghost" onClick={onCancel} />
        <Button
          label={t('platformOrganizations.tenantConsoleRequestForm.createRequest')}
          iconName="plus"
          kind="primary"
          capability={CAP.TENANT_SIGNUP_REQUESTS_REVIEW}
          disabled={!canReview || pending || !valid}
          onClick={() =>
            onSubmit({
              email: draft.email.trim(),
              full_name: draft.full_name.trim(),
              organization_name: draft.organization_name.trim(),
              organization_slug: draft.organization_slug.trim() || undefined,
              website_url: draft.website_url.trim() || undefined,
              phone: draft.phone.trim() || undefined,
              notes: draft.notes.trim() || undefined,
              locale: draft.locale.trim() || undefined,
            })
          }
        />
      </div>
    </div>
  );
}

interface OrgProfileFormProps {
  row: OrgRow;
  canWrite: boolean;
  pending: boolean;
  onCancel: () => void;
  onOpenReadiness: () => void;
  onOpenSettings: () => void;
  onOpenUsers: () => void;
  onOpenAccess: () => void;
  onSubmit: (args: {
    organization_id: string;
    name: string;
    timezone: string;
    locale: string;
    logo_url?: string;
    primary_color?: string;
    secondary_color?: string;
    file_name?: string;
    file_base64?: string;
    content_type?: string;
    default_settings_patch?: Record<string, unknown>;
  }) => Promise<void>;
}

function OrgProfileForm({
  row,
  canWrite,
  pending,
  onCancel,
  onOpenReadiness,
  onOpenSettings,
  onOpenUsers,
  onOpenAccess,
  onSubmit,
}: OrgProfileFormProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => orgProfileDraftFromRow(row));
  const [fileError, setFileError] = useState<string>('');
  const [settingsError, setSettingsError] = useState<string>('');
  const settingsCategoriesQuery = useResourceList<Record<string, unknown>>('settings_category_registry', {
    page_size: 500,
    sort: { key: 'category', dir: 'asc' },
  });
  const defaultKeyOptions = useMemo(() => {
    const liveRows = settingsCategoriesQuery.data?.rows ?? [];
    const rows = liveRows.length > 0
      ? liveRows
      : ((getSettingsCategories() as Array<Record<string, unknown>>) || []);
    return orgDefaultKeyOptions(draft.default_settings_patch, rows, t);
  }, [draft.default_settings_patch, settingsCategoriesQuery.data, t]);

  useEffect(() => {
    setDraft(orgProfileDraftFromRow(row));
    setFileError('');
    setSettingsError('');
  }, [row]);

  const valid =
    draft.name.trim().length > 0 &&
    draft.timezone.trim().length > 0 &&
    draft.locale.trim().length > 0;
  const controlsDisabled = !canWrite || pending;

  return (
    <div data-testid="org-profile-form">
      <div className="section-eyebrow">{t('platformOrganizations.orgProfileForm.organizationProfile')}</div>
      <div
        data-testid="org-profile-lifecycle-actions"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 4px 14px' }}
      >
        <Button label={t('platformOrganizations.orgProfileForm.readiness')} iconName="check" kind="ghost" onClick={onOpenReadiness} />
        <Button label={t('platformOrganizations.orgProfileForm.settings')} iconName="settings" kind="ghost" onClick={onOpenSettings} />
        <Button label={t('platformOrganizations.orgProfileForm.users')} iconName="users" kind="ghost" onClick={onOpenUsers} />
        <Button label={t('platformOrganizations.orgProfileForm.access')} iconName="shield" kind="ghost" onClick={onOpenAccess} />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '140px minmax(0, 1fr)',
          gap: 8,
          alignItems: 'center',
          padding: '0 4px',
        }}
      >
        <label className="mono" htmlFor="org-profile-name">{t('platformOrganizations.orgProfileForm.name')}</label>
        <input
          id="org-profile-name"
          className="dt-inline-input"
          value={draft.name}
          disabled={controlsDisabled}
          onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
        />
        <label className="mono" htmlFor="org-profile-timezone">{t('platformOrganizations.orgProfileForm.timezone')}</label>
        <input
          id="org-profile-timezone"
          className="dt-inline-input"
          value={draft.timezone}
          disabled={controlsDisabled}
          onChange={(e) => setDraft((s) => ({ ...s, timezone: e.target.value }))}
        />
        <label className="mono" htmlFor="org-profile-locale">{t('platformOrganizations.orgProfileForm.locale')}</label>
        <input
          id="org-profile-locale"
          className="dt-inline-input"
          value={draft.locale}
          disabled={controlsDisabled}
          onChange={(e) => setDraft((s) => ({ ...s, locale: e.target.value }))}
        />
        <label className="mono" htmlFor="org-profile-logo-url">{t('platformOrganizations.orgProfileForm.logoUrl')}</label>
        <input
          id="org-profile-logo-url"
          className="dt-inline-input"
          value={draft.logo_url}
          disabled={controlsDisabled}
          onChange={(e) => setDraft((s) => ({ ...s, logo_url: e.target.value }))}
        />
        <label className="mono" htmlFor="org-profile-logo-file">{t('platformOrganizations.orgProfileForm.logoFile')}</label>
        <input
          id="org-profile-logo-file"
          className="dt-inline-input"
          type="file"
          accept={ORG_LOGO_ACCEPT_ATTR}
          disabled={controlsDisabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setFileError('');
            if (!file) {
              setDraft((s) => ({ ...s, file_name: '', file_base64: '', content_type: '' }));
              return;
            }
            if (!ORG_LOGO_ACCEPTED_TYPES.includes(file.type as (typeof ORG_LOGO_ACCEPTED_TYPES)[number])) {
              e.currentTarget.value = '';
              setDraft((s) => ({ ...s, file_name: '', file_base64: '', content_type: '' }));
              setFileError(t('platformOrganizations.orgProfileForm.logoFileMustBe'));
              return;
            }
            void readFileAsDataUrl(file)
              .then((dataUrl) => {
                setDraft((s) => ({
                  ...s,
                  file_name: file.name,
                  file_base64: dataUrl,
                  content_type: file.type || 'application/octet-stream',
                }));
              })
              .catch(() => setFileError(t('platformOrganizations.orgProfileForm.logoFileCouldNot')));
          }}
        />
        <label className="mono" htmlFor="org-profile-primary-color">{t('platformOrganizations.orgProfileForm.primaryColor')}</label>
        <input
          id="org-profile-primary-color"
          className="dt-inline-input"
          value={draft.primary_color}
          disabled={controlsDisabled}
          onChange={(e) => setDraft((s) => ({ ...s, primary_color: e.target.value }))}
          placeholder="#0f766e"
        />
        <label className="mono" htmlFor="org-profile-secondary-color">{t('platformOrganizations.orgProfileForm.secondaryColor')}</label>
        <input
          id="org-profile-secondary-color"
          className="dt-inline-input"
          value={draft.secondary_color}
          disabled={controlsDisabled}
          onChange={(e) => setDraft((s) => ({ ...s, secondary_color: e.target.value }))}
          placeholder={t('platformOrganizations.orgProfileForm.n1d4ed8')}
        />
        <label className="mono" htmlFor="org-profile-default-key">{t('platformOrganizations.orgProfileForm.defaultKeyLookup')}</label>
        <select
          id="org-profile-default-key"
          className="dt-inline-input"
          value={draft.quick_default_key}
          disabled={controlsDisabled}
          onChange={(e) => {
            setSettingsError('');
            setDraft((s) => ({ ...s, quick_default_key: e.target.value }));
          }}
        >
          <option value="">{t('platformOrganizations.orgProfileForm.chooseADefaultKey')}</option>
          {defaultKeyOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.domain ? `${option.label} - ${option.domain}` : option.label}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="org-profile-default-value">{t('platformOrganizations.orgProfileForm.defaultValue')}</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
          <input
            id="org-profile-default-value"
            className="dt-inline-input"
            value={draft.quick_default_value}
            disabled={controlsDisabled}
            onChange={(e) => {
              setSettingsError('');
              setDraft((s) => ({ ...s, quick_default_value: e.target.value }));
            }}
            placeholder={t('platformOrganizations.orgProfileForm.text')}
          />
          <Button
            label={t('platformOrganizations.orgProfileForm.applyDefault')}
            iconName="plus"
            kind="ghost"
            capability={CAP.ORGANIZATIONS_WRITE}
            disabled={controlsDisabled || !draft.quick_default_key.trim()}
            onClick={() => {
              const key = draft.quick_default_key.trim();
              if (!key) {
                setSettingsError(t('platformOrganizations.orgProfileForm.defaultKeyIsRequired'));
                return;
              }
              if (key === 'branding') {
                setSettingsError(t('platformOrganizations.orgProfileForm.brandingDefaultsUseThe'));
                return;
              }
              let current: Record<string, unknown>;
              try {
                current = parseJsonObject(draft.default_settings_patch);
              } catch {
                setSettingsError(t('platformOrganizations.orgProfileForm.organizationDefaultsMustBe'));
                return;
              }
              const next = {
                ...current,
                [key]: parseDefaultSettingValue(draft.quick_default_value),
              };
              setDraft((s) => ({
                ...s,
                quick_default_key: '',
                quick_default_value: '',
                default_settings_patch: prettyJson(next),
              }));
              setSettingsError('');
            }}
          />
        </div>
        <label className="mono" htmlFor="org-profile-defaults">{t('platformOrganizations.orgProfileForm.defaultsPatch')}</label>
        <textarea
          id="org-profile-defaults"
          className="dt-inline-input"
          rows={7}
          value={draft.default_settings_patch}
          disabled={controlsDisabled}
          onChange={(e) => {
            setSettingsError('');
            setDraft((s) => ({ ...s, default_settings_patch: e.target.value }));
          }}
          spellCheck={false}
        />
      </div>
      {fileError ? (
        <StateView kind="error" hint={fileError} />
      ) : null}
      {settingsError ? (
        <StateView kind="error" hint={settingsError} />
      ) : null}
      {draft.file_name ? (
        <div className="state__hint" style={{ padding: '8px 4px 0' }}>
          {t('platformOrganizations.orgProfileForm.selectedLogo')} <span className="mono">{draft.file_name}</span>
        </div>
      ) : null}
      {!draft.file_name && (draft.backend_logo_file_name || draft.backend_logo_artifact_id || draft.backend_logo_storage_key) ? (
        <div
          className="state__hint"
          data-testid="org-profile-logo-readback"
          role="status"
          style={{ padding: '8px 4px 0' }}
        >
          {t('platformOrganizations.orgProfileForm.savedLogo')}{' '}
          <span className="mono">
            {draft.backend_logo_file_name || t('platformOrganizations.orgProfileForm.fileRecorded')}
            {draft.backend_logo_content_type ? ` · ${draft.backend_logo_content_type}` : ''}
          </span>
        </div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('platformOrganizations.orgProfileForm.cancel')} kind="ghost" onClick={onCancel} />
        <Button
          label={t('platformOrganizations.orgProfileForm.saveProfile')}
          iconName="upload"
          kind="primary"
          capability={CAP.ORGANIZATIONS_WRITE}
          disabled={controlsDisabled || !valid || Boolean(fileError)}
          onClick={() => {
            let defaultSettingsPatch: Record<string, unknown>;
            try {
              defaultSettingsPatch = parseJsonObject(draft.default_settings_patch);
            } catch {
              setSettingsError(t('platformOrganizations.orgProfileForm.organizationDefaultsMustBe'));
              return;
            }
            defaultSettingsPatch = {
              ...defaultSettingsPatch,
              branding: {
                ...recordValue(defaultSettingsPatch.branding),
                logo_url: draft.logo_url.trim() || null,
                primary_color: draft.primary_color.trim() || null,
                secondary_color: draft.secondary_color.trim() || null,
              },
            };
            void onSubmit({
              organization_id: row.id,
              name: draft.name.trim(),
              timezone: draft.timezone.trim(),
              locale: draft.locale.trim(),
              logo_url: draft.logo_url.trim() || undefined,
              primary_color: draft.primary_color.trim() || undefined,
              secondary_color: draft.secondary_color.trim() || undefined,
              file_name: draft.file_name || undefined,
              file_base64: draft.file_base64 || undefined,
              content_type: draft.content_type || undefined,
              default_settings_patch: defaultSettingsPatch,
            });
          }}
        />
      </div>
    </div>
  );
}

// Render a `key → value` pair into a single .kvgrid__row. The component is
// kept inline to avoid a new file; the seed-row drawer is a leaf surface.
function KvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kvgrid__row">
      <span className="kvgrid__key mono">{label}</span>
      <span className="kvgrid__val">{children}</span>
    </div>
  );
}

function intakeContextLabel(key: string, t: Translate): string {
  const overrides: Record<string, string> = {
    utm_source: t('platformOrganizations.signupDrawerBody.campaignSource'),
    utm_campaign: t('platformOrganizations.signupDrawerBody.campaign'),
    utm_medium: t('platformOrganizations.signupDrawerBody.channel'),
    referrer: t('platformOrganizations.signupDrawerBody.referrer'),
    source: t('platformOrganizations.signupDrawerBody.source'),
    locale: t('platformOrganizations.signupDrawerBody.intakeLocale'),
    ip: t('platformOrganizations.signupDrawerBody.ipAddress'),
    user_agent: t('platformOrganizations.signupDrawerBody.browser'),
  };
  return overrides[key] ?? key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function intakeContextValue(value: unknown, t: Translate): string {
  if (value == null || value === '') return t('platformOrganizations.signupDrawerBody.notProvided');
  if (typeof value === 'boolean') return value ? t('platformOrganizations.signupDrawerBody.yes') : t('platformOrganizations.signupDrawerBody.no');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.replace(/[_-]+/g, ' ');
  if (Array.isArray(value)) {
    return fill(t(value.length === 1 ? 'platformOrganizations.signupDrawerBody.itemOne' : 'platformOrganizations.signupDrawerBody.itemOther'), { count: value.length });
  }
  if (typeof value === 'object') {
    const size = Object.keys(value as Record<string, unknown>).length;
    return fill(t(size === 1 ? 'platformOrganizations.signupDrawerBody.detailOne' : 'platformOrganizations.signupDrawerBody.detailOther'), { count: size });
  }
  return String(value);
}

function provisionedReference(value: unknown, kind: 'organization' | 'user', t: Translate): string {
  const token = String(value ?? '').trim();
  if (!token) return t('platformOrganizations.signupDrawerBody.notRecorded');
  const short = token.replace(/-/g, '').slice(-6).toUpperCase();
  if (kind === 'organization') {
    return short
      ? fill(t('platformOrganizations.signupDrawerBody.organizationReadyRef'), { ref: short })
      : t('platformOrganizations.signupDrawerBody.organizationReady');
  }
  return short
    ? fill(t('platformOrganizations.signupDrawerBody.provisionedUserReadyRef'), { ref: short })
    : t('platformOrganizations.signupDrawerBody.provisionedUserReady');
}

function compactStatusDetail(value: unknown, t: Translate): string {
  const text = String(value ?? '').trim();
  if (!text) return t('platformOrganizations.signupDrawerBody.notRecorded');
  return text;
}

interface RejectReasonFormProps {
  count: number;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}

function RejectReasonForm({ count, pending, onCancel, onSubmit }: RejectReasonFormProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <div data-testid="tenant-signup-reject-form">
      <div className="section-eyebrow">{t('platformOrganizations.rejectReasonForm.rejectTenantRequest')}</div>
      <p className="state__hint" style={{ padding: '0 4px 10px' }}>
        {t('platformOrganizations.rejectReasonForm.captureTheDecisionReason')}
      </p>
      <label className="mono" htmlFor="tenant-signup-reject-reason">
        {t('platformOrganizations.rejectReasonForm.reason')}
      </label>
      <textarea
        id="tenant-signup-reject-reason"
        className="dt-inline-input"
        rows={4}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ marginTop: 6 }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('platformOrganizations.rejectReasonForm.cancel')} kind="ghost" onClick={onCancel} disabled={pending} />
        <Button
          label={count > 1 ? fill(t('platformOrganizations.rejectReasonForm.rejectRequests'), { count: String(count) }) : t('platformOrganizations.rejectReasonForm.rejectRequest')}
          iconName="close"
          kind="danger"
          capability={CAP.TENANT_SIGNUP_REQUESTS_REVIEW}
          disabled={pending || trimmed.length === 0}
          onClick={() => onSubmit(trimmed)}
        />
      </div>
    </div>
  );
}

function IntakeContextGrid({
  values,
  emptyText,
  testId,
}: {
  values: Record<string, unknown>;
  emptyText: string;
  testId: string;
}) {
  const { t } = useI18n();
  const entries = Object.entries(values).filter(([, value]) => value != null && value !== '');
  if (entries.length === 0) {
    return <div className="state__hint" data-testid={testId}>{emptyText}</div>;
  }
  return (
    <div className="kvgrid" data-testid={testId}>
      {entries.map(([key, value]) => (
        <KvRow key={key} label={intakeContextLabel(key, t)}>
          <span>{intakeContextValue(value, t)}</span>
        </KvRow>
      ))}
    </div>
  );
}

function AttestationChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip
      size="xs"
      kind={ok ? 'good' : 'warn'}
      label={`${label} ${ok ? '✓' : '⚠'}`}
    />
  );
}

interface SignupDrawerProps {
  row: TenantSignupRequestRow;
  summary?: TenantSignupRequestSummaryRow;
  canReview: boolean;
  reviewFailure?: TenantSignupReviewFailure | null;
  existingOrganizations: OrgRow[];
  onApprove: (options?: { approvedExistingOrganizationId?: string | null }) => void;
  onReject: () => void;
  onOpenReadiness: (organizationId: string) => void;
  onOpenUserAccess: (organizationId: string, focus: string | null) => void;
  pending: boolean;
}

interface TenantSignupReviewFailure {
  requestId: string;
  message: string;
  status?: string | null;
  summary?: TenantSignupRequestSummaryRow | null;
}

function SignupDrawerBody({
  row,
  summary,
  canReview,
  reviewFailure,
  existingOrganizations,
  onApprove,
  onReject,
  onOpenReadiness,
  onOpenUserAccess,
  pending,
}: SignupDrawerProps) {
  const { t } = useI18n();
  const approveActivationRef = useRef(false);
  const [approvedExistingOrganizationId, setApprovedExistingOrganizationId] = useState('');
  const marketing = (row.marketing ?? {}) as Record<string, unknown>;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const attestationsRaw = (metadata['attestations'] ?? {}) as Record<string, unknown>;
  const decisionMeta = (row.decision_metadata ?? {}) as Record<string, unknown>;
  const approvedOrgId = row.approved_organization_id ?? summary?.approved_organization_id ?? null;
  const approvedUserId = row.approved_user_id ?? summary?.approved_user_id ?? null;
  const approvedAuthUserId = row.approved_auth_user_id ?? summary?.approved_auth_user_id ?? null;
  const inviteEmailSentAt = row.invite_email_sent_at ?? summary?.invite_email_sent_at ?? null;
  const inviteRedirectTo = row.invite_redirect_to ?? summary?.invite_redirect_to ?? null;
  const lastErrorCode = row.last_error_code ?? summary?.last_error_code ?? null;
  const lastErrorMessage = row.last_error_message ?? summary?.last_error_message ?? null;
  const lastErrorAt = row.last_error_at ?? summary?.last_error_at ?? null;
  const reviewerLabel =
    row.reviewed_by_label
    ?? row.reviewer_label
    ?? summary?.reviewer_label
    ?? summary?.reviewer_email
    ?? null;
  useEffect(() => {
    if (!pending) {
      approveActivationRef.current = false;
    }
  }, [pending]);
  const runApprove = () => {
    if (approveActivationRef.current) return;
    approveActivationRef.current = true;
    onApprove({ approvedExistingOrganizationId: approvedExistingOrganizationId || null });
  };

  // W71-Platform (Cycle F-R-11) closure — `?? 'pending'` synthesis is
  // replaced by reading the canonical `_default` row (is_default=true) on
  // `tenant_signup_request_status`. Terminal-state derivation flows through
  // `metadata.is_terminal` instead of inline `'approved'|'rejected'`
  // literal compares. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6
  // (row-driven by configuration).
  const tenantSignupDefaultStatus =
    (getLookups('tenant_signup_request_status') as Array<{ value: string; is_default?: boolean }>)
      .find((r) => r.is_default)?.value ?? null;
  const status = (row.status ?? tenantSignupDefaultStatus ?? '').toString().toLowerCase();
  const reviewed =
    !!row.reviewed_at ||
    !!row.review_decision ||
    lookupRow('tenant_signup_request_status', status)?.metadata?.is_terminal === true;
  const existingOrganizationOptions = useMemo(
    () => existingOrganizations
      .filter((org) => Boolean(org.id))
      .map((org) => ({
        id: org.id,
        label: org.slug ? `${org.name || org.slug} - ${org.slug}` : org.name || org.id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [existingOrganizations],
  );

  // Iterate ALL attestation keys so the drawer surfaces the full envelope —
  // never hardcoded to a fixed key list (zero-redundancy + zero-hardcoding).
  const attestationKeys = Object.keys(attestationsRaw);

  return (
    <div data-testid="org-signup-drawer">
      <div className="section-eyebrow">{t('platformOrganizations.signupDrawerBody.signupIntake')}</div>
      <div className="kvgrid">
        <KvRow label={t('platformOrganizations.signupDrawerBody.organization')}>
          <span className="mono">{row.organization_name ?? row.org_name ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.slug')}>
          <span className="mono">{row.organization_slug ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.contact')}>
          <span className="mono">{row.email ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.name')}>
          <span>{row.full_name ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.phone')}>
          <span className="mono">{row.phone ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.industry')}>
          <span>{row.industry ?? (metadata['industry'] as string) ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.size')}>
          <span>{row.size ?? (metadata['org_size'] as string) ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.received')}>
          <span className="mono">{row.received_at ?? '—'}</span>
        </KvRow>
        <KvRow label={t('platformOrganizations.signupDrawerBody.status')}>
          <Chip
            size="xs"
            kind={(lookupRow('tenant_signup_request_status', status)?.tone as ChipKind | undefined) ?? 'warn'}
            label={status}
          />
        </KvRow>
      </div>

      <div className="section-eyebrow">{t('platformOrganizations.signupDrawerBody.attestations')}</div>
      <div
        data-testid="org-signup-attestations"
        style={{ padding: '4px 14px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}
      >
        {attestationKeys.length === 0 ? (
          <span className="state__hint">{t('platformOrganizations.signupDrawerBody.noAttestationEnvelopeOn')}</span>
        ) : (
          attestationKeys.map((k) => (
            <AttestationChip
              key={k}
              ok={Boolean(attestationsRaw[k])}
              label={k.replace(/_/g, ' ')}
            />
          ))
        )}
        <AttestationChip
          ok={Boolean(row.turnstile_verified ?? metadata['turnstile_verified'])}
          label={t('platformOrganizations.signupDrawerBody.turnstileVerified')}
        />
      </div>

      {/*
        W23 paired projection — render the canonical
        `v_tenant_signup_request_summary` rollups as compact chips when the
        projection row is available. The chips display BE-derived counters
        (attestation_count / attestation_passed_count / attestation_complete /
        decision_age_seconds) rather than recomputing them on the FE so the
        operator-visible numbers stay 1:1 with the canonical SSOT view. The
        chip surface degrades gracefully when the projection cache has not
        yet hydrated (no chips rendered, queue table still works).
      */}
      {summary ? (
        <div
          data-testid="org-signup-summary-chips"
          style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}
        >
          <Chip
            size="xs"
            kind="info"
            label={fill(t('platformOrganizations.signupDrawerBody.attestations2'), { attestation_passed_count: String(summary.attestation_passed_count), attestation_count: String(summary.attestation_count) })}
            data-testid="org-signup-summary-attestation-count"
          />
          <Chip
            size="xs"
            kind={summary.attestation_complete ? 'good' : 'warn'}
            label={summary.attestation_complete ? t('platformOrganizations.signupDrawerBody.attestationComplete') : t('platformOrganizations.signupDrawerBody.attestationIncomplete')}
            data-testid="org-signup-summary-attestation-complete"
          />
          {summary.has_marketing_consent ? (
            <Chip
              size="xs"
              kind="info"
              label={t('platformOrganizations.signupDrawerBody.marketingConsent')}
              data-testid="org-signup-summary-marketing-consent"
            />
          ) : null}
          {summary.reviewer_label ? (
            <Chip
              size="xs"
              kind="neutral"
              label={fillNodes(t('platformOrganizations.signupDrawerBody.reviewer'), { reviewer_label: <bdi>{String(summary.reviewer_label)}</bdi> })}
              data-testid="org-signup-summary-reviewer-label"
            />
          ) : null}
          {summary.approved_organization_label ? (
            <Chip
              size="xs"
              kind="good"
              label={fillNodes(t('platformOrganizations.signupDrawerBody.provisioned'), { approved_organization_label: <bdi>{String(summary.approved_organization_label)}</bdi> })}
              data-testid="org-signup-summary-approved-org-label"
            />
          ) : null}
          {summary.decision_age_seconds != null ? (
            <Chip
              size="xs"
              kind="neutral"
              label={fill(t('platformOrganizations.signupDrawerBody.decisionAgeS'), { decision_age_seconds: String(summary.decision_age_seconds) })}
              data-testid="org-signup-summary-decision-age"
            />
          ) : null}
        </div>
      ) : null}

      <div className="section-eyebrow">{t('platformOrganizations.signupDrawerBody.marketingContext')}</div>
      <IntakeContextGrid
        values={marketing}
        emptyText={t('platformOrganizations.signupDrawerBody.noMarketingContextWas')}
        testId="org-signup-marketing"
      />

      <div className="section-eyebrow">{t('platformOrganizations.signupDrawerBody.decisionHistory')}</div>
      <div data-testid="org-signup-decision-history">
        {!reviewed ? (
          <div className="state__hint" style={{ padding: '4px 14px 12px' }}>
            {t('platformOrganizations.signupDrawerBody.pendingReviewUseApprove')}
            <span className="mono"> {t('platformOrganizations.signupDrawerBody.tenantReview')}</span>.
          </div>
        ) : (
          <div className="kvgrid">
            <KvRow label={t('platformOrganizations.signupDrawerBody.decision')}>
              <Chip
                size="xs"
                kind={(lookupRow('tenant_signup_request_status', row.review_decision ?? status)?.tone as ChipKind | undefined) ?? 'warn'}
                label={String(row.review_decision ?? status)}
              />
            </KvRow>
            <KvRow label={t('platformOrganizations.signupDrawerBody.reviewedAt')}>
              <span className="mono">
                {row.reviewed_at ?? row.approved_at ?? '—'}
              </span>
            </KvRow>
            <KvRow label={t('platformOrganizations.signupDrawerBody.reviewerName')}>
              <span className="mono">{reviewerLabel ?? '—'}</span>
            </KvRow>
            <KvRow label={t('platformOrganizations.signupDrawerBody.reason')}>
              <span>{row.review_reason ?? '—'}</span>
            </KvRow>
            {approvedOrgId ? (
              <KvRow label={t('platformOrganizations.signupDrawerBody.provisionedOrg')}>
                <span>{provisionedReference(approvedOrgId, 'organization', t)}</span>
              </KvRow>
            ) : null}
            {approvedUserId ? (
              <KvRow label={t('platformOrganizations.signupDrawerBody.provisionedUser')}>
                <span>
                  {summary?.approved_user_email
                    ? fill(t('platformOrganizations.signupDrawerBody.userReady'), { approved_user_email: String(summary.approved_user_email) })
                    : provisionedReference(approvedUserId, 'user', t)}
                </span>
              </KvRow>
            ) : null}
          </div>
        )}
        {Object.keys(decisionMeta).length > 0 ? (
          <IntakeContextGrid
            values={decisionMeta}
            emptyText={t('platformOrganizations.signupDrawerBody.noAdditionalDecisionNotes')}
            testId="org-signup-decision-metadata"
          />
        ) : null}
      </div>

      {reviewed ? (
        <>
          <div
            className="section-eyebrow"
            style={{ marginTop: 8 }}
          >
            {t('platformOrganizations.signupDrawerBody.activationAndInvite')}
          </div>
          <div className="kvgrid" data-testid="org-signup-activation-status">
            <KvRow label={t('platformOrganizations.signupDrawerBody.inviteEmail')}>
              {lastErrorMessage ? (
                <Chip size="xs" kind="danger" label={t('platformOrganizations.signupDrawerBody.inviteFailed')} />
              ) : inviteEmailSentAt ? (
                <span className="mono">{fillNodes(t('platformOrganizations.signupDrawerBody.sent'), { inviteEmailSentAt: <bdi>{String(inviteEmailSentAt)}</bdi> })}</span>
              ) : approvedAuthUserId ? (
                <Chip size="xs" kind="info" label={t('platformOrganizations.signupDrawerBody.authUserReady')} />
              ) : (
                <span className="state__hint">{t('platformOrganizations.signupDrawerBody.notRecorded')}</span>
              )}
            </KvRow>
            <KvRow label={t('platformOrganizations.signupDrawerBody.inviteRedirect')}>
              <span className="mono">{compactStatusDetail(inviteRedirectTo, t)}</span>
            </KvRow>
            <KvRow label={t('platformOrganizations.signupDrawerBody.authUser')}>
              <span>{provisionedReference(approvedAuthUserId, 'user', t)}</span>
            </KvRow>
            {lastErrorMessage ? (
              <KvRow label={t('platformOrganizations.signupDrawerBody.lastInviteError')}>
                <span>
                  {lastErrorCode ? `${lastErrorCode} · ` : ''}
                  {lastErrorMessage}
                  {lastErrorAt ? ` · ${lastErrorAt}` : ''}
                </span>
              </KvRow>
            ) : null}
          </div>
          {approvedOrgId ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 14px 12px', flexWrap: 'wrap' }}>
              <Button
                label={t('platformOrganizations.signupDrawerBody.openUserAccess')}
                iconName="user_in"
                kind="ghost"
                onClick={() => onOpenUserAccess(approvedOrgId, approvedUserId ?? summary?.approved_user_email ?? row.approved_user_email ?? null)}
              />
              <Button
                label={t('platformOrganizations.signupDrawerBody.openReadiness')}
                iconName="check"
                kind="ghost"
                onClick={() => onOpenReadiness(approvedOrgId)}
              />
            </div>
          ) : null}
        </>
      ) : null}

      <div
        className="section-eyebrow"
        style={{ marginTop: 8 }}
      >
        {t('platformOrganizations.signupDrawerBody.reviewActions')}
      </div>
      {!reviewed && canReview && existingOrganizationOptions.length > 0 ? (
        <div className="kvgrid" data-testid="org-signup-existing-org-link">
          <KvRow label={t('platformOrganizations.signupDrawerBody.existingOrganizationLink')}>
            <select
              aria-label={t('platformOrganizations.signupDrawerBody.existingOrganizationLink')}
              className="input"
              value={approvedExistingOrganizationId}
              disabled={pending}
              onChange={(event) => setApprovedExistingOrganizationId(event.target.value)}
            >
              <option value="">{t('platformOrganizations.signupDrawerBody.provisionNewOrganization')}</option>
              {existingOrganizationOptions.map((org) => (
                <option key={org.id} value={org.id}>{org.label}</option>
              ))}
            </select>
          </KvRow>
        </div>
      ) : null}
      {reviewFailure ? (
        <div
          className="state state--error"
          data-testid="org-signup-review-failure"
          style={{ margin: '6px 14px 4px' }}
        >
          <div className="state__title">{t('platformOrganizations.signupDrawerBody.reviewBlocked')}</div>
          <div className="state__hint">{reviewFailure.message}</div>
          <div style={{ marginTop: 6 }}>
            {t('platformOrganizations.signupDrawerBody.requestRecorded')}
          </div>
          <div className="mono" style={{ marginTop: 4 }}>
            {fill(t('platformOrganizations.signupDrawerBody.reviewStatus'), { value: String(reviewFailure.status ?? row.status ?? t('platformOrganizations.signupDrawerBody.unknown')) })}
          </div>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, padding: '6px 14px 16px' }}>
        <Button
          label={t('platformOrganizations.signupDrawerBody.approveRequest')}
          iconName="check"
          kind="primary"
          capability={CAP.TENANT_SIGNUP_REQUESTS_REVIEW}
          disabled={!canReview || reviewed || pending}
          onClick={runApprove}
        />
        <Button
          label={t('platformOrganizations.signupDrawerBody.reject')}
          iconName="close"
          kind="danger"
          capability={CAP.TENANT_SIGNUP_REQUESTS_REVIEW}
          disabled={!canReview || reviewed || pending}
          onClick={onReject}
        />
      </div>
    </div>
  );
}

export function OrganizationsModule() {
  const { t } = useI18n();
  const orgTableColumns = useMemo(() => orgColumns(t), [t]);
  const signupTableColumns = useMemo(() => signupColumns(t), [t]);
  const identity = useIdentity();
  const go = useConsoleNavigator();
  const canReadOrgs = useCapability(CAP.ORGANIZATIONS_READ);
  const canWriteOrgs = useCapability(CAP.ORGANIZATIONS_WRITE);
  const canReadSignups = useCapability(CAP.TENANT_SIGNUP_REQUESTS_READ);
  const canReviewSignups = useCapability(CAP.TENANT_SIGNUP_REQUESTS_REVIEW);
  const scopeType = identity.currentScopeType();
  const activeTenantId = identity.currentTenantId();
  const hasPlatformSignupScope = scopeType === 'platform';
  const hasTenantOrganizationScope = scopeType === 'tenant' && Boolean(activeTenantId);
  const canReadOrganizationSurface = canReadOrgs && (hasPlatformSignupScope || hasTenantOrganizationScope);
  const canApplySignupReview = canReviewSignups && hasPlatformSignupScope;
  const canReadSignupQueue = canReadSignups && hasPlatformSignupScope;
  const orgsQuery = useResourceList<OrgRow>('organizations', undefined, {
    enabled: canReadOrganizationSurface,
  });
  const requestsQuery = useResourceList<TenantSignupRequestRow>('tenant_signup_requests', undefined, {
    enabled: canReadSignupQueue,
    staleTime: 0,
    refetchInterval: canReadSignupQueue ? SIGNUP_QUEUE_REFETCH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  // W23 — additive paired projection. The base `tenant_signup_requests`
  // read seam remains the canonical SSOT; this read enriches the drawer
  // with reviewer / approved-org labels, attestation rollups, and
  // decision_age_seconds via `v_tenant_signup_request_summary` instead
  // of FE-side metadata jsonb walks.
  const requestSummaryQuery = useResourceList<TenantSignupRequestSummaryRow>(
    'tenant_signup_request_summary',
    undefined,
    {
      enabled: canReadSignupQueue,
      staleTime: 0,
      refetchInterval: canReadSignupQueue ? SIGNUP_QUEUE_REFETCH_INTERVAL_MS : false,
      refetchIntervalInBackground: false,
    },
  );
  const requestSummaryById = useMemo(() => {
    const map = new Map<string, TenantSignupRequestSummaryRow>();
    for (const r of requestSummaryQuery.data?.rows ?? []) map.set(r.id, r);
    return map;
  }, [requestSummaryQuery.data]);

  const drawer = useDrawer();
  const modal = useModal();
  const openedFocusRef = useRef<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [reviewedSignupOverrides, setReviewedSignupOverrides] = useState<Record<string, TenantSignupRequestRow>>({});
  // W50 — Resolve filter chips from canonical `tenant_signup_request_status`
  // lookup (no hardcoded status array). `'all'` sentinel prepends the
  // canonical values; if the canonical lookup is empty (seed gap) the chip
  // toolbar surfaces a `<StateView kind="error"/>` instead of degrading.
  const statusFilters = useMemo<string[]>(() => {
    const rows = (getLookups('tenant_signup_request_status') ?? []) as Array<{ value: string }>;
    return ['all', ...rows.map((r) => r.value)];
  }, []);
  const signupRows = useMemo(() => {
    const rows = requestsQuery.data?.rows ?? [];
    return rows.map((row) => reviewedSignupOverrides[row.id] ?? row);
  }, [requestsQuery.data, reviewedSignupOverrides]);
  const filteredSignups = useMemo(() => {
    const rows = signupRows;
    if (statusFilter === 'all') return rows;
    return rows.filter((r) => (r.status ?? '').toLowerCase() === statusFilter);
  }, [signupRows, statusFilter]);
  const organizationRows = useMemo(() => orgsQuery.data?.rows ?? [], [orgsQuery.data?.rows]);
  const organizationRowsOutOfScope = useMemo(() => {
    if (hasPlatformSignupScope) return [];
    if (!activeTenantId) return organizationRows;
    return organizationRows.filter((row) => row.id !== activeTenantId);
  }, [activeTenantId, hasPlatformSignupScope, organizationRows]);
  const visibleOrganizationRows = useMemo(() => {
    if (hasPlatformSignupScope) return organizationRows;
    if (organizationRowsOutOfScope.length > 0 || !activeTenantId) return [];
    return organizationRows.filter((row) => row.id === activeTenantId);
  }, [activeTenantId, hasPlatformSignupScope, organizationRows, organizationRowsOutOfScope.length]);

  // CLAIM-PLATFORM-ORGS — canonical tenant-signup-review edge function. The
  // hook flows through the queries layer (qk.list invalidation) so the queue
  // refreshes after a decision is applied.
  const reviewMutation = useTenantSignupReview();
  const consoleRequestMutation = useTenantSignupConsoleRequest();
  const orgProfileMutation = useUpdateOrganizationProfile();

  // Build the canonical review envelope accepted by the tenant-signup-review
  // edge function: `{ request_id, decision, reason?, invite_redirect_to?,
  // metadata? }`. The data-source adapter translates the historical FE names
  // to that body shape for backwards-compatible callers/tests.
  type ReviewApplyResult = Record<string, unknown> & {
    tenant_signup_request_id?: string;
    approved_organization_id?: string;
    organization_id?: string;
    approved_user_id?: string;
    approved_auth_user_id?: string;
    invite_email_sent_at?: string;
    invite_redirect_to?: string;
    already_processed?: boolean;
  };

  function signupReviewString(result: Record<string, unknown>, key: string): string | null {
    const value = result[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function signupReviewDecision(
    result: ReviewApplyResult,
    fallback: 'approved' | 'rejected',
  ): 'approved' | 'rejected' {
    const candidate =
      signupReviewString(result, 'review_decision')
      ?? signupReviewString(result, 'status')
      ?? signupReviewString(result, 'decision');
    return candidate === 'approved' || candidate === 'rejected' ? candidate : fallback;
  }

  function signupReviewAlreadyProcessed(result: ReviewApplyResult): boolean {
    return result.already_processed === true;
  }

  function signupReviewToast(
    decision: 'approved' | 'rejected',
    ok: number,
    total: number,
    failed: number,
    alreadyProcessed: number,
  ): string {
    // One whole sentence per outcome, so each language words it naturally.
    const key = alreadyProcessed > 0
      ? (failed ? 'platformOrganizations.organizationsModule.signupRefreshedFailedToast' : 'platformOrganizations.organizationsModule.signupRefreshedToast')
      : decision === 'approved'
        ? (failed ? 'platformOrganizations.organizationsModule.signupApprovedFailedToast' : 'platformOrganizations.organizationsModule.signupApprovedToast')
        : (failed ? 'platformOrganizations.organizationsModule.signupRejectedFailedToast' : 'platformOrganizations.organizationsModule.signupRejectedToast');
    return fill(t(key), { ok, total, failed, alreadyProcessed });
  }

  function reviewedSignupRow(
    row: TenantSignupRequestRow,
    decision: 'approved' | 'rejected',
    result: ReviewApplyResult,
    reason?: string,
  ): TenantSignupRequestRow {
    const actualDecision = signupReviewDecision(result, decision);
    const approvedOrgId =
      signupReviewString(result, 'approved_organization_id')
      ?? signupReviewString(result, 'organization_id')
      ?? signupReviewString(result, 'tenant_id')
      ?? row.approved_organization_id
      ?? null;
    return {
      ...row,
      approved_organization_label:
        signupReviewString(result, 'approved_organization_label')
        ?? signupReviewString(row, 'approved_organization_label')
        ?? null,
      approved_user_email:
        signupReviewString(result, 'approved_user_email')
        ?? signupReviewString(row, 'approved_user_email')
        ?? null,
      reviewer_label:
        signupReviewString(result, 'reviewer_label')
        ?? signupReviewString(row, 'reviewer_label')
        ?? null,
      reviewer_email:
        signupReviewString(result, 'reviewer_email')
        ?? signupReviewString(row, 'reviewer_email')
        ?? null,
      attestation_count:
        typeof result.attestation_count === 'number' ? result.attestation_count : row.attestation_count,
      attestation_passed_count:
        typeof result.attestation_passed_count === 'number'
          ? result.attestation_passed_count
          : row.attestation_passed_count,
      attestation_complete:
        typeof result.attestation_complete === 'boolean'
          ? result.attestation_complete
          : row.attestation_complete,
      has_marketing_consent:
        typeof result.has_marketing_consent === 'boolean'
          ? result.has_marketing_consent
          : row.has_marketing_consent,
      decision_age_seconds:
        typeof result.decision_age_seconds === 'number' ? result.decision_age_seconds : row.decision_age_seconds,
      is_pending: typeof result.is_pending === 'boolean' ? result.is_pending : row.is_pending,
      is_approved: typeof result.is_approved === 'boolean' ? result.is_approved : row.is_approved,
      is_rejected: typeof result.is_rejected === 'boolean' ? result.is_rejected : row.is_rejected,
      status: actualDecision,
      review_decision: actualDecision,
      reviewed_at: signupReviewString(result, 'reviewed_at') ?? row.reviewed_at ?? new Date().toISOString(),
      review_reason:
        signupReviewString(result, 'review_reason')
        ?? signupReviewString(result, 'decision_reason')
        ?? (actualDecision === 'rejected' ? reason : null)
        ?? row.review_reason
        ?? null,
      decision_metadata: {
        ...(row.decision_metadata ?? {}),
        ...((result.decision_metadata && typeof result.decision_metadata === 'object')
          ? result.decision_metadata as Record<string, unknown>
          : {}),
      },
      approved_organization_id: approvedOrgId,
      approved_user_id: signupReviewString(result, 'approved_user_id') ?? row.approved_user_id ?? null,
      approved_auth_user_id: signupReviewString(result, 'approved_auth_user_id') ?? row.approved_auth_user_id ?? null,
      invite_email_sent_at: signupReviewString(result, 'invite_email_sent_at') ?? row.invite_email_sent_at ?? null,
      invite_redirect_to: signupReviewString(result, 'invite_redirect_to') ?? row.invite_redirect_to ?? null,
      last_error_code: signupReviewString(result, 'last_error_code') ?? row.last_error_code ?? null,
      last_error_message: signupReviewString(result, 'last_error_message') ?? row.last_error_message ?? null,
      last_error_at: signupReviewString(result, 'last_error_at') ?? row.last_error_at ?? null,
    };
  }

  function summaryFromReviewReadback(row: TenantSignupRequestRow): TenantSignupRequestSummaryRow | undefined {
    const approvedOrganizationLabel = signupReviewString(row, 'approved_organization_label');
    const approvedUserEmail = signupReviewString(row, 'approved_user_email');
    const reviewerLabel = signupReviewString(row, 'reviewer_label') ?? row.reviewed_by_label ?? null;
    const hasProjectionReadback =
      approvedOrganizationLabel ||
      approvedUserEmail ||
      typeof row.attestation_count === 'number' ||
      typeof row.decision_age_seconds === 'number' ||
      typeof row.has_marketing_consent === 'boolean';
    if (!hasProjectionReadback) return undefined;
    return {
      id: row.id,
      status: String(row.status ?? ''),
      review_decision: row.review_decision ?? null,
      email: row.email ?? null,
      full_name: row.full_name ?? null,
      organization_name: row.organization_name ?? row.org_name ?? null,
      organization_slug: row.organization_slug ?? null,
      reviewed_at: row.reviewed_at ?? null,
      reviewed_by: signupReviewString(row, 'reviewed_by'),
      reviewer_label: reviewerLabel,
      reviewer_email: signupReviewString(row, 'reviewer_email'),
      approved_organization_id: row.approved_organization_id ?? null,
      approved_organization_label: approvedOrganizationLabel,
      approved_user_id: row.approved_user_id ?? null,
      approved_auth_user_id: row.approved_auth_user_id ?? null,
      approved_user_email: approvedUserEmail,
      invite_email_sent_at: row.invite_email_sent_at ?? null,
      invite_redirect_to: row.invite_redirect_to ?? null,
      last_error_code: row.last_error_code ?? null,
      last_error_message: row.last_error_message ?? null,
      last_error_at: row.last_error_at ?? null,
      attestation_count: typeof row.attestation_count === 'number' ? row.attestation_count : 0,
      attestation_passed_count: typeof row.attestation_passed_count === 'number' ? row.attestation_passed_count : 0,
      attestation_complete: row.attestation_complete === true,
      has_marketing_consent: row.has_marketing_consent === true,
      is_pending: row.is_pending === true,
      is_approved: row.is_approved === true,
      is_rejected: row.is_rejected === true,
      decision_age_seconds: typeof row.decision_age_seconds === 'number' ? row.decision_age_seconds : null,
    };
  }

  function signupRowFromConsoleRequestReadback(
    result: Record<string, unknown>,
    args: TenantConsoleRequestInput,
  ): TenantSignupRequestRow | null {
    const requestId =
      signupReviewString(result, 'tenant_signup_request_id')
      ?? signupReviewString(result, 'request_id')
      ?? signupReviewString(result, 'id');
    if (!requestId) return null;
    const organizationName =
      signupReviewString(result, 'organization_name')
      ?? signupReviewString(result, 'org_name')
      ?? args.organization_name;
    const status = signupReviewString(result, 'status') ?? 'pending';
    return {
      id: requestId,
      email: signupReviewString(result, 'email') ?? args.email,
      full_name: signupReviewString(result, 'full_name') ?? args.full_name,
      organization_name: organizationName,
      org_name: organizationName,
      organization_slug: signupReviewString(result, 'organization_slug') ?? args.organization_slug ?? undefined,
      website_url: signupReviewString(result, 'website_url') ?? args.website_url ?? undefined,
      phone: signupReviewString(result, 'phone') ?? args.phone ?? undefined,
      notes: signupReviewString(result, 'notes') ?? args.notes ?? undefined,
      locale: signupReviewString(result, 'locale') ?? args.locale ?? undefined,
      status,
      created_at: signupReviewString(result, 'created_at') ?? undefined,
      received_at: signupReviewString(result, 'received_at') ?? signupReviewString(result, 'created_at') ?? undefined,
      updated_at: signupReviewString(result, 'updated_at') ?? undefined,
      marketing: recordValue(result.marketing),
      metadata: recordValue(result.metadata),
      turnstile_verified: result.turnstile_verified === true,
      attestation_count:
        typeof result.attestation_count === 'number' ? result.attestation_count : undefined,
      attestation_passed_count:
        typeof result.attestation_passed_count === 'number' ? result.attestation_passed_count : undefined,
      attestation_complete:
        typeof result.attestation_complete === 'boolean' ? result.attestation_complete : undefined,
      has_marketing_consent:
        typeof result.has_marketing_consent === 'boolean' ? result.has_marketing_consent : undefined,
      is_pending: typeof result.is_pending === 'boolean' ? result.is_pending : status.toLowerCase() === 'pending',
      is_approved: typeof result.is_approved === 'boolean' ? result.is_approved : status.toLowerCase() === 'approved',
      is_rejected: typeof result.is_rejected === 'boolean' ? result.is_rejected : status.toLowerCase() === 'rejected',
      decision_age_seconds:
        typeof result.decision_age_seconds === 'number' ? result.decision_age_seconds : null,
    };
  }

  function rememberReviewedSignup(row: TenantSignupRequestRow): TenantSignupRequestRow {
    setReviewedSignupOverrides((current) => ({
      ...current,
      [row.id]: row,
    }));
    return row;
  }

  async function refreshSignupReviewFailureReadback(
    row: TenantSignupRequestRow,
  ): Promise<{ row: TenantSignupRequestRow; summary: TenantSignupRequestSummaryRow | null }> {
    const [requestReadback, summaryReadback] = await Promise.allSettled([
      requestsQuery.refetch(),
      requestSummaryQuery.refetch(),
    ]);
    const refreshedRow = requestReadback.status === 'fulfilled'
      ? requestReadback.value.data?.rows.find((candidate) => candidate.id === row.id)
      : null;
    const refreshedSummary = summaryReadback.status === 'fulfilled'
      ? summaryReadback.value.data?.rows.find((candidate) => candidate.id === row.id)
      : null;
    return {
      row: refreshedRow ?? row,
      summary: refreshedSummary ?? null,
    };
  }

  function applyDecision(
    rows: TenantSignupRequestRow[],
    decision: 'approved' | 'rejected',
    reason?: string,
    options?: { approvedExistingOrganizationId?: string | null },
  ): Promise<{
    ok: number;
    failed: number;
    alreadyProcessed: number;
    results: Array<{ row: TenantSignupRequestRow; result: ReviewApplyResult }>;
    failures: Array<{ row: TenantSignupRequestRow; summary: TenantSignupRequestSummaryRow | null; error: Error }>;
  }> {
    let okCount = 0;
    let failedCount = 0;
    const results: Array<{ row: TenantSignupRequestRow; result: ReviewApplyResult }> = [];
    const failures: Array<{ row: TenantSignupRequestRow; summary: TenantSignupRequestSummaryRow | null; error: Error }> = [];
    return Promise.all(
      rows.map((r) =>
        reviewMutation
          .mutateAsync({
            tenant_signup_request_id: r.id,
            decision,
            decision_reason: reason ?? null,
            decision_metadata: {
              source: 'console-v2/platform/organizations',
              ...(decision === 'approved' && options?.approvedExistingOrganizationId
                ? {
                    approved_existing_organization_id: options.approvedExistingOrganizationId,
                    existing_organization_link_requested: true,
                  }
                : {}),
            },
          })
          .then((result) => {
            okCount += 1;
            results.push({ row: r, result: result as ReviewApplyResult });
          })
          .catch(async (err: Error) => {
            failedCount += 1;
            const readback = await refreshSignupReviewFailureReadback(r);
            failures.push({ row: readback.row, summary: readback.summary, error: err });
            pushToast(
              t('platformOrganizations.organizationsModule.tenantSignupReviewCould'),
              'danger',
            );
          }),
      ),
    ).then(() => ({
      ok: okCount,
      failed: failedCount,
      alreadyProcessed: results.filter(({ result }) => signupReviewAlreadyProcessed(result)).length,
      results,
      failures,
    }));
  }

  const onApprove = (
    rs: TenantSignupRequestRow[],
    options?: { approvedExistingOrganizationId?: string | null },
  ) => {
    if (!canApplySignupReview) {
      pushToast(
        hasPlatformSignupScope
          ? t('platformOrganizations.organizationsModule.approvalRequiresTenantSignup')
          : t('platformOrganizations.organizationsModule.approvalRequiresPlatformScope'),
        'danger',
      );
      return;
    }
    void applyDecision(rs, 'approved', undefined, options).then(({ ok, failed, alreadyProcessed, results, failures }) => {
      pushToast(
        signupReviewToast('approved', ok, rs.length, failed, alreadyProcessed),
        failed === 0 && alreadyProcessed === 0 ? 'good' : 'warn',
      );
      if (failed === 0) {
        if (rs.length === 1 && results[0]) {
          const reviewedRow = rememberReviewedSignup(
            reviewedSignupRow(results[0].row, 'approved', results[0].result),
          );
          setStatusFilter('all');
          openSignupDrawer(reviewedRow);
        } else {
          drawer.close();
        }
      } else if (rs.length === 1 && failures[0]) {
        openSignupDrawer(failures[0].row, {
          requestId: failures[0].row.id,
          message: failures[0].error.message,
          status: failures[0].row.status,
          summary: failures[0].summary,
        });
      }
    });
  };

  const onReject = (rs: TenantSignupRequestRow[]) => {
    if (!canApplySignupReview) {
      pushToast(
        hasPlatformSignupScope
          ? t('platformOrganizations.organizationsModule.rejectionRequiresTenantSignup')
          : t('platformOrganizations.organizationsModule.rejectionRequiresPlatformScope'),
        'danger',
      );
      return;
    }
    modal.open({
      title: rs.length > 1 ? fill(t('platformOrganizations.organizationsModule.rejectTenantRequests'), { length: String(rs.length) }) : t('platformOrganizations.organizationsModule.rejectTenantRequest'),
      body: (
        <RejectReasonForm
          count={rs.length}
          pending={reviewMutation.isPending}
          onCancel={() => modal.close()}
          onSubmit={async (reason) => {
            const { ok, failed, alreadyProcessed, results, failures } = await applyDecision(rs, 'rejected', reason);
            pushToast(
              signupReviewToast('rejected', ok, rs.length, failed, alreadyProcessed),
              failed === 0 ? 'warn' : 'danger',
            );
            if (failed === 0) {
              modal.close();
              if (rs.length === 1 && results[0]) {
                const reviewedRow = rememberReviewedSignup(
                  reviewedSignupRow(results[0].row, 'rejected', results[0].result, reason),
                );
                setStatusFilter('all');
                openSignupDrawer(reviewedRow);
              } else {
                drawer.close();
              }
            } else if (rs.length === 1 && failures[0]) {
              modal.close();
              openSignupDrawer(failures[0].row, {
                requestId: failures[0].row.id,
                message: failures[0].error.message,
                status: failures[0].row.status,
                summary: failures[0].summary,
              });
            }
          }}
        />
      ),
    });
  };

  function openSignupDrawer(row: TenantSignupRequestRow, reviewFailure?: TenantSignupReviewFailure | null) {
    drawer.open({
      title: fill(t('platformOrganizations.organizationsModule.signup'), { value: String(row.organization_name ?? row.org_name ?? row.id) }),
      size: 'lg',
      body: (
        <SignupDrawerBody
          row={row}
          summary={reviewFailure?.summary ?? summaryFromReviewReadback(row) ?? requestSummaryById.get(row.id)}
          canReview={canApplySignupReview}
          existingOrganizations={visibleOrganizationRows}
          reviewFailure={reviewFailure ?? null}
          pending={reviewMutation.isPending}
          onApprove={(options) => onApprove([row], options)}
          onReject={() => onReject([row])}
          onOpenReadiness={(organizationId) => {
            go(`/platform/onboarding-readiness?scope_type=tenant&scope_id=${encodeURIComponent(organizationId)}`);
            drawer.close();
          }}
          onOpenUserAccess={(organizationId, focus) => {
            const params = new URLSearchParams({ organization_id: organizationId });
            if (focus) params.set('focus', focus);
            go(`/platform/users?${params.toString()}`);
            drawer.close();
          }}
        />
      ),
    });
  }

  useEffect(() => {
    const focus = readUrlParam('task') ?? readUrlParam('focus');
    if (!focus || requestsQuery.isLoading || openedFocusRef.current === focus) return;
    const rows = requestsQuery.data?.rows ?? [];
    const match = rows.find(
      (row) =>
        row.id === focus ||
        row.task_id === focus ||
        row.organization_slug === focus ||
        row.email === focus,
    );
    if (!match) return;
    openedFocusRef.current = focus;
    openSignupDrawer(match);
  }, [signupRows, requestsQuery.isLoading]);

  function openTenantConsoleRequest() {
    function RequestBody() {
      const { t } = useI18n();
      return (
        <TenantConsoleRequestForm
          canReview={canApplySignupReview}
          pending={consoleRequestMutation.isPending}
          onCancel={() => modal.close()}
          onSubmit={async (args) => {
            try {
              const result = await consoleRequestMutation.mutateAsync(args);
              const createdRow = signupRowFromConsoleRequestReadback(result, args);
              modal.close();
              pushToast(fill(t('platformOrganizations.requestBody.tenantSignupRequestSaved'), { organization_name: String(args.organization_name) }), 'good');
              if (createdRow) {
                setStatusFilter(String(createdRow.status ?? 'pending').toLowerCase());
                openSignupDrawer(createdRow);
              }
            } catch (err) {
              pushToast(t('platformOrganizations.requestBody.tenantSignupRequestCould'), 'danger');
            }
          }}
        />
      );
    }

    modal.open({ title: t('platformOrganizations.organizationsModule.createTenantRequest'), body: <RequestBody /> });
  }

  function openOrgProfile(row: OrgRow) {
    const openTenantSurface = (path: string) => {
      modal.close();
      go(path);
    };
    const encodedOrgId = encodeURIComponent(row.id);
    function ProfileBody() {
      const { t } = useI18n();
      const [profileRow, setProfileRow] = useState(row);
      const [saveEvidence, setSaveEvidence] = useState<OrgProfileSaveEvidence | null>(null);
      return (
        <>
          <OrgProfileForm
            row={profileRow}
            canWrite={canWriteOrgs}
            pending={orgProfileMutation.isPending}
            onCancel={() => modal.close()}
            onOpenReadiness={() => openTenantSurface(`/platform/onboarding-readiness?scope_type=tenant&scope_id=${encodedOrgId}`)}
            onOpenSettings={() => openTenantSurface(`/platform/config?scope_type=tenant&scope_id=${encodedOrgId}`)}
            onOpenUsers={() => openTenantSurface(`/platform/users?organization_id=${encodedOrgId}`)}
            onOpenAccess={() => openTenantSurface(`/platform/access?scope_type=tenant&scope_id=${encodedOrgId}`)}
            onSubmit={async (args) => {
              try {
                const result = await orgProfileMutation.mutateAsync(args) as Record<string, unknown>;
                const updatedRow = orgRowFromProfileReadback(profileRow, result);
                if (!updatedRow) {
                  throw new Error('Saved organization profile was not available after update.');
                }
                setProfileRow(updatedRow);
                setSaveEvidence(orgProfileSaveEvidenceFromResult(updatedRow, result));
                pushToast(fill(t('platformOrganizations.profileBody.organizationProfileSaved'), { name: String(updatedRow.name) }), 'good');
              } catch (err) {
                pushToast(t('platformOrganizations.profileBody.organizationProfileCouldNot'), 'danger');
              }
            }}
          />
          {saveEvidence ? (
            <OrgProfileReadbackPanel evidence={saveEvidence} />
          ) : null}
        </>
      );
    }

    modal.open({ title: fill(t('platformOrganizations.organizationsModule.organizationProfile'), { name: String(row.name) }), body: <ProfileBody /> });
  }

  return (
    <div className="page page--split-table" data-testid="organizations-page">
      <PageHeader
        moduleKey="organizations"
        eyebrow={t('platformOrganizations.organizationsModule.platform')}
        titleAccent={t('platformOrganizations.organizationsModule.titleAccent')}
        titlePlain=""
        pills={[<span key="resources" className="chip chip--xs mono">{t('platformOrganizations.organizationsModule.tenantRegistrySignupQueue')}</span>]}
        actions={[
          <Button
            key="new-request"
            label={t('platformOrganizations.organizationsModule.newTenantRequest')}
            iconName="plus"
            kind="primary"
            capability={CAP.TENANT_SIGNUP_REQUESTS_REVIEW}
            disabled={!hasPlatformSignupScope}
            title={!hasPlatformSignupScope ? t('platformOrganizations.organizationsModule.tenantSignupReviewRequires') : undefined}
            onClick={openTenantConsoleRequest}
          />,
        ]}
      />

      <div className="section-eyebrow">{hasPlatformSignupScope ? t('platformOrganizations.organizationsModule.tenants') : t('platformOrganizations.organizationsModule.yourOrganization')}</div>
      {!canReadOrgs ? (
        <StateView
          kind="denied"
          capability={CAP.ORGANIZATIONS_READ}
          hint={t('platformOrganizations.organizationsModule.tenantListRequiresOrganization')}
        />
      ) : !hasPlatformSignupScope && !hasTenantOrganizationScope ? (
        <StateView
          kind="denied"
          title={t('platformOrganizations.organizationsModule.tenantScopeRequired')}
          capability={CAP.ORGANIZATIONS_READ}
          hint={t('platformOrganizations.organizationsModule.organizationProfileRequiresAn')}
        />
      ) : orgsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : orgsQuery.isError ? (
        <StateView
          kind="error"
          title={t('platformOrganizations.organizationsModule.tenantRegistryFailed')}
          hint={queryErrorHint(orgsQuery.error, t('platformOrganizations.organizationsModule.tenantRegistryCouldNotLoad'))}
        />
      ) : organizationRowsOutOfScope.length > 0 ? (
        <StateView
          kind="error"
          title={t('platformOrganizations.organizationsModule.organizationRegistryScopeFailed')}
          hint={t('platformOrganizations.organizationsModule.someOrganizationsAreOutside')}
        />
      ) : (
        <DataTable<OrgRow>
          columns={orgTableColumns}
          rows={visibleOrganizationRows}
          viewKey="organizations"
          entityKind="organizations"
          emptyText={
            hasPlatformSignupScope
              ? t('platformOrganizations.organizationsModule.noTenantOrganizationsAre')
              : t('platformOrganizations.organizationsModule.noOrganizationProfileIs')
          }
          onRowClick={openOrgProfile}
        />
      )}

      <div className="section-eyebrow">{t('platformOrganizations.organizationsModule.signupRequests')}</div>
      {!canReadSignups ? (
        <StateView
          kind="denied"
          capability={CAP.TENANT_SIGNUP_REQUESTS_READ}
          hint={t('platformOrganizations.organizationsModule.tenantSignupQueueRequires')}
        />
      ) : !hasPlatformSignupScope ? (
        <StateView
          kind="denied"
          title={t('platformOrganizations.organizationsModule.platformScopeRequired')}
          capability={CAP.TENANT_SIGNUP_REQUESTS_REVIEW}
          hint={t('platformOrganizations.organizationsModule.tenantSignupReviewCreates')}
        />
      ) : requestsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : requestsQuery.isError ? (
        <StateView
          kind="error"
          title={t('platformOrganizations.organizationsModule.signupRequestsFailed')}
          hint={queryErrorHint(requestsQuery.error, t('platformOrganizations.organizationsModule.signupRequestsCouldNotLoad'))}
        />
      ) : statusFilters.length <= 1 ? (
        <StateView
          kind="error"
          hint={t('platformOrganizations.organizationsModule.tenantSignupStatusesAre')}
        />
      ) : (
        <>
          {requestSummaryQuery.isError ? (
            <StateView
              kind="error"
              title={t('platformOrganizations.organizationsModule.signupSummaryProjectionFailed')}
              hint={queryErrorHint(
                requestSummaryQuery.error,
                t('platformOrganizations.organizationsModule.signupSummaryCouldNotLoad'),
              )}
            />
          ) : null}
          <div className="dt-toolbar">
            <span className="eyebrow">{t('platformOrganizations.organizationsModule.status')}</span>
            {statusFilters.map((f) => (
              <button
                key={f}
                type="button"
                className={`dt-tb-view-tab ${statusFilter === f ? 'is-active' : ''}`}
                onClick={() => setStatusFilter(f)}
                data-testid={`signup-status-${f}`}
              >
                {f}
              </button>
            ))}
            <span className="dt-tb-spacer" />
            <span className="dt-tb-count mono">
              {`${filteredSignups.length}/${signupRows.length}`}
            </span>
          </div>
          <DataTable<TenantSignupRequestRow>
            columns={signupTableColumns}
            rows={filteredSignups}
            viewKey="tenant_signup_requests"
            entityKind="tenant_signup_requests"
            emptyText={
              statusFilter === 'all'
                ? t('platformOrganizations.organizationsModule.noTenantSignupRequests')
                : fill(t('platformOrganizations.organizationsModule.noTenantSignupRequests2'), { statusFilter: String(statusFilter) })
            }
            onRowClick={openSignupDrawer}
            bulkActions={[
              {
                label: t('platformOrganizations.organizationsModule.approve'),
                icon: 'check',
                kind: 'primary',
                capability: CAP.TENANT_SIGNUP_REQUESTS_REVIEW,
                onClick: onApprove,
              },
              {
                label: t('platformOrganizations.organizationsModule.reject'),
                icon: 'close',
                kind: 'danger',
                capability: CAP.TENANT_SIGNUP_REQUESTS_REVIEW,
                onClick: onReject,
              },
            ]}
          />
        </>
      )}
      {drawer.node}
      {modal.node}
    </div>
  );
}
