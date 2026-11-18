import { createFileRoute, redirect } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';

export const Route = createFileRoute('/workflows/queue')({
  beforeLoad: () => {
    throw redirect({ to: '/workflows/review-queue' });
  },
  head: () => buildRouteHead('/workflows/queue'),
});
