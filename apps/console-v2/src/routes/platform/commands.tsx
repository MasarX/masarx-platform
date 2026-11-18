import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { CommandsModule } from '@/modules/platform/commands';

export const Route = createFileRoute('/platform/commands')({
  component: CommandsModule,
  head: () => buildRouteHead('/platform/commands'),
});
