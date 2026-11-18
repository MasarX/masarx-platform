import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { WebhookTesterModule } from '@/modules/integrations/webhook-tester';

export const Route = createFileRoute('/integrations/webhook-tester')({
  component: WebhookTesterModule,
  head: () => buildRouteHead('/integrations/webhook-tester'),
});
