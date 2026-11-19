// warehouse.js — warehouse_transfers, warehouse_transfer_items, warehouse_exception_hold, scan_events (warehouse_checkpoint)
// AGENTS.md lines 39-40 (warehouse SSOT, sequence-enforced checkpoint scanning).
//
// W11-3 schema-drift remediation (PLATFORM §10) — paired projection view
// `public.v_warehouse_transfer_summary` (migration 202604301500) is the
// canonical SSOT for FE-shaped aggregates. Seed entries below carry the
// derived fields inline (`item_count`, `received_count`, `variance_count`,
// `variance_flag`, `posted_at`, `hold_reason`) so the seed-mode projection
// (data-source.ts:_projectWarehouseTransferSummary) mirrors the view shape.
// Canonical column names (transfer_code/from_branch_id/to_branch_id) are also
// surfaced inline alongside the FE-friendly aliases (transfer_id/origin_hub/
// destination_hub) so the registry-driven swap is non-breaking.

export const warehouse_transfers = [
  { id: 'wtr_2026_0481', transfer_id: 'WTR-2026-0481', transfer_code: 'WTR-2026-0481', origin_hub: 'JED-N', destination_hub: 'RUH-N', from_branch_id: 'JED-N', to_branch_id: 'RUH-N', item_count: 142, received_count: 138, variance_count: 4, variance_flag: true, variance_pct: 2.8, hold_reason: 'Variance > tolerance · supervisor approval required', status: 'on_hold', dispatched_at: '2026-04-25T05:00:00Z', received_at: '2026-04-25T11:50:00Z', posted_at: '2026-04-25T11:50:00Z', updated_at: '2026-04-25T11:50:00Z' },
  { id: 'wtr_2026_0480', transfer_id: 'WTR-2026-0480', transfer_code: 'WTR-2026-0480', origin_hub: 'RUH-S', destination_hub: 'RUH-N', from_branch_id: 'RUH-S', to_branch_id: 'RUH-N', item_count: 64, received_count: 64, variance_count: 0, variance_flag: false, status: 'reconciled', dispatched_at: '2026-04-25T03:00:00Z', received_at: '2026-04-25T08:32:00Z', posted_at: '2026-04-25T08:32:00Z', updated_at: '2026-04-25T08:32:00Z' },
  { id: 'wtr_2026_0479', transfer_id: 'WTR-2026-0479', transfer_code: 'WTR-2026-0479', origin_hub: 'DMM-C', destination_hub: 'RUH-N', from_branch_id: 'DMM-C', to_branch_id: 'RUH-N', item_count: 88, received_count: 88, variance_count: 0, variance_flag: false, status: 'received', dispatched_at: '2026-04-24T22:00:00Z', received_at: '2026-04-25T07:14:00Z', posted_at: '2026-04-25T07:14:00Z', updated_at: '2026-04-25T07:14:00Z' },
  { id: 'wtr_2026_0478', transfer_id: 'WTR-2026-0478', transfer_code: 'WTR-2026-0478', origin_hub: 'JED-N', destination_hub: 'DMM-C', from_branch_id: 'JED-N', to_branch_id: 'DMM-C', item_count: 110, received_count: 0, variance_count: 110, variance_flag: false, status: 'in_transit', dispatched_at: '2026-04-25T05:00:00Z', received_at: null, posted_at: '2026-04-25T05:00:00Z', updated_at: '2026-04-25T05:00:00Z' },
  { id: 'wtr_2026_0477', transfer_id: 'WTR-2026-0477', transfer_code: 'WTR-2026-0477', origin_hub: 'RUH-N', destination_hub: 'JED-N', from_branch_id: 'RUH-N', to_branch_id: 'JED-N', item_count: 40, received_count: 0, variance_count: 40, variance_flag: false, status: 'draft', dispatched_at: null, received_at: null, posted_at: null, updated_at: '2026-04-24T18:00:00Z' },
  { id: 'wtr_2026_0476', transfer_id: 'WTR-2026-0476', transfer_code: 'WTR-2026-0476', origin_hub: 'JED-N', destination_hub: 'RUH-N', from_branch_id: 'JED-N', to_branch_id: 'RUH-N', item_count: 1, received_count: 0, variance_count: 1, variance_flag: false, status: 'draft', dispatched_at: null, received_at: null, posted_at: null, updated_at: '2026-04-24T17:30:00Z' },
  { id: 'wtr_2026_0475', transfer_id: 'WTR-2026-0475', transfer_code: 'WTR-2026-0475', origin_hub: 'DMM-C', destination_hub: 'JED-N', from_branch_id: 'DMM-C', to_branch_id: 'JED-N', item_count: 1, received_count: 0, variance_count: 1, variance_flag: false, status: 'draft', dispatched_at: null, received_at: null, posted_at: null, updated_at: '2026-04-24T17:00:00Z' },
];

export const warehouse_transfer_items = [
  { id: 'wti_001', transfer_id: 'wtr_2026_0481', shipment_id: 'shp_9381247', expected: 1, received: 1, status: 'received' },
  { id: 'wti_002', transfer_id: 'wtr_2026_0481', shipment_id: 'shp_9381301', expected: 1, received: 1, status: 'received' },
  { id: 'wti_003', transfer_id: 'wtr_2026_0481', shipment_id: 'shp_9381322', expected: 1, received: 0, status: 'missing' },
  { id: 'wti_004', transfer_id: 'wtr_2026_0481', shipment_id: 'shp_9381418', expected: 1, received: 0, status: 'missing' },
  { id: 'wti_005', transfer_id: 'wtr_2026_0476', shipment_id: 'shp_9381502', expected: 1, received: 0, status: 'packed' },
  { id: 'wti_006', transfer_id: 'wtr_2026_0475', shipment_id: 'shp_9381503', expected: 1, received: 0, status: 'staged' },
];

export const warehouse_exception_hold = [
  { id: 'weh_771', transfer_id: 'wtr_2026_0481', kind: 'variance', notes: '4 missing items · 2.8% variance · awaiting recount', supervisor_approval_task_id: 'tsk_4001', created_at: '2026-04-25T11:50:00Z' },
];

export const warehouse_checkpoint_scans = [
  { id: 'wcs_1001', transfer_id: 'wtr_2026_0479', shipment_id: 'shp_9381247', checkpoint: 'origin_scan_in', sequence: 1, occurred_at: '2026-04-24T18:30:00Z', user_id: 'usr_whs_supervisor_dmm' },
  { id: 'wcs_1002', transfer_id: 'wtr_2026_0479', shipment_id: 'shp_9381247', checkpoint: 'staging_scan_in', sequence: 2, occurred_at: '2026-04-25T03:14:00Z', user_id: 'usr_whs_supervisor_dmm' },
  { id: 'wcs_1003', transfer_id: 'wtr_2026_0479', shipment_id: 'shp_9381247', checkpoint: 'load_scan_out', sequence: 3, occurred_at: '2026-04-25T05:30:00Z', user_id: 'usr_whs_supervisor_ruh' },
  { id: 'wcs_1004', transfer_id: 'wtr_2026_0479', shipment_id: 'shp_9381247', checkpoint: 'destination_scan_in', sequence: 4, occurred_at: '2026-04-25T07:14:00Z', user_id: 'usr_whs_supervisor_ruh' },
];
