// CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — TanStack file-route shim that
// mounts the operator API gateway observability surface
// (Datadog APM / Honeycomb / Postman parity).
import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ApiGatewayModule } from '@/modules/insights/api-gateway';

export const Route = createFileRoute('/insights/api-gateway')({
  component: ApiGatewayModule,
  head: () => buildRouteHead('/insights/api-gateway'),
});
