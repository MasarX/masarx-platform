// __root.tsx — root layout. Renders <AppShell /> which itself contains <Outlet />.
// Router context type carries `queryClient` (provided in App.tsx) so loaders can prefetch.
import { createRootRouteWithContext } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from '@/shell/AppShell';
import '@/styles/index.css';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
});
