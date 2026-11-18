import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ReviewQueueModule } from '@/modules/workflows/review-queue';

export const Route = createFileRoute('/workflows/review-queue')({
  component: ReviewQueueModule,
  head: () => buildRouteHead('/workflows/review-queue'),
});
