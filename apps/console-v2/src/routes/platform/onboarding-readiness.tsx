import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { OnboardingReadinessModule } from '@/modules/platform/onboarding-readiness';

export const Route = createFileRoute('/platform/onboarding-readiness')({
  component: OnboardingReadinessModule,
  head: () => buildRouteHead('/platform/onboarding-readiness'),
});
