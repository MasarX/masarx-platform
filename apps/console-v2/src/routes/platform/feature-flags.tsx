import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { FeatureFlagsModule } from '@/modules/platform/feature-flags';

// CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — LaunchDarkly/Unleash/GrowthBook
// parity feature-flag management surface. Mirrors public.feature_flags.
export const Route = createFileRoute('/platform/feature-flags')({
  component: FeatureFlagsModule,
  head: () => buildRouteHead('/platform/feature-flags'),
});
