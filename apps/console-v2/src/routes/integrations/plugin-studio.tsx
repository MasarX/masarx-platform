import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { PluginStudioModule } from '@/modules/integrations/plugin-studio';

export const Route = createFileRoute('/integrations/plugin-studio')({
  component: PluginStudioModule,
  head: () => buildRouteHead('/integrations/plugin-studio'),
});
