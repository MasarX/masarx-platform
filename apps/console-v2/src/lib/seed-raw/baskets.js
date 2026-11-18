// baskets.js - Console V2 operations basket seed.
//
// Mirrors the canonical basket substrate from:
//   - supabase/migrations/202512261200_zones_baskets.sql
//   - supabase/migrations/202601071200_ui_read_registry_integrations.sql
//
// The tables are public.baskets, public.basket_items, and
// public.basket_transitions. Lookups are injected additively so the Console V2
// surface remains row-driven and does not edit the shared lookups.js file.

import { lookups } from './lookups.js';

Object.assign(lookups, {
  basket_state: [
    {
      value: 'forming',
      label: 'Forming',
      tone: 'info',
      rank: 10,
      is_default: true,
      metadata: { is_open: true, is_terminal: false, is_ready: false, is_exception: false, next_states: ['ready', 'expired'] },
    },
    {
      value: 'ready',
      label: 'Ready',
      tone: 'good',
      rank: 20,
      metadata: { is_open: true, is_terminal: false, is_ready: true, is_exception: false, next_states: ['reserved', 'expired'] },
    },
    {
      value: 'reserved',
      label: 'Reserved',
      tone: 'warn',
      rank: 30,
      metadata: { is_open: false, is_terminal: false, is_ready: false, is_exception: false, next_states: ['dispatched', 'expired'] },
    },
    {
      value: 'dispatched',
      label: 'Dispatched',
      tone: 'neutral',
      rank: 40,
      metadata: { is_open: false, is_terminal: true, is_ready: false, is_exception: false, next_states: [] },
    },
    {
      value: 'expired',
      label: 'Expired',
      tone: 'danger',
      rank: 50,
      metadata: { is_open: false, is_terminal: true, is_ready: false, is_exception: true, next_states: ['forming'] },
    },
  ],
  basket_type: [
    {
      value: 'zone_based',
      label: 'Zone-Based Basket',
      tone: 'info',
      rank: 10,
      is_default: true,
      metadata: { icon: 'map', default_capacity: 50, priority_weight: 1.0 },
    },
    {
      value: 'driver_specific',
      label: 'Driver-Specific Basket',
      tone: 'warn',
      rank: 20,
      metadata: { icon: 'user', default_capacity: 30, priority_weight: 1.5 },
    },
    {
      value: 'hub_pickup',
      label: 'Hub Pickup Basket',
      tone: 'neutral',
      rank: 30,
      metadata: { icon: 'warehouse', default_capacity: 100, priority_weight: 0.8 },
    },
  ],
  basket_policy_service_match_field: [
    {
      value: 'service_level',
      label: 'Service level',
      tone: 'info',
      rank: 10,
      is_default: true,
      metadata: { source_field: 'service_level_id' },
    },
    {
      value: 'service_type',
      label: 'Service type',
      tone: 'neutral',
      rank: 20,
      metadata: { source_field: 'service_type' },
    },
    {
      value: 'service_level_or_type',
      label: 'Service level, then type',
      tone: 'warn',
      rank: 30,
      metadata: { fallback_order: ['service_level_id', 'service_type'] },
    },
  ],
  basket_policy_route_key_path: [
    {
      value: 'routing.route_key',
      label: 'Shipment route key',
      tone: 'info',
      rank: 10,
      is_default: true,
      metadata: { source: 'shipment_routing' },
    },
    {
      value: 'dispatch.route_key',
      label: 'Dispatch route key',
      tone: 'neutral',
      rank: 20,
      metadata: { source: 'dispatch_context' },
    },
  ],
});

export const baskets = [
  {
    id: 'bsk_ruh_north_001',
    organization_id: 'org_rashed',
    zone_id: 'zn_ruh_north',
    basket_type: 'zone_based',
    state: 'forming',
    current_count: 3,
    capacity_count: 50,
    expires_at: '2026-05-03T15:00:00Z',
    version: 3,
    created_at: '2026-05-03T06:12:00Z',
    updated_at: '2026-05-03T08:35:00Z',
  },
  {
    id: 'bsk_ruh_south_001',
    organization_id: 'org_rashed',
    zone_id: 'zn_ruh_south',
    basket_type: 'zone_based',
    state: 'ready',
    current_count: 4,
    capacity_count: 50,
    expires_at: '2026-05-03T13:00:00Z',
    version: 6,
    created_at: '2026-05-03T05:44:00Z',
    updated_at: '2026-05-03T09:10:00Z',
  },
  {
    id: 'bsk_ruh_driver_019',
    organization_id: 'org_rashed',
    zone_id: 'zn_ruh_north',
    basket_type: 'driver_specific',
    state: 'reserved',
    current_count: 2,
    capacity_count: 30,
    expires_at: '2026-05-03T11:30:00Z',
    version: 4,
    created_at: '2026-05-03T04:20:00Z',
    updated_at: '2026-05-03T09:25:00Z',
  },
  {
    id: 'bsk_hub_pickup_001',
    organization_id: 'org_rashed',
    zone_id: null,
    basket_type: 'hub_pickup',
    state: 'dispatched',
    current_count: 1,
    capacity_count: 100,
    expires_at: null,
    version: 9,
    created_at: '2026-05-02T17:40:00Z',
    updated_at: '2026-05-03T07:58:00Z',
  },
  {
    id: 'bsk_ruh_expired_002',
    organization_id: 'org_rashed',
    zone_id: 'zn_ruh_diplomatic',
    basket_type: 'zone_based',
    state: 'expired',
    current_count: 1,
    capacity_count: 50,
    expires_at: '2026-05-03T07:00:00Z',
    version: 5,
    created_at: '2026-05-03T03:00:00Z',
    updated_at: '2026-05-03T07:02:00Z',
  },
];

export const basket_items = [
  { id: 'bsi_001', basket_id: 'bsk_ruh_north_001', shipment_id: 'shp_9381200', shipment_client_id: 'cl_exampleparcel_ksa', added_at: '2026-05-03T06:18:00Z', removed_at: null },
  { id: 'bsi_002', basket_id: 'bsk_ruh_north_001', shipment_id: 'shp_9381201', shipment_client_id: 'cl_examplemart_ksa', added_at: '2026-05-03T06:22:00Z', removed_at: null },
  { id: 'bsi_003', basket_id: 'bsk_ruh_north_001', shipment_id: 'shp_9381202', shipment_client_id: 'cl_exampleoutlet', added_at: '2026-05-03T06:27:00Z', removed_at: null },
  { id: 'bsi_004', basket_id: 'bsk_ruh_south_001', shipment_id: 'shp_9381203', shipment_client_id: 'cl_exampleretail', added_at: '2026-05-03T05:55:00Z', removed_at: null },
  { id: 'bsi_005', basket_id: 'bsk_ruh_south_001', shipment_id: 'shp_9381204', shipment_client_id: 'cl_exampleparcel_ksa', added_at: '2026-05-03T06:04:00Z', removed_at: null },
  { id: 'bsi_006', basket_id: 'bsk_ruh_south_001', shipment_id: 'shp_9381205', shipment_client_id: 'cl_examplemart_ksa', added_at: '2026-05-03T06:10:00Z', removed_at: null },
  { id: 'bsi_007', basket_id: 'bsk_ruh_south_001', shipment_id: 'shp_9381206', shipment_client_id: 'cl_exampleoutlet', added_at: '2026-05-03T06:18:00Z', removed_at: null },
  { id: 'bsi_008', basket_id: 'bsk_ruh_driver_019', shipment_id: 'shp_9381207', shipment_client_id: 'cl_exampleretail', added_at: '2026-05-03T04:48:00Z', removed_at: null },
  { id: 'bsi_009', basket_id: 'bsk_ruh_driver_019', shipment_id: 'shp_9381208', shipment_client_id: 'cl_exampleparcel_ksa', added_at: '2026-05-03T04:55:00Z', removed_at: null },
  { id: 'bsi_010', basket_id: 'bsk_hub_pickup_001', shipment_id: 'shp_9381209', shipment_client_id: 'cl_examplemart_ksa', added_at: '2026-05-02T18:05:00Z', removed_at: null },
  { id: 'bsi_011', basket_id: 'bsk_ruh_expired_002', shipment_id: 'shp_9381210', shipment_client_id: 'cl_exampleoutlet', added_at: '2026-05-03T03:30:00Z', removed_at: null },
];

export const basket_transitions = [
  {
    id: 'bst_001',
    basket_id: 'bsk_ruh_north_001',
    previous_state: null,
    new_state: 'forming',
    changed_at: '2026-05-03T06:12:00Z',
    changed_by: 'usr_admin_rashed',
    notes: 'Created by basket policy resort.',
  },
  {
    id: 'bst_002',
    basket_id: 'bsk_ruh_south_001',
    previous_state: 'forming',
    new_state: 'ready',
    changed_at: '2026-05-03T09:10:00Z',
    changed_by: 'usr_admin_rashed',
    notes: 'Capacity threshold reached for dispatch wave.',
  },
  {
    id: 'bst_003',
    basket_id: 'bsk_ruh_driver_019',
    previous_state: 'ready',
    new_state: 'reserved',
    changed_at: '2026-05-03T09:25:00Z',
    changed_by: 'usr_admin_rashed',
    notes: 'Reserved for driver handoff.',
  },
  {
    id: 'bst_004',
    basket_id: 'bsk_hub_pickup_001',
    previous_state: 'reserved',
    new_state: 'dispatched',
    changed_at: '2026-05-03T07:58:00Z',
    changed_by: 'usr_admin_rashed',
    notes: 'Scan-out reconciled.',
  },
  {
    id: 'bst_005',
    basket_id: 'bsk_ruh_expired_002',
    previous_state: 'reserved',
    new_state: 'expired',
    changed_at: '2026-05-03T07:02:00Z',
    changed_by: 'usr_admin_rashed',
    notes: 'Reservation expired before dispatch.',
  },
];
