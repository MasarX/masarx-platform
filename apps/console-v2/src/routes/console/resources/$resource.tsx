import { createFileRoute, redirect } from '@tanstack/react-router';
import { resolveLegacyHashNavigation } from '@/lib/legacy-hash-navigation';
import { resolveLegacyConsoleResourceRoute } from '@/lib/legacy-routes';

export const Route = createFileRoute('/console/resources/$resource')({
  beforeLoad: ({ params, location }) => {
    const search =
      typeof location.search === 'object' && location.search !== null
        ? (location.search as Record<string, unknown>)
        : {};
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (value == null) continue;
      searchParams.set(key, String(value));
    }
    const normalized = resolveLegacyHashNavigation(
      `/console/resources/${params.resource}${searchParams.size ? `?${searchParams.toString()}` : ''}`,
    );
    const target = normalized?.to ?? resolveLegacyConsoleResourceRoute(params.resource);
    throw redirect({
      to: target ?? '/',
      search: normalized?.search ?? search,
      replace: true,
    });
  },
});
