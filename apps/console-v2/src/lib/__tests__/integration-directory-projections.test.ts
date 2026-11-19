import { describe, expect, it } from 'vitest';
import {
  projectMappingConfigDirectory,
  projectWebhookSourceDirectory,
} from '@/lib/data-source/integration-directory-projections';

describe('integration directory projections', () => {
  it('projects webhook source binding labels and archive lifecycle for mapping readback', () => {
    const rows = projectWebhookSourceDirectory({
      clients: [{ id: 'cl_unit', name: 'Unit client' }],
      senders: [{ id: 'snd_unit', client_id: 'cl_unit', name: 'Unit sender', brand_name: 'Unit sender brand' }],
      mapping_configs: [{ id: 'mc_unit', mapping_key: 'unit.mapping', mapping_config: { label: 'Unit mapping' } }],
      webhook_sources: [
        {
          id: 'whs_unit',
          organization_id: 'org_unit',
          source_identifier: 'unit-source',
          name: 'Unit source',
          provider_type: 'generic',
          mapping_config_id: 'mc_unit',
          sender_id: 'snd_unit',
          enabled: false,
          archived_at: '2026-05-07T00:00:00.000Z',
          archive_reason: 'Unit archive',
        },
      ],
      webhook_inbox: [],
      webhook_rules: [{ webhook_source_id: 'whs_unit', enabled: true }],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'whs_unit',
        source_label: 'Unit source',
        source_identifier: 'unit-source',
        mapping_config_id: 'mc_unit',
        mapping_label: 'Unit mapping',
        sender_id: 'snd_unit',
        sender_label: 'Unit sender brand',
        client_id: 'cl_unit',
        client_label: 'Unit client',
        enabled: false,
        lifecycle_state: 'archived',
        archived_at: '2026-05-07T00:00:00.000Z',
        archive_reason: 'Unit archive',
        rule_count: 1,
        active_rule_count: 1,
      }),
    ]);
  });

  it('counts API Gateway route usage by id and canonical key-only mapping references', () => {
    const rows = projectMappingConfigDirectory({
      mapping_configs: [
        {
          id: 'mc_api_route',
          organization_id: 'org_unit',
          mapping_type: 'api_gateway_inbound',
          mapping_key: 'tenant.default.shipment.create',
          mapping_config: { target: 'shipments.create', rules: [] },
          updated_at: '2026-05-31T00:00:00.000Z',
        },
      ],
      webhook_sources: [],
      webhook_rules: [],
      api_route_packs: [
        { id: 'pack_disabled', enabled: false },
      ],
      api_routes: [
        {
          enabled: true,
          policy: {
            request_mapping: {
              mapping_config_id: 'mc_api_route',
              mapping_key: 'tenant.default.shipment.create',
              mapping_type: 'api_gateway_inbound',
            },
          },
        },
        {
          enabled: true,
          policy: {
            request_mapping: {
              mapping_key: 'tenant.default.shipment.create',
              mapping_type: 'api_gateway_inbound',
            },
          },
        },
        {
          enabled: false,
          policy: {
            request_mapping: {
              mapping_key: 'tenant.default.shipment.create',
              mapping_type: 'api_gateway_inbound',
            },
          },
        },
        {
          enabled: true,
          pack_id: 'pack_disabled',
          policy: {
            request_mapping: {
              mapping_key: 'tenant.default.shipment.create',
              mapping_type: 'api_gateway_inbound',
            },
          },
        },
      ],
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: 'mc_api_route',
        api_route_count: 2,
        is_in_use: true,
      }),
    );
  });
});
