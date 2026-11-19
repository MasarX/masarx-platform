// CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — TanStack Router file route for
// the alerts management surface. Module entry lives in
// `src/modules/platform/alerts.tsx`.
import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { AlertsModule } from '@/modules/platform/alerts';

export const Route = createFileRoute('/platform/alerts')({
  component: AlertsModule,
  head: () => buildRouteHead('/platform/alerts'),
});
