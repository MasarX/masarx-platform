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

interface AuthEmailPolicy {
  env: string;
  callback_urls: string[];
  redirect_urls: string[];
  source_file: string;
  last_audit_at: string;
  audit_status: string;
}

function copy(value: string, label: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(value)
      .then(() => pushToast(`Copied · ${label}`, 'good'))
      .catch(() => pushToast('Copy failed', 'danger'));
  } else {
    pushToast('Clipboard unavailable', 'warn');
  }
}

function policySummary(policy: AuthEmailPolicy): string {
  return [
    `Source file: ${policy.source_file}`,
    `Environment: ${policy.env}`,
    `Audit status: ${policy.audit_status}`,
    `Last reviewed: ${policy.last_audit_at}`,
    `Callback URLs: ${policy.callback_urls.length}`,
    `Redirect URLs: ${policy.redirect_urls.length}`,
  ].join('\n');
}

function policyJson(policy: AuthEmailPolicy): string {
  return JSON.stringify(policy, null, 2);
}

function CopyableUrl({ url }: { url: string }) {
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
        title="Copy URL"
        onClick={() => copy(url, 'url')}
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
        copy
      </button>
    </li>
  );
}

export function AuthEmailModule() {
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
          eyebrow="Platform"
          titleAccent="Auth email"
          titlePlain="URL policy"
        />
        <StateView
          kind="denied"
          capability={CAP.SETTINGS_READ}
          hint="You do not have permission to view the auth-email URL policy."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="authEmail"
        eyebrow="Platform"
        titleAccent="Auth email"
        titlePlain="URL policy"
        pills={[
          <Chip key="ro" label="read-only" kind="info" size="xs" />,
          <span key="src" className="chip chip--xs">Managed by platform release controls</span>,
        ]}
        actions={
          policy
            ? [
                <Button
                  key="copy-raw"
                  label="Copy raw JSON"
                  iconName="copy"
                  kind="ghost"
                  onClick={() => copy(policyJson(policy), 'raw policy JSON')}
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
              <span className="eyebrow">Environment</span>
              <Chip label={policy.env} kind="info" />
              {/*
                W27-cycle-D §10 — audit status chip resolves through the
                canonical `email_auth_audit_status` lookup catalog (green /
                yellow / red traffic-light) instead of the prior boolean
                green-vs-warn ternary. Default `'warn'` keeps the historical
                fallback when the policy file ships an unrecognized value.
              */}
              <Chip
                label={`audit ${policy.audit_status}`}
                kind={(lookupRow('email_auth_audit_status', policy.audit_status)?.tone as ChipKind | undefined) ?? 'warn'}
                size="xs"
              />
            </div>
            <div className="mono" style={{ fontSize: '11px', marginTop: '8px', color: 'var(--ink-3)' }}>
              {`Last reviewed: ${policy.last_audit_at}`}
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
              <span>Managed through platform release controls.</span>
              <button
                type="button"
                title="Copy policy reference"
                onClick={() => copy(policy.source_file, 'policy reference')}
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
                copy
              </button>
            </div>
          </div>

          <div className="card">
            <div className="eyebrow">{`Callback URLs · ${policy.callback_urls.length}`}</div>
            <ul style={{ padding: 0, listStyle: 'none', marginTop: '6px' }}>
              {policy.callback_urls.map((u) => (
                <CopyableUrl key={u} url={u} />
              ))}
            </ul>
          </div>

          <div className="card">
            <div className="eyebrow">{`Redirect URLs · ${policy.redirect_urls.length}`}</div>
            <ul style={{ padding: 0, listStyle: 'none', marginTop: '6px' }}>
              {policy.redirect_urls.map((u) => (
                <CopyableUrl key={u} url={u} />
              ))}
            </ul>
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="eyebrow">Policy summary</span>
              <div style={{ flex: 1 }} />
              <Button
                label="Copy"
                iconName="copy"
                kind="ghost"
                size="sm"
                onClick={() => copy(policySummary(policy), 'policy summary')}
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
                <span className="kvgrid__key">Environment</span>
                <span className="kvgrid__val">{policy.env}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">Audit status</span>
                <span className="kvgrid__val">{policy.audit_status}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">Last reviewed</span>
                <span className="kvgrid__val">{policy.last_audit_at}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">Callback URLs</span>
                <span className="kvgrid__val">{policy.callback_urls.length}</span>
              </div>
              <div className="kvgrid__row">
                <span className="kvgrid__key">Redirect URLs</span>
                <span className="kvgrid__val">{policy.redirect_urls.length}</span>
              </div>
            </div>
          </div>

          <p className="state__hint">
            Hosted callback URLs are governed by platform release controls. This page is read-only; changes are reviewed
            outside the console before promotion.
          </p>
        </div>
      )}
    </div>
  );
}
