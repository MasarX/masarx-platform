// labels.js — labels, label_versions, label_sections, label_tokens, label_template_specs, label_jobs (target-neutral)
// AGENTS.md line 14: label_jobs target-neutral; label_artifacts canonical persistence path.
//
// W14-7 — `active_version_id` is no longer seeded at the top level of
// `label_template_specs` rows. Canonical `public.label_template_specs` has
// no such column; it stores `version INT` directly and the active-version
// pointer is projected through canonical `renderer_config.active_version_id`
// jsonb until a paired `v_label_template_spec_summary` projection view ships.
// `target_type` is similarly dropped from `label_jobs` rows: canonical
// `public.label_jobs` uses explicit `shipment_id` / `shipment_box_id` plus
// `renderer_metadata.manifest_kind` for non-shipment manifests; the FE
// derives the polymorphic descriptor via `targetTypeOf` (labels.tsx).

export const label_template_specs = [
  { id: 'lts_4x6_thermal', name: '4×6 Thermal · Standard', dimensions: '4×6 in', dpi: 203, barcode_format: 'CODE128', renderer_config: { active_version_id: 'lvs_4x6_thermal_v3' } },
  { id: 'lts_a6_inkjet', name: 'A6 Inkjet · Color', dimensions: 'A6 (105×148mm)', dpi: 300, barcode_format: 'QR', renderer_config: { active_version_id: 'lvs_a6_inkjet_v2' } },
  { id: 'lts_a4_handover', name: 'A4 Partner handover manifest', dimensions: 'A4 (210×297mm)', dpi: 300, barcode_format: 'GS1_128', renderer_config: { active_version_id: 'lvs_a4_handover_v1' } },
];

export const label_versions = [
  { id: 'lvs_4x6_thermal_v3', spec_id: 'lts_4x6_thermal', version: 'v3.0', status: 'active', created_at: '2026-03-12T10:00:00Z', created_by: 'usr_admin_rashed' },
  { id: 'lvs_4x6_thermal_v2', spec_id: 'lts_4x6_thermal', version: 'v2.0', status: 'archived', created_at: '2026-01-15T10:00:00Z' },
  { id: 'lvs_a6_inkjet_v2', spec_id: 'lts_a6_inkjet', version: 'v2.1', status: 'active', created_at: '2026-04-08T11:00:00Z' },
  { id: 'lvs_a4_handover_v1', spec_id: 'lts_a4_handover', version: 'v1.0', status: 'active', created_at: '2026-02-20T09:00:00Z' },
];

export const label_sections = [
  { id: 'lsc_4x6_header', version_id: 'lvs_4x6_thermal_v3', name: 'header', x: 4, y: 4, w: 392, h: 80, kind: 'composite' },
  { id: 'lsc_4x6_recipient', version_id: 'lvs_4x6_thermal_v3', name: 'recipient', x: 4, y: 88, w: 392, h: 96, kind: 'address' },
  { id: 'lsc_4x6_barcode', version_id: 'lvs_4x6_thermal_v3', name: 'barcode', x: 4, y: 188, w: 392, h: 80, kind: 'barcode' },
  { id: 'lsc_4x6_meta', version_id: 'lvs_4x6_thermal_v3', name: 'meta', x: 4, y: 272, w: 392, h: 100, kind: 'meta' },
  { id: 'lsc_4x6_footer', version_id: 'lvs_4x6_thermal_v3', name: 'footer', x: 4, y: 376, w: 392, h: 32, kind: 'static' },
];

export const label_tokens = [
  { id: 'ltk_recipient_name', section_id: 'lsc_4x6_recipient', token: '{recipient.name}', resolver: 'shipment.recipient_id → recipients.name' },
  { id: 'ltk_recipient_addr', section_id: 'lsc_4x6_recipient', token: '{recipient.address}', resolver: 'shipment.destination_address_id → addresses.formatted' },
  { id: 'ltk_tracking', section_id: 'lsc_4x6_barcode', token: '{shipment.tracking_number}', resolver: 'shipment.tracking_number' },
  { id: 'ltk_box_barcode', section_id: 'lsc_4x6_barcode', token: '{box.barcode}', resolver: 'shipment_boxes.barcode' },
  { id: 'ltk_service', section_id: 'lsc_4x6_meta', token: '{shipment.service_type}', resolver: 'shipment.service_type' },
  { id: 'ltk_cod', section_id: 'lsc_4x6_meta', token: '{shipment.cod_amount}', resolver: 'shipment.cod_amount' },
  { id: 'ltk_promised', section_id: 'lsc_4x6_meta', token: '{shipment.promised_delivery_date}', resolver: 'shipment.promised_delivery_date' },
];

export const label_jobs = [
  { id: 'lj_8821', label_id: 'lbl_shp_9381247_1', target_id: 'shp_9381247', target_box_id: 'sbx_shp_9381247_1', target_metadata: { box_index: 1 }, spec_id: 'lts_4x6_thermal', status: 'completed', queued_at: '2026-04-24T08:20:00Z', completed_at: '2026-04-24T08:20:08Z', file_url: '/storage/labels/shp_9381247-1.pdf' },
  { id: 'lj_8820', label_id: 'lbl_shp_9381301_1', target_id: 'shp_9381301', target_box_id: 'sbx_shp_9381301_1', target_metadata: { box_index: 1 }, spec_id: 'lts_4x6_thermal', status: 'completed', queued_at: '2026-04-24T08:21:00Z', completed_at: '2026-04-24T08:21:09Z', file_url: '/storage/labels/shp_9381301-1.pdf' },
  { id: 'lj_8819', target_id: 'run_2845', target_box_id: null, target_metadata: { manifest_kind: 'partner_handover' }, spec_id: 'lts_a4_handover', status: 'queued', queued_at: '2026-04-25T13:00:00Z', completed_at: null, file_url: null },
  { id: 'lj_8818', target_id: 'wtr_2026_0481', target_box_id: null, target_metadata: { manifest_kind: 'transfer_summary' }, spec_id: 'lts_a4_handover', status: 'completed', queued_at: '2026-04-25T07:30:00Z', completed_at: '2026-04-25T07:30:11Z', file_url: '/storage/labels/wtr_2026_0481.pdf' },
];

export const labels = [
  { id: 'lbl_shp_9381247_1', shipment_id: 'shp_9381247', barcode: 'SHP-9381247:1', active_version_id: 'lvs_4x6_thermal_v3', print_count: 1, last_printed_at: '2026-04-24T08:20:08Z' },
  { id: 'lbl_shp_9381301_1', shipment_id: 'shp_9381301', barcode: 'SHP-9381301:1', active_version_id: 'lvs_4x6_thermal_v3', print_count: 2, last_printed_at: '2026-04-25T09:14:00Z', reprint_reason: 'Damaged in transit' },
];
