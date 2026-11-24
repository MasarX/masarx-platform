// auth-email.tsx — Read-only viewer for auth-email-url-policy.<env>.json. Renders
// structured allowlist + redirect URL highlights and a copyable JSON dump. Marked
// explicitly read-only because production governance lives in the CI workflow
// .github/workflows/sync-auth-email-url.yml — operators audit here, never edit.

import { Chip, type ChipKind } from '@/components/Chip';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { pushToast } from '@/components/toastStore';
import { useCapability } from '@/lib/identity';
import { useResourceList } from '@/lib/queries';
import { CAP } from '@/lib/capabilities';
import { lookupRow } from '@/lib/api';
import { fill, useI18n, type Translate } from '@/lib/i18n';

interface AuthEmailPolicy {
  env: string;
  callback_urls: string[];
  redirect_urls: string[];
  source_file: string;
  last_audit_at: string;
  audit_status: string;
}

function copy(t: Translate, value: string, label: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(value)
      .then(() => pushToast(fill(t('platformAuthEmail.copy.copied'), { label }), 'good'))
      .catch(() => pushToast(t('platformAuthEmail.copy.copyFailed'), 'danger'));
  } else {
    pushToast(t('platformAuthEmail.copy.clipboardUnavailable'), 'warn');
  }
}

function policySummary(policy: AuthEmailPolicy, t: Translate): string {
  const s = 'platformAuthEmail.summary';
  return [
    fill(t(`${s}.sourceFile`), { value: policy.source_file }),
    fill(t(`${s}.environment`), { value: policy.env }),
    fill(t(`${s}.auditStatus`), { value: policy.audit_status }),
    fill(t('platformAuthEmail.authEmailModule.lastReviewed'), { last_audit_at: policy.last_audit_at }),
    fill(t(`${s}.callbackUrls`), { count: String(policy.callback_urls.length) }),
    fill(t(`${s}.redirectUrls`), { count: String(policy.redirect_urls.length) }),
  ].join('\n');
}

function policyJson(policy: AuthEmailPolicy): string {
  return JSON.stringify(policy, null, 2);
}

function CopyableUrl({ url }: { url: string }) {
  const { t } = useI18n();
  return (
    <li
      className="mono"
      style={{
        padding: '4px 0',
        borderBottom: '1px solid var(--line)',
        fontSize: '11px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span style={{ flex: 1, wordBreak: 'break-all' }}>{url}</span>
      <button
        type="button"
        title={t('platformAuthEmail.copyableUrl.copyUrl')}
        onClick={() => copy(t, url, t('platformAuthEmail.copy.url'))}
        style={{
          background: 'transparent',
          border: '1px solid var(--line)',
          padding: '0 6px',
          fontSize: '9.5px',
          cursor: 'pointer',
          color: 'var(--ink-3)',
          borderRadius: '3px',
        }}
        data-testid="auth-email-copy-url"
      >
        {t('platformAuthEmail.copyableUrl.copy')}
      </button>
    </li>
  );
}

export function AuthEmailModule() {
  const { t } = useI18n();
  const canRead = useCapability(CAP.SETTINGS_READ);
  // W56-B-2 closure (F6) — `api.seed.planningOsModule()` indirection migrated
  // to canonical `useResourceList<AuthEmailPolicy>('auth_email_url_policy')`.
  // The single-row config surfaces as a 1-row list per registry uniformity;
  // we project the single row into the surface contract for rendering.
  const policyQuery = useResourceList<AuthEmailPolicy>('auth_email_url_policy');
  const policy = policyQuery.data?.rows?.[0];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="authEmail"
          eyebrow={t('platformAuthEmail.authEmailModule.platform')}
          titleAccent={t('platformAuthEmail.authEmailModule.titleAccent')}
          titlePlain={t('platformAuthEmail.authEmailModule.titlePlain')}
        />
        <StateView
          kind="denied"
          capability={CAP.SETTINGS_READ}
          hint={t('platformAuthEmail.authEmailModule.youDoNotHave')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="authEmail"
        eyebrow={t('platformAuthEmail.authEmailModule.platform')}
        titleAccent={t('platformAuthEmail.authEmailModule.titleAccent')}
        titlePlain={t('platformAuthEmail.authEmailModule.titlePlain')}
        pills={[
          <Chip key="ro" label={t('platformAuthEmail.authEmailModule.readOnly')} kind="info" size="xs" />,
          <span key="src" className="chip chip--xs">{t('platformAuthEmail.authEmailModule.managedByPlatformRelease')}</span>,
        ]}
        actions={
          policy
            ? [
                <Button
                  key="copy-raw"
                  label={t('platformAuthEmail.authEmailModule.copyRawJson')}
                  iconName="copy"
                  kind="ghost"
                  onClick={() => copy(t, policyJson(policy), t('platformAuthEmail.copy.rawPolicyJson'))}
                />,
              ]
            : []
        }
      />

      {policyQuery.isLoading || !policy ? (
        <StateView kind="loading" />
      ) : (
        <div
          style={{
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            overflow: 'auto',
          }}
        >
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="eyebrow">{t('platformAuthEmail.authEmailModule.environment')}</span>
              <Chip label={policy.env} kind="info" />
              {/*
                W27-cycle-D §10 — audit status chip resolves through the
                canonical `email_auth_audit_status` lookup catalog (green /
                yellow / red traffic-light) instead of the prior boolean
                green-vs-warn ternary. Default `'warn'` keeps the historical
                fallback when the policy file ships an unrecognized value.
              */}
              <Chip
                label={fill(t('platformAuthEmail.authEmailModule.audit'), { audit_status: String(policy.audit_status) })}
                kind={(lookupRow('email_auth_audit_status', policy.audit_status)?.tone as ChipKind | undefined) ?? 'warn'}
                size="xs"
              />
            </div>
            <div className="mono" style={{ fontSize: '11px', marginTop: '8px', color: 'var(--ink-3)' }}>
              {fill(t('platformAuthEmail.authEmailModule.lastReviewed'), { last_audit_at: String(policy.last_audit_at) })}
            </div>
            <div className="mono" style={{ fontSize: '11px', marginTop: '4px', color: 'var(--ink-3)' }}>
              {policy.source_file}
            </div>
            <div
              style={{
                fontSize: '11px',
                color: 'var(--ink-3)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>{t('platformAuthEmail.authEmailModule.managedThroughPlatformRelease')}</span>
              <button
                type="button"
                title={t('platformAuthEmail.authEmailModule.copyPolicyReference')}
                onClick={() => copy(t, policy.source_file, t('platformAuthEmail.copy.policyReference'))}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--line)',
                  padding: '0 6px',
                  fontSize: '9.5px',
                  cursor: 'pointer',
                  color: 'var(--ink-3)',
                  borderRadius: '3px',
                }}
                data-testid="auth-email-copy-source"
              >
                {t('platformAuthEmail.authEmailModule.copy')}
              </button>
            </div>
          </div>

          <div className="card">
            <div className="eyebrow">{fill(t('platformAuthEmail.authEmailModule.callbackUrls'), { length: String(policy.callback_urls.length) })}</div>
            <ul style={{ padding: 0, listStyle: 'none', marginTop: '6px' }}>
              {policy.callback_urls.map((u) => (
                <CopyableUrl key={u} url={u} />
              ))}
            </ul>
          </div>

          <div className="card">
            <div className="eyebrow">{fill(t('platformAuthEmail.authEmailModule.redirectUrls'), { length: String(policy.redirect_urls.length) })}</div>
            <ul style={{ padding: 0, listStyle: 'none', marginTop: '6px' }}>
              {policy.redirect_urls.map((u) => (
                <CopyableUrl key={u} url={u} />
              ))}
            </ul>
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="eyebrow">{t('platformAuthEmail.authEmailModule.policySummary')}</span>
              <div style={{ flex: 1 }} />
              <Button
                label={t('platformAuthEmail.authEmailModule.copy2')}
                iconName="copy"
                kind="ghost"
                size="sm"
                onClick={() => copy(t, policySummary(policy, t), t('platformAuthEmail.copy.policySummary'))}
              />
            </div>
            <div
              className="kvgrid"
              style={{
                background: 'var(--paper-3)',
                padding: '10px',
                borderRadius: '4px',
                margin: 0,
              }}
            >
              <div className="kvgrid__row">
                <span className="kvgrid__key">{t('platformAuthEmail.authEmailModule.environment')}</span>
                <span className="kvgrid__val">{policy.env}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">{t('platformAuthEmail.authEmailModule.auditStatus')}</span>
                <span className="kvgrid__val">{policy.audit_status}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">{t('platformAuthEmail.authEmailModule.lastReviewed2')}</span>
                <span className="kvgrid__val">{policy.last_audit_at}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">{t('platformAuthEmail.authEmailModule.callbackUrls2')}</span>
                <span className="kvgrid__val">{policy.callback_urls.length}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">{t('platformAuthEmail.authEmailModule.redirectUrls2')}</span>
                <span className="kvgrid__val">{policy.redirect_urls.length}</span>
              </div>
            </div>
          </div>

          <p className="state__hint">
            {t('platformAuthEmail.authEmailModule.hostedCallbackUrlsAre')}
          </p>
        </div>
      )}
    </div>
  );
}
