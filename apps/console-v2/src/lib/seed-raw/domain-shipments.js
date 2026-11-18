// domain-shipments.js — shipments, boxes, recipients, addresses, geocodes
// Mirrors supabase/migrations/202510110006_domain_tables_partitioned.sql

const RIYADH_DISTRICTS = ['Olaya', 'Sulaymaniyah', 'Al-Malqa', 'Al-Yasmin', 'Al-Aqiq', 'Hittin', 'Al-Nakheel', 'Al-Wurud', 'Al-Murabba', 'Al-Rabwah'];
const NAMES_RECIPIENTS = ['Layla Al-Saud', 'Omar Al-Qahtani', 'Hessa Al-Dossari', 'Abdullah Al-Otaibi', 'Reem Al-Harbi', 'Saud Al-Ghamdi', 'Fatima Al-Zahrani', 'Khalid Al-Mutairi', 'Noura Al-Shehri', 'Bandar Al-Anazi'];

// Mirrors public.organizations. Canonical status column is `billing_status`
// (per supabase/migrations/202510110002_configuration_core.sql:14-26).
// `tenant_type` retained as a derived UI field (no canonical column; surfaced
// via metadata or org tier rollup).
export const organizations = [
  {
    id: 'org_rashed',
    name: 'Rashed Logistics',
    slug: 'rashed-logistics',
    timezone: 'Asia/Riyadh',
    locale: 'ar-SA',
    tenant_type: 'enterprise',
    billing_status: 'active',
    default_settings: {
      branding: {
        logo_url: 'https://assets.masarx.example/rashed-logo.svg',
        primary_color: '#0f766e',
        secondary_color: '#1d4ed8',
      },
    },
    created_at: '2024-08-12T00:00:00Z',
    updated_at: '2026-04-25T00:00:00Z',
  },
  {
    id: 'org_swift',
    name: 'Swift Express KSA',
    slug: 'swift-express-ksa',
    timezone: 'Asia/Riyadh',
    locale: 'en-US',
    tenant_type: 'enterprise',
    billing_status: 'active',
    default_settings: {
      branding: {
        logo_url: 'https://assets.masarx.example/swift-logo.svg',
        primary_color: '#2563eb',
      },
    },
    created_at: '2024-09-22T00:00:00Z',
    updated_at: '2026-04-25T00:00:00Z',
  },
];

// Clients — mirrors public.clients (supabase/migrations/202510110002_configuration_core.sql lines 66-97).
// `sla_tier` values resolve from the `sla_tier` lookup (economy|standard|premium per migration line 170-172);
// `priority` is intentionally normalised to `premium` so chips render with the canonical tone.
// W19-2 schema-drift cleanup: dropped fictional `code` field. Canonical key is `slug` per
// __audit__/SCHEMA-DRIFT/CUSTOMERS.md §1.
export const clients = [
  {
    id: 'cl_exampleparcel_ksa',
    organization_id: 'org_rashed',
    name: 'Exampleparcel KSA',
    slug: 'exampleparcel-ksa',
    status: 'active',
    sla_tier: 'premium',
    account_manager_id: 'usr_admin_rashed',
    contract_start_date: '2024-09-01',
    contract_end_date: '2027-08-31',
    suspension_reason: null,
    settings_override: { delivery_window_start: '08:00', delivery_window_end: '21:00' },
  },
  {
    id: 'cl_examplemart_ksa',
    organization_id: 'org_rashed',
    name: 'Examplemart KSA',
    slug: 'examplemart-ksa',
    status: 'active',
    sla_tier: 'standard',
    account_manager_id: 'usr_admin_rashed',
    contract_start_date: '2024-10-15',
    contract_end_date: '2026-10-14',
    suspension_reason: null,
    settings_override: null,
  },
  {
    id: 'cl_exampleoutlet',
    organization_id: 'org_rashed',
    name: 'Exampleoutlet Bookstore',
    slug: 'exampleoutlet',
    status: 'active',
    sla_tier: 'standard',
    account_manager_id: null,
    contract_start_date: '2025-01-01',
    contract_end_date: null,
    suspension_reason: null,
    settings_override: null,
  },
  {
    id: 'cl_exampleretail',
    organization_id: 'org_rashed',
    name: 'eXampleretail Stores',
    slug: 'exampleretail',
    status: 'active',
    sla_tier: 'premium',
    account_manager_id: 'usr_admin_rashed',
    contract_start_date: '2024-12-01',
    contract_end_date: '2027-11-30',
    suspension_reason: null,
    settings_override: null,
  },
];

// Senders — mirrors public.senders (supabase/migrations/202510110002_configuration_core.sql lines 103-126).
// W19-2 schema-drift cleanup: dropped fictional `organization_id` (resolved via client_id → clients.organization_id)
// and `source` (no `source` column; use `metadata.source` if needed) per __audit__/SCHEMA-DRIFT/CUSTOMERS.md §3.
export const senders = [
  { id: 'snd_examplemarket_jed_warehouse', client_id: 'cl_exampleparcel_ksa', name: 'Exampleparcel JED Warehouse', brand_name: 'Exampleparcel JED', auto_provisioned: true, auto_recreate: true, status: 'active', settings_override: null },
  { id: 'snd_examplemarket_ruh_warehouse', client_id: 'cl_exampleparcel_ksa', name: 'Exampleparcel RUH Warehouse', brand_name: 'Exampleparcel RUH', auto_provisioned: true, auto_recreate: true, status: 'active', settings_override: null },
  { id: 'snd_examplemart_ruh_dc', client_id: 'cl_examplemart_ksa', name: 'Examplemart RUH DC', brand_name: 'Examplemart DC', auto_provisioned: true, auto_recreate: true, status: 'active', settings_override: null },
  { id: 'snd_exampleoutlet_main', client_id: 'cl_exampleoutlet', name: 'Exampleoutlet Main Branch', brand_name: 'Exampleoutlet', auto_provisioned: false, auto_recreate: false, status: 'inactive', settings_override: { quiet_hours_start: '23:00' } },
];

// Recipients — mirrors public.recipients (supabase/migrations/202510110006_domain_tables_partitioned.sql lines 15-46).
// Field names align with the canonical column contract: `phone_number`, `preferred_language`,
// `preferred_comm_channel`, `phone_validation_status`, `external_id`. Phase G1 schema-drift fix
// removed the legacy aliases (`phone_e164`, `language`, `preferred_channel`) that were not on
// the canonical table — see __audit__/SCHEMA-DRIFT/CUSTOMERS.md §4.
const PHONE_VALIDATION_CYCLE = ['valid', 'pending', 'unverified', 'invalid'];
export const recipients = NAMES_RECIPIENTS.map((name, i) => {
  const phone = `+9665${String(11000000 + i * 137).slice(0, 8)}`;
  const language = i % 3 === 0 ? 'ar' : 'en';
  const channel = i % 2 === 0 ? 'whatsapp' : 'sms';
  const client = ['cl_exampleparcel_ksa', 'cl_examplemart_ksa', 'cl_exampleoutlet', 'cl_exampleretail'][i % 4];
  return {
    id: `rcp_${1000 + i}`,
    organization_id: 'org_rashed',
    client_id: client,
    external_id: `EXT-${(client || '').toUpperCase()}-${1000 + i}`,
    name,
    phone_number: phone,
    phone_validation_status: PHONE_VALIDATION_CYCLE[i % PHONE_VALIDATION_CYCLE.length],
    preferred_language: language,
    preferred_comm_channel: channel,
    quiet_hours_start: '22:00',
    quiet_hours_end: '08:00',
  };
});

// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §12 / §13):
//   • addresses.normalized_line1 ← canonical (FE alias `street`)
//   • geocodes.provider_name     ← canonical (FE alias `provider`)
//   • geocodes.confidence_score  ← canonical (FE alias `confidence`)
//   • geocodes.geocoded_at       ← canonical (FE alias `fetched_at`/`cached_at`)
// FE row resolvers (`addressStreetOf` / column render fallbacks) prefer
// canonical when present.
export const addresses = NAMES_RECIPIENTS.map((_, i) => {
  const street = `${100 + i * 7} Olaya St`;
  const recipient = recipients[i];
  return {
    id: `addr_${4700 + i}`,
    recipient_id: `rcp_${1000 + i}`,
    organization_id: recipient?.organization_id,
    client_id: recipient?.client_id,
    normalized_line1: street,
    street,
    district: RIYADH_DISTRICTS[i % RIYADH_DISTRICTS.length],
    city: 'Riyadh',
    country: 'SA',
    postal_code: `1${1000 + i * 13}`,
    validation_status: i % 8 === 0 ? 'pending' : 'verified',
  };
});

export const geocodes = addresses.map((addr, i) => {
  const provider = i % 3 === 0 ? 'here' : 'google';
  const confidence = 0.85 + (i % 10) * 0.012;
  const geocodedAt = '2026-04-24T10:00:00Z';
  return {
    id: `gc_${addr.id}`,
    address_id: addr.id,
    organization_id: addr.organization_id,
    // Riyadh ~24.7136°N, 46.6753°E — vary in a small area
    latitude: 24.7136 + ((i % 7) - 3) * 0.012,
    longitude: 46.6753 + ((i % 5) - 2) * 0.014,
    provider_name: provider,
    provider,
    confidence_score: confidence,
    confidence,
    geocoded_at: geocodedAt,
    cached_at: geocodedAt,
    fetched_at: geocodedAt,
  };
});

const SHIPMENT_STATUSES = ['pending', 'awaiting_pickup', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed_attempt', 'returned_to_branch'];
const SERVICE_TYPES = ['standard', 'express', 'same_day', 'pickup', 'rto'];

// W16-1 (OPERATIONS Section 1 cleanup): canonical `public.shipments` columns
// per migration 202510110006_domain_tables_partitioned.sql:56-106 do NOT
// include `weight_kg`, `fragile`, `hazmat` — those live on `public.shipment_boxes`
// (per-box). The seed used to materialise shipment-level aggregates that fed
// per-box derivation; those fields are dropped from the `shipments` rows and
// the derivation is re-rooted directly inside `shipment_boxes` so the seed
// shape matches the canonical contract.
//
// `origin_city` was also fictional on `public.shipments` — origin lives on
// `addresses` joined via `origin_address_id`. It is dropped here.
// `destination_city` is retained ONLY as a documented projection alias for
// the registry seam (resolves via `addresses.city` joined through
// `destination_address_id`); the alias is cited in
// `__audit__/SCHEMA-DRIFT/OPERATIONS.md` §1 and consumed by FE renderers
// until the registry-side projection lands.
export const shipments = Array.from({ length: 60 }, (_, i) => {
  const tracking = `SHP-9381${String(200 + i).padStart(3, '0')}`;
  const recip = recipients[i % recipients.length];
  const addr = addresses[i % addresses.length];
  const status = SHIPMENT_STATUSES[i % SHIPMENT_STATUSES.length];
  const service = SERVICE_TYPES[i % SERVICE_TYPES.length];
  const cod = (i % 4 === 0) ? 0 : (120 + (i * 37) % 800);
  const client = clients[i % clients.length];
  const sender = senders[i % senders.length];
  return {
    id: `shp_938${String(1200 + i).padStart(4, '0')}`,
    tracking_number: tracking,
    // W19-2: derive from canonical `slug` (uppercased) since `code` was dropped
    // per __audit__/SCHEMA-DRIFT/CUSTOMERS.md §1.
    client_reference_number: `${(client.slug || '').toUpperCase().replace(/-/g, '_')}-${10000 + i}`,
    carrier_reference_number: i % 3 === 0 ? `NQL-${20000 + i}` : null,
    client_id: client.id,
    sender_id: sender.id,
    organization_id: 'org_rashed',
    recipient_id: recip.id,
    destination_address_id: addr.id,
    service_type: service,
    status,
    cod_amount: cod,
    cod_currency: 'SAR',
    promised_delivery_date: '2026-04-25T18:00:00Z',
    box_count: 1 + (i % 3),
    created_at: '2026-04-24T08:00:00Z',
    updated_at: '2026-04-25T11:30:00Z',
    // Documented FE projection alias (NOT a canonical column on
    // `public.shipments`). Resolves through `addresses.city` joined via
    // `destination_address_id`. Retained here until the registry-side
    // projection (`ui_read_registry.shipments` enrichment) lands.
    destination_city: 'Riyadh',
    // W13-2: `risk_flag` was a fictional column on public.shipments. Risk is
    // FE-derived via `isShipmentRisk()` in modules/operate/shipments.tsx
    // (status=failed_attempt OR OFD past promised_delivery_date), so the seed
    // no longer materialises a fake column. Until a backend resolver
    // (`resolve_shipment_risk_v1(shipment_id)`) lands, callers compute risk
    // from canonical fields only.
    // W16-1: `weight_kg`, `fragile`, `hazmat`, `origin_city` dropped — see
    // header comment for canonical mapping.
  };
});

// W16-1: per-box `weight_kg` / `fragile` are now derived deterministically
// from the shipment id index (mirrors the prior derivation but without
// requiring shipment-level aggregate fields that don't exist canonically on
// `public.shipments`).
export const shipment_boxes = shipments.flatMap((shp) => {
  const shpIndex = parseInt(String(shp.id).replace(/[^0-9]/g, '').slice(-4), 10) || 0;
  const totalWeight = 0.5 + (shpIndex % 10) * 0.4;
  const fragile = shpIndex % 9 === 0;
  return Array.from({ length: shp.box_count }, (_, bi) => ({
    id: `sbx_${shp.id}_${bi + 1}`,
    shipment_id: shp.id,
    box_number: bi + 1,
    barcode: `${shp.tracking_number}:${bi + 1}`,
    weight_kg: totalWeight / shp.box_count,
    fragile,
  }));
});

// CLAIM-OPERATIONS-WIRING (Phase C1) — comms_attempts seam for shipment
// drawer "Comms" tab (replaces the 2-row literal in shipments.tsx CommsTab).
// Production swap: read from public.comms_attempts via
// `ui_list_resource_v1('comms_attempts', { filter: { shipment_id }})`.
export const comms_attempts = shipments.slice(0, 12).flatMap((shp, i) => [
  { id: `ca_${shp.id}_1`, shipment_id: shp.id, occurred_at: '2026-04-25T07:48:00Z', channel: 'whatsapp', template: 'pickup_eta', status: 'delivered', recipient_id: shp.recipient_id ?? null, locale: 'ar' },
  { id: `ca_${shp.id}_2`, shipment_id: shp.id, occurred_at: '2026-04-25T11:32:00Z', channel: 'sms', template: 'out_for_delivery', status: i % 5 === 0 ? 'failed' : 'delivered', recipient_id: shp.recipient_id ?? null, locale: 'ar' },
]);

// CLAIM-OPERATIONS-WIRING (Phase C1) — wave_catalog seam for route-plans.tsx
// (replaces the 3-row literal `WAVE_PRESETS`). The canonical SSOT is the
// settings_versions / lookup_definitions surface for `pickup_policy`'s wave
// windows; the operator-facing catalog is row-driven so adding a new wave
// preset is a config change, not a code change. Production swap:
// `ui_list_resource_v1('wave_catalog')` against the projection migration
// (Phase G follow-up; today the in-memory adapter mirrors the canonical
// shape: id + label + window_start + window_end + active flag).
export const wave_catalog = [
  { id: 'wave_morning', label: 'Morning (06:00–10:00)', window_start: '06:00', window_end: '10:00', active: true, sort_order: 1 },
  { id: 'wave_afternoon', label: 'Afternoon (10:00–14:00)', window_start: '10:00', window_end: '14:00', active: true, sort_order: 2 },
  { id: 'wave_evening', label: 'Evening (14:00–18:00)', window_start: '14:00', window_end: '18:00', active: true, sort_order: 3 },
];

// Sample timeline for one detail view
export function shipmentTimeline(shipmentId) {
  const sequences = [
    { time: '2026-04-24T08:14Z', action: 'Shipment created', detail: 'Inbound webhook · Exampleparcel KSA · mapping_config exampleparcel_ksa_v3.shipment_inbound', status: 'done' },
    { time: '2026-04-24T08:16Z', action: 'Sorted to wave', detail: 'route.allow_partial_publish=true · wave RUH-N-W2', status: 'done' },
    { time: '2026-04-24T08:24Z', action: 'Plan published', detail: 'PLN-2026-0418-RUH-N · execution pack hash 0x8a31…', status: 'done' },
    { time: '2026-04-25T07:48Z', action: 'Picked up', detail: 'Driver Khalid Al-Otaibi · VAN-118 · scan_event verified', status: 'done' },
    { time: '2026-04-25T11:32Z', action: 'Out for delivery', detail: 'Stop sequence #9 · ETA 14:00–16:00', status: 'done' },
    { time: '2026-04-25T13:30Z', action: 'On approach', detail: 'Driving lock active (driver_safety_policy)', status: 'pending' },
  ];
  return sequences;
}
