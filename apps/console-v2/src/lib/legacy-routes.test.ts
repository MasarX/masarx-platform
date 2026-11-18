import { describe, expect, it } from 'vitest';
import { resolveLegacyConsoleResourceRoute, resolveLegacyConsoleRoute } from './legacy-routes';

describe('resolveLegacyConsoleResourceRoute', () => {
  it('maps legacy Console resource URLs to Console V2 modules', () => {
    expect(resolveLegacyConsoleResourceRoute('shipments')).toBe('/operate/shipments');
    expect(resolveLegacyConsoleResourceRoute('SHIPMENTS')).toBe('/operate/shipments');
    expect(resolveLegacyConsoleResourceRoute('drivers')).toBe('/operate/fleet/drivers');
    expect(resolveLegacyConsoleResourceRoute('organizations')).toBe('/platform/organizations');
    expect(resolveLegacyConsoleResourceRoute('tenant-signup-requests')).toBe('/platform/organizations');
    expect(resolveLegacyConsoleResourceRoute('tenant_signup_requests')).toBe('/platform/organizations');
    expect(resolveLegacyConsoleResourceRoute('basket_items')).toBe('/operate/baskets');
    expect(resolveLegacyConsoleResourceRoute('basket_transitions')).toBe('/operate/baskets');
    expect(resolveLegacyConsoleResourceRoute('service_offerings')).toBe('/catalog/service-offerings');
    expect(resolveLegacyConsoleResourceRoute('service_offering_directory')).toBe('/catalog/service-offerings');
  });

  it('maps raw live-navigation resource keys to domain modules', () => {
    const liveResourceKeys = [
      'addresses',
      'api_call_log',
      'api_route_packs',
      'api_routes',
      'basket_items',
      'basket_transitions',
      'baskets',
      'clients',
      'decision_log',
      'field_mappings',
      'handling_units',
      'label_design_tokens',
      'label_jobs',
      'label_sections',
      'label_template_validation',
      'labels',
      'lookup_definitions',
      'lookup_values',
      'manual_review_tasks',
      'mapping_configs',
      'operation_templates',
      'organizations',
      'providers',
      'recipients',
      'return_to_branch_shipments',
      'route_plans',
      'route_stops',
      'routes',
      'scan_events',
      'senders',
      'service_offering_directory',
      'service_offerings',
      'service_levels',
      'settings_category_registry',
      'settings_resolution_log',
      'tenant_signup_requests',
      'shipment_actions',
      'shipment_boxes',
      'shipment_reference_numbers',
      'shipments',
      'user_devices',
      'users',
      'warehouse_transfer_items',
      'warehouse_transfers',
      'webhook_inbox',
      'webhook_log',
      'webhook_response_events',
      'webhook_response_history',
      'webhook_rules',
      'webhook_sources',
      'workflow_run_steps',
      'workflow_runs',
      'workflow_template_steps',
      'workflow_templates',
      'zone_districts',
      'zones',
    ];

    for (const key of liveResourceKeys) {
      expect(resolveLegacyConsoleResourceRoute(key), key).toMatch(/^\/(operate|network|customers|catalog|finance|workflows|integrations|insights|platform)/);
    }
  });

  it('fails closed for unknown legacy resources', () => {
    expect(resolveLegacyConsoleResourceRoute('not-a-module')).toBeNull();
  });
});

describe('resolveLegacyConsoleRoute', () => {
  it('maps live Console legacy routes to Console V2 workbenches', () => {
    expect(resolveLegacyConsoleRoute('/console')).toBe('/');
    expect(resolveLegacyConsoleRoute('/dashboard')).toBe('/');
    expect(resolveLegacyConsoleRoute('/overview')).toBe('/');
    expect(resolveLegacyConsoleRoute('/console/dashboard')).toBe('/');
    expect(resolveLegacyConsoleRoute('/organizations/requests')).toBe('/platform/organizations');
    expect(resolveLegacyConsoleRoute('/onboarding/readiness')).toBe('/platform/onboarding-readiness');
    expect(resolveLegacyConsoleRoute('/console/workflows/queue')).toBe('/workflows/review-queue');
    expect(resolveLegacyConsoleRoute('/console/workflows/templates')).toBe('/workflows/templates');
    expect(resolveLegacyConsoleRoute('/console/onboarding/readiness')).toBe('/platform/onboarding-readiness');
    expect(resolveLegacyConsoleRoute('/console/operations/customer-shipment-changes')).toBe('/operate/amend-cancel');
    expect(resolveLegacyConsoleRoute('/console/operations/exceptions/unassigned_exceptions')).toBe('/operate/exceptions');
    expect(resolveLegacyConsoleRoute('/console/integrations/provider-auth')).toBe('/integrations/credentials');
    expect(resolveLegacyConsoleRoute('/console/security/audit-logs')).toBe('/insights/audit');
    expect(resolveLegacyConsoleRoute('/labels/designer')).toBe('/platform/labels');
    expect(resolveLegacyConsoleRoute('/console/labels/designer')).toBe('/platform/labels');
  });

  it('fails closed for unknown legacy Console routes', () => {
    expect(resolveLegacyConsoleRoute('/console/unknown/route')).toBeNull();
  });
});
