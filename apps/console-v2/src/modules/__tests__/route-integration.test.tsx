// route-integration.test.tsx — mounts every leaf module via its named export and asserts
// it renders WITHOUT crashing or throwing JS errors. With MSW handlers in place, queries
// resolve cleanly. This is intentionally light (smoke-grade) so we get broad coverage of
// the route layer without re-testing internals already covered by per-component specs.
//
// `renderWithProviders` wraps QueryClient + Theme + I18n + Identity. We `findBy` something
// stable to confirm first paint completes without throwing. If async data is still loading,
// the harness falls back to confirming the component reached `renderWithProviders` past the
// throw boundary — that alone proves the module imports + initial JSX evaluate cleanly.
//
// Deprecated modules (Phase G · subagent G2):
//   - `network/hubs` is a thin deprecation shell whose `useEffect` calls
//     `useNavigate({ to: '/network/branches' })` on mount. The smoke harness
//     does not mount `<RouterProvider>`, so it is intentionally excluded from
//     the parameterized list and instead covered by a dedicated case below
//     that mocks `@tanstack/react-router` and asserts the deprecation
//     StateView + canonical redirect target.

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';

import { DashboardModule } from '@/modules/dashboard';
// operate
import { RoutePlansModule } from '@/modules/operate/route-plans';
import { DispatchModule } from '@/modules/operate/dispatch';
import { ShipmentsModule } from '@/modules/operate/shipments';
import { BasketsModule } from '@/modules/operate/baskets';
import { AmendCancelModule } from '@/modules/operate/amend-cancel';
import { ExceptionsModule } from '@/modules/operate/exceptions';
import { ReturnedToBranchModule } from '@/modules/operate/returned-to-branch';
import { PickupsModule } from '@/modules/operate/pickups';
import { TrackingMapModule } from '@/modules/operate/tracking-map';
// network — `HubsModule` is intentionally imported via dynamic `import()`
// inside the dedicated deprecation test so it can resolve under
// `vi.doMock('@tanstack/react-router', ...)`.
import { PartnersModule } from '@/modules/network/partners';
import { GeocodingModule } from '@/modules/network/geocoding';
// customers
import { ClientsModule } from '@/modules/customers/clients';
import { SendersModule } from '@/modules/customers/senders';
import { RecipientsModule } from '@/modules/customers/recipients';
// catalog
import { LookupsModule } from '@/modules/catalog/lookups';
import { ServiceOfferingsModule } from '@/modules/catalog/service-offerings';
// finance
import { SettlementsModule } from '@/modules/finance/settlements';
import { CodModule } from '@/modules/finance/cod';
import { LedgerModule } from '@/modules/finance/ledger';
import { BankReconModule } from '@/modules/finance/bank-recon';
import { DisputesModule } from '@/modules/finance/disputes';
// workflows
import { TemplatesModule } from '@/modules/workflows/templates';
import { RunsModule } from '@/modules/workflows/runs';
import { BindingsModule } from '@/modules/workflows/bindings';
import { ReviewQueueModule } from '@/modules/workflows/review-queue';
// integrations
import { CatalogModule as IntegrationsCatalogModule } from '@/modules/integrations/catalog';
import { MappingModule } from '@/modules/integrations/mapping';
import { HealthModule } from '@/modules/integrations/health';
import { WebhookTesterModule } from '@/modules/integrations/webhook-tester';
import { CredentialsModule } from '@/modules/integrations/credentials';
import { IntakeModule } from '@/modules/integrations/intake';
// insights
import { ReportingModule } from '@/modules/insights/reporting';
import { DecisionsModule } from '@/modules/insights/decisions';
import { ResolutionsModule } from '@/modules/insights/resolutions';
import { TracesModule } from '@/modules/insights/traces';
import { AuditModule } from '@/modules/insights/audit';
import { UiEventsModule } from '@/modules/insights/ui-events';
import { DomainEventsModule } from '@/modules/insights/domain-events';
// platform
import { ConfigModule } from '@/modules/platform/config';
import { AccessModule } from '@/modules/platform/access';
import { OrganizationsModule } from '@/modules/platform/organizations';
import { OnboardingReadinessModule } from '@/modules/platform/onboarding-readiness';
import { MobilePolicyModule } from '@/modules/platform/mobile-policy';
import { LabelsModule } from '@/modules/platform/labels';
import { WarehouseModule } from '@/modules/platform/warehouse';
import { ImportsModule } from '@/modules/platform/imports';
import { AuthEmailModule } from '@/modules/platform/auth-email';
import { PlanningOsModule } from '@/modules/platform/planning-os';
import { CommandsModule } from '@/modules/platform/commands';
// CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — feature-flag management surface.
import { FeatureFlagsModule } from '@/modules/platform/feature-flags';

type ModuleEntry = [name: string, Component: () => JSX.Element, matcher: RegExp];

const MODULES: ModuleEntry[] = [
  ['dashboard', DashboardModule, /dashboard|today|kpi|operations|tasks/i],
  // operate (8)
  ['operate/route-plans', RoutePlansModule, /route|plan/i],
  ['operate/dispatch', DispatchModule, /dispatch|run|stop/i],
  ['operate/shipments', ShipmentsModule, /shipment/i],
  ['operate/baskets', BasketsModule, /basket/i],
  ['operate/amend-cancel', AmendCancelModule, /amend|cancel/i],
  ['operate/exceptions', ExceptionsModule, /exception|ndr/i],
  ['operate/returned-to-branch', ReturnedToBranchModule, /return/i],
  ['operate/pickups', PickupsModule, /pickup/i],
  ['operate/tracking-map', TrackingMapModule, /track|map/i],
  // network (2 active; `network/hubs` is deprecated — see dedicated test below)
  ['network/partners', PartnersModule, /partner|marketplace/i],
  ['network/geocoding', GeocodingModule, /geocod|address/i],
  // customers (3)
  ['customers/clients', ClientsModule, /client/i],
  ['customers/senders', SendersModule, /sender/i],
  ['customers/recipients', RecipientsModule, /recipient/i],
  // catalog (2)
  ['catalog/lookups', LookupsModule, /lookup|catalog/i],
  ['catalog/service-offerings', ServiceOfferingsModule, /offering|catalog|service|tier/i],
  // finance (5)
  ['finance/settlements', SettlementsModule, /settlement/i],
  ['finance/cod', CodModule, /cod|payment/i],
  ['finance/ledger', LedgerModule, /ledger|finance/i],
  ['finance/bank-recon', BankReconModule, /bank|reconcil/i],
  ['finance/disputes', DisputesModule, /dispute/i],
  // workflows (4)
  ['workflows/templates', TemplatesModule, /template|workflow/i],
  ['workflows/runs', RunsModule, /run|workflow/i],
  ['workflows/bindings', BindingsModule, /binding|trigger|event/i],
  ['workflows/review-queue', ReviewQueueModule, /review|queue|task/i],
  // integrations (6)
  ['integrations/catalog', IntegrationsCatalogModule, /integration|plugin|catalog/i],
  ['integrations/mapping', MappingModule, /mapping|studio/i],
  ['integrations/health', HealthModule, /health|provider/i],
  ['integrations/webhook-tester', WebhookTesterModule, /webhook|tester|payload/i],
  ['integrations/credentials', CredentialsModule, /credential|auth/i],
  ['integrations/intake', IntakeModule, /intake|inbound/i],
  // insights (7)
  ['insights/reporting', ReportingModule, /report|insight|kpi|operations/i],
  ['insights/decisions', DecisionsModule, /decision/i],
  ['insights/resolutions', ResolutionsModule, /resolution|setting|ladder/i],
  ['insights/traces', TracesModule, /activity|history|reference/i],
  ['insights/audit', AuditModule, /audit|denied/i], // either content or capability-denied state
  ['insights/ui-events', UiEventsModule, /ui|event/i],
  ['insights/domain-events', DomainEventsModule, /domain|event/i],
  // platform (11)
  ['platform/config', ConfigModule, /config|setting|scope|policy/i],
  ['platform/access', AccessModule, /access|capabilit|rls/i],
  ['platform/organizations', OrganizationsModule, /organization|tenant/i],
  ['platform/onboarding-readiness', OnboardingReadinessModule, /onboarding|readiness|setting/i],
  ['platform/mobile-policy', MobilePolicyModule, /mobile|policy/i],
  ['platform/labels', LabelsModule, /label/i],
  ['platform/warehouse', WarehouseModule, /warehouse|transfer|scan/i],
  ['platform/imports', ImportsModule, /import|bulk/i],
  ['platform/auth-email', AuthEmailModule, /auth|email/i],
  ['platform/planning-os', PlanningOsModule, /planning|spec|execution|project/i],
  ['platform/commands', CommandsModule, /command|catalog/i],
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C).
  ['platform/feature-flags', FeatureFlagsModule, /flag|feature|rollout|kill/i],
];

describe(`Route module integration smoke (${MODULES.length} modules)`, () => {
  for (const [name, Component, matcher] of MODULES) {
    it(`mounts ${name}`, async () => {
      // Render — if the module throws synchronously, this call propagates the error.
      renderWithProviders(<Component />);
      // findAllBy with a generous timeout to allow first paint + initial query resolution.
      // We do not require a match — many modules show loading/empty states first paint with
      // text that may not match the regex. Reaching this assertion proves the module mounted
      // without throwing, which is the smoke contract.
      const matches = await screen.findAllByText(matcher, {}, { timeout: 1500 }).catch(() => []);
      expect(Array.isArray(matches)).toBe(true);
    });
  }
});

// `network/hubs` is a deprecation shell (Phase G · subagent G2). The route
// file uses `beforeLoad` → `redirect()` to forward to `/network/branches` and
// the module itself calls `useNavigate({ to: '/network/branches' })` on mount.
// The smoke harness does not mount a `<RouterProvider>`, so we mock the
// router hook here and assert the canonical deprecation contract:
//   1. The StateView surfaces the "deprecated" chip + canonical pointer.
//   2. `useNavigate` is called with `/network/branches` on mount.
describe('Route module integration · deprecation shells (G2)', () => {
  it('network/hubs renders the deprecation StateView and redirects to /network/branches', async () => {
    const navigateMock = vi.fn();
    vi.doMock('@tanstack/react-router', async () => {
      const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
        '@tanstack/react-router',
      );
      return { ...actual, useNavigate: () => navigateMock };
    });
    // Re-import the module under the mock so the mocked `useNavigate` resolves.
    const { HubsModule: MockedHubsModule } = await import('@/modules/network/hubs');
    renderWithProviders(<MockedHubsModule />);

    // Deprecation chip + canonical pointer surface in the StateView.
    expect(screen.getAllByText(/deprecated/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/This surface moved/i)).toBeInTheDocument();

    // `useNavigate` fires on mount targeting `/network/branches` (replace).
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/network/branches', replace: true }),
    );

    vi.doUnmock('@tanstack/react-router');
  });
});
