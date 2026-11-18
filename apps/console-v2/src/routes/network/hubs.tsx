// /network/hubs — DEPRECATED (Phase G · subagent G2).
//
// The canonical model for hubs lives at `public.branches` with
// `branch_type = 'hub'` (see
// supabase/migrations/202601212340_branches_coverage_foundation.sql:6,39-40
// and apps/console-v2/__audit__/DECISIONS/HUBS.md). This route now redirects
// to the canonical `/network/branches` surface so legacy in-app links do not
// dead-end.
//
// The route registration stays in place because the generated TanStack Router
// tree (`src/routeTree.gen.ts`) references it; the `beforeLoad` redirect
// short-circuits the navigation before `HubsModule` would render. The module
// itself is also kept as a deprecation marker in case the redirect is ever
// disabled — see `src/modules/network/hubs.tsx` for the StateView shell.

import { createFileRoute, redirect } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { HubsModule } from '@/modules/network/hubs';

export const Route = createFileRoute('/network/hubs')({
  beforeLoad: () => {
    throw redirect({
      to: '/network/branches',
      replace: true,
    });
  },
  component: HubsModule,
  head: () => buildRouteHead('/network/hubs'),
});
