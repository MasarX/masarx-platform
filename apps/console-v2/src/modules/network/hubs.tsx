// hubs.tsx — DEPRECATED (Phase G · subagent G2).
//
// This module no longer renders an operator surface. The canonical model for
// hubs is `public.branches` with `branch_type = 'hub'` (see
// supabase/migrations/202601212340_branches_coverage_foundation.sql:6,39-40),
// fully wired by the Wave 1 / CLAIM-NETWORK-BRANCHES surface at
// `/network/branches`.
//
// The `/network/hubs` route file (`src/routes/network/hubs.tsx`) uses
// `beforeLoad` → `redirect()` to forward to `/network/branches` before this
// component renders. This file is kept as a thin deprecation shell so:
//
//   1. The TanStack Router generated tree (`src/routeTree.gen.ts`) keeps
//      its import target intact.
//   2. If the redirect is ever disabled (smoke-test override / replay),
//      operators see an explicit deprecation StateView with a button to the
//      canonical surface — never a blank page or stale fictional content.
//
// Decision document: `apps/console-v2/__audit__/DECISIONS/HUBS.md`.

import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useT } from '@/lib/i18n';

export function HubsModule() {
  const navigate = useNavigate();
  const t = useT();
  const canRead = useCapability(CAP.BRANCHES_READ);

  // Belt-and-braces: if `beforeLoad` redirect was disabled (replay / smoke
  // override), still forward operators on mount so the route never shows
  // legacy fictional content.
  useEffect(() => {
    void navigate({ to: '/network/branches', replace: true });
  }, [navigate]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          eyebrow={t('nav.network')}
          titleAccent={t('modules.hubs.accent')}
          titlePlain={t('hubs.deprecatedTitle')}
        />
        <StateView
          kind="denied"
          capability={CAP.BRANCHES_READ}
          hint={t('hubs.denied')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('nav.network')}
        titleAccent={t('modules.hubs.accent')}
        titlePlain={t('hubs.deprecatedTitle')}
        pills={[
          <Chip
            key="status"
            label={t('hubs.deprecated')}
            kind="warn"
            size="xs"
            className="mono"
          />,
          <Chip
            key="canonical"
            label={"branches.type='hub'" /* i18n-literal-ok: data model token */}
            kind="neutral"
            size="xs"
            className="mono"
          />,
        ]}
        actions={[]}
      />
      <StateView
        kind="empty"
        title={t('hubs.moved.title')}
        hint={
          <>
            {t('hubs.moved.lead')}{' '}
            <code className="mono">public.branches</code> ({/* i18n-literal-ok: table name */}
            <code className="mono">branch_type = 'hub'</code>). {t('hubs.moved.body')}{/* i18n-literal-ok: column value */}
          </>
        }
        action={
          <Button
            label={t('hubs.moved.open')}
            iconName="right"
            kind="primary"
            onClick={() => {
              void navigate({ to: '/network/branches', replace: true });
            }}
          />
        }
      />
    </div>
  );
}
