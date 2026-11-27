// CapabilityEvalDrilldown.tsx — per-capability "Why?" drilldown chip.
//
// CLAIM-IDENTITY-CAPS / Phase E4 — surfaces the canonical evaluator
// `public.user_capability_eval_v1` (defined in
// supabase/migrations/202601022113_access_control_policy_core.sql:764) so
// operators can see the override-ladder path that produced the allow/deny
// decision for a given user × capability. Without this drilldown, operators
// can see WHAT they have/lack but not WHY (audit P1 IDENTITY gap).
//
// The component renders:
//   - inline status chip ("granted" / "denied") sourced from useIdentity()
//     so the chip is visible BEFORE the operator clicks "Why?" (cheap path).
//   - "Why?" toggle that expands a LadderViz-style scope_path walk
//     (most-specific → root) plus the resolved policy_source metadata
//     (settings_id / settings_version_id / scope) and role_keys. Only the
//     toggle action triggers the canonical evaluator RPC — this matters on
//     surfaces like /platform/access that render ~60 capability rows.
//
// Data flow (5-step canonical shape):
//   useUserCapabilityEval(userId, capabilityKey)  -- queries.ts
//     → api.user_capability_eval_v1(...)          -- api.ts
//     → ds.user_capability_eval_v1(...)           -- data-source.ts
//
// At cutover the data-source adapter swaps to
// `client.rpc('user_capability_eval_v1', ...)` — no other file changes.
//
// Capability gate (read-only): `access_policy.read`. Mutations are
// out-of-scope for this drilldown; capability-grant requests use the
// existing `request_capability_grant_v1` flow on /platform/access.

import { useState, type ReactNode } from 'react';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';
import { useUserCapabilityEval } from '@/lib/queries';
import { useIdentity } from '@/lib/identity';
import {
  CAP,
  WILDCARD_CAPABILITY,
  formatCapabilityLabel,
  formatCapabilityRequirement,
  formatCapabilityTitle,
} from '@/lib/capabilities';
import { useT } from '@/lib/i18n';

export interface CapabilityEvalDrilldownProps {
  /**
   * Target user id. Production uses the target-user evaluator when supplied
   * so tenant admins inspect the selected row instead of their own identity.
   */
  userId: string;
  /** Canonical capability key (e.g. `shipments.read`, `access_policy.read`). */
  capabilityKey: string;
  /**
   * Optional explicit scope. Defaults to the current user's effective access
   * scope (matching the backend's NULL-arg behavior).
   */
  scopeType?: string;
  scopeId?: string | null;
  /**
   * Optional auto-expanded variant — used by drawers that surface the
   * drilldown inline rather than as a click-to-expand chip.
   */
  defaultExpanded?: boolean;
  /**
   * Optional precomputed selected-user result. User drawers use the resolved
   * access-policy role catalog to avoid showing the current operator's
   * capability posture while the target-user RPC stays lazy behind "Why?".
   */
  knownAllowed?: boolean;
  /**
   * data-testid prefix; the chip and expander expose stable ids for tests.
   * Defaults to `capability-eval-${capabilityKey}` so a single page rendering
   * many drilldowns (e.g. `/platform/access`) keeps each row unique.
   */
  testIdPrefix?: string;
}

interface PolicySource {
  settings_id?: string;
  settings_version_id?: string;
  policy_scope_type?: string;
  policy_scope_id?: string | null;
  scope_path?: Array<{ scope_type: string; scope_id: string | null }>;
}

function accessEvalLabel(value: unknown, fallback: string): string {
  const token = String(value ?? '').trim();
  if (!token) return fallback;
  return token
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

// Policy tokens are backend identifiers, so they render as isolated left-to-right text.
function accessEvalEvidenceLabel(value: unknown, fallback: string): ReactNode {
  const token = String(value ?? '').trim();
  if (!token) return fallback;
  const label = accessEvalLabel(token, fallback);
  return label === token ? <bdi dir="ltr">{token}</bdi> : (
    <bdi dir="ltr">
      {label} <span className="mono">({token})</span>
    </bdi>
  );
}

export function CapabilityEvalDrilldown({
  userId,
  capabilityKey,
  scopeType,
  scopeId,
  defaultExpanded = false,
  knownAllowed,
  testIdPrefix,
}: CapabilityEvalDrilldownProps) {
  const t = useT();
  const { hasCapability } = useIdentity();
  const canRead = hasCapability(CAP.ACCESS_POLICY_READ);
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);

  // Cheap-path allow/deny chip — same predicate the rest of the surface uses
  // so the chip stays consistent before/after the drilldown is opened. The
  // canonical RPC will confirm via `result.allowed` once expanded.
  const cheapAllowed = knownAllowed ?? (hasCapability(capabilityKey) || hasCapability(WILDCARD_CAPABILITY));

  // Only fetch when the operator can read access policy AND the drilldown is
  // expanded. The backend RPC enforces capability gating itself (REVOKE ALL
  // FROM PUBLIC + GRANT to authenticated), but lazy-loading prevents N RPC
  // calls on a page rendering many drilldowns (e.g. /platform/access has ~60
  // capability rows). Once expanded, the query result is cached by tanstack
  // and persists across collapse/expand toggles.
  const evalQuery = useUserCapabilityEval(capabilityKey, scopeType, scopeId, canRead && expanded, userId);

  const idPrefix = testIdPrefix ?? `capability-eval-${capabilityKey}`;

  // Read-denied: do not render the drilldown at all (the surface remains
  // gated by access_policy.read elsewhere). Returning a tiny lock chip keeps
  // tests deterministic without exposing capability details.
  if (!canRead) {
    return (
      <span
        className="chip chip--neutral chip--xs"
        data-testid={`${idPrefix}-denied`}
        title={formatCapabilityTitle(CAP.ACCESS_POLICY_READ, t)}
      >
        {formatCapabilityRequirement(CAP.ACCESS_POLICY_READ, t)}
      </span>
    );
  }

  // Render the wrapper unconditionally. The status chip uses the cheap
  // identity check (instant, no RPC); the panel renders only when expanded.
  return (
    <span
      className="capability-eval-drilldown"
      data-testid={idPrefix}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}
    >
      <Chip
        kind={cheapAllowed ? 'good' : 'warn'}
        size="xs"
        label={cheapAllowed ? t('shell.capEval.granted') : t('shell.capEval.denied')}
        title={t('shell.capEval.status')}
      />
      <button
        type="button"
        className="chip chip--xs chip--neutral"
        data-testid={`${idPrefix}-toggle`}
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          cursor: 'pointer',
          background: 'transparent',
          border: '1px solid var(--line)',
          padding: '2px 6px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <Icon name={expanded ? 'chevD' : 'chevR'} size={10} />
        <span>{t('shell.capEval.why')}</span>
      </button>

      {expanded ? (
        <div
          className="card capability-eval-drilldown__panel"
          data-testid={`${idPrefix}-panel`}
          style={{
            flex: '1 1 100%',
            marginTop: '4px',
            padding: '8px 10px',
            border: '1px solid var(--line)',
            borderRadius: '6px',
            background: 'var(--paper)',
            fontSize: '11px',
          }}
        >
          {/* Provenance summary — pinned to the canonical RPC name so
              operators can grep migrations for the exact evaluator. */}
          <div className="section-eyebrow" style={{ padding: 0, marginBottom: '6px' }}>
            {t('shell.capEval.title')} <bdi>{formatCapabilityLabel(capabilityKey, { titleCase: true }, t)}</bdi>
            {userId ? (
              <span style={{ marginInlineStart: '6px' }}>
                {t('shell.capEval.forUser')}
              </span>
            ) : null}
          </div>

          {evalQuery.isLoading ? (
            <p
              className="state__hint"
              data-testid={`${idPrefix}-loading`}
              style={{ margin: 0, fontSize: '11px' }}
            >
              {t('shell.capEval.loading')}
            </p>
          ) : evalQuery.isError || !evalQuery.data ? (
            <p
              className="state__hint"
              data-testid={`${idPrefix}-error`}
              style={{ margin: 0, fontSize: '11px', color: 'var(--danger)' }}
            >
              {t('shell.capEval.loadFailed')}
            </p>
          ) : (
            <DrilldownPanelBody result={evalQuery.data} idPrefix={idPrefix} />
          )}
        </div>
      ) : null}
    </span>
  );
}

interface PanelResult {
  allowed: boolean;
  reason: string;
  capability_key: string;
  scope_type: string;
  scope_id: string | null;
  role_keys: string[];
  granted_capabilities: string[];
  policy_source: PolicySource;
}

function DrilldownPanelBody({ result, idPrefix }: { result: PanelResult; idPrefix: string }) {
  const t = useT();
  const allowed = result.allowed;
  const policySource = (result.policy_source ?? {}) as PolicySource;
  const scopePath = policySource.scope_path ?? [];
  const winningScopeType = policySource.policy_scope_type ?? result.scope_type;

  return (
    <>
      {/* Reason + role grants — the same fields the backend evaluator fills
          (`reason`, `role_keys`, `granted_capabilities`). */}
      <div
        style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}
        data-testid={`${idPrefix}-summary`}
      >
        <Chip
          kind={allowed ? 'good' : 'warn'}
          size="xs"
          label={(
            <>
              {t('shell.capEval.reason')} {accessEvalEvidenceLabel(result.reason, t('shell.capEval.reasonFallback'))}
            </>
          )}
        />
        {(result.role_keys ?? []).map((roleKey) => (
          <Chip
            key={roleKey}
            kind="info"
            size="xs"
            label={(
              <>
                {t('shell.capEval.role')} {accessEvalEvidenceLabel(roleKey, t('shell.capEval.roleFallback'))}
              </>
            )}
          />
        )) as ReactNode[]}
        {result.scope_type ? (
          <Chip
            kind="neutral"
            size="xs"
            label={(
              <>
                {t('shell.capEval.scope')} {accessEvalEvidenceLabel(result.scope_type, t('shell.capEval.scopeFallback'))}
                {result.scope_id ? (
                  <>
                    {' · '}
                    <span>{t('shell.capEval.selectedScopeLower')}</span>
                  </>
                ) : null}
              </>
            )}
          />
        ) : null}
      </div>

      {/* Override-ladder walk — most-specific → root. Mirrors the
          `<LadderViz>` contract used elsewhere; shipped inline because the
          evaluator's `policy_source.scope_path` shape differs from
          `SettingsResolution.ladder_path` (no per-step value/version). */}
      {scopePath.length > 0 ? (
        <>
          <div className="section-eyebrow" style={{ padding: 0, marginBottom: '4px' }}>
            {t('shell.capEval.ladder')}
          </div>
          <div className="ladder" data-testid={`${idPrefix}-ladder`}>
            {scopePath.map((step, i) => {
              const isMatch = step.scope_type === winningScopeType;
              const stepClasses = ['ladder__step', isMatch ? 'is-match' : 'is-dim']
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={`${step.scope_type}-${step.scope_id ?? 'null'}-${i}`}
                  className={stepClasses}
                  data-testid={`${idPrefix}-ladder-step-${step.scope_type}`}
                >
                  <span className="ladder__rank">{String(i + 1)}</span>
                  <span className="ladder__level">{accessEvalEvidenceLabel(step.scope_type, t('shell.capEval.scopeFallback'))}</span>
                  <span className="ladder__id">
                    {step.scope_id ? t('shell.capEval.selectedScope') : t('shell.capEval.globalPolicy')}
                  </span>
                  <span className="ladder__value">
                    {isMatch ? t('shell.capEval.resolved') : t('shell.capEval.inherit')}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="state__hint" style={{ margin: 0, fontSize: '11px' }}>
          {t('shell.capEval.noPolicy')}
        </p>
      )}

      {/* Policy provenance — settings_id + settings_version_id pin the
          exact `settings_versions` row that produced the policy body.
          These are the same identifiers logged by
          `log_settings_resolution()` in the backend evaluator. */}
      {policySource.settings_id || policySource.settings_version_id || policySource.policy_scope_type ? (
        <div
          className="mono"
          data-testid={`${idPrefix}-source`}
          style={{ marginTop: '8px', fontSize: '10.5px', color: 'var(--ink-mute)' }}
        >
          <div>{t('shell.capEval.capability')} <bdi>{formatCapabilityLabel(result.capability_key, { titleCase: true }, t)}</bdi></div>
          {result.granted_capabilities.length > 0 ? (
            <div>
              {t('shell.capEval.grantedThrough')}{' '}
              <bdi>
                {result.granted_capabilities
                  .map((capability) => formatCapabilityLabel(capability, { titleCase: true }, t))
                  .join(', ')}
              </bdi>
            </div>
          ) : null}
          {policySource.policy_scope_type ? (
            <div>
              {t('shell.capEval.policySource')}
            </div>
          ) : null}
          {policySource.settings_id ? <div>{t('shell.capEval.policySet')}</div> : null}
          {policySource.settings_version_id ? <div>{t('shell.capEval.policyRevision')}</div> : null}
        </div>
      ) : null}
    </>
  );
}
