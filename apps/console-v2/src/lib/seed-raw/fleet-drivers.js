// fleet-drivers.js — CLAIM-FLEET-DRIVERS (Wave 1, Phase A) seed.
//
// Mirrors the canonical enterprise-ops driver projection from
// `supabase/migrations/202601311230_enterprise_ops_v1.sql` lines 333-440:
//   • driver_profiles (org-scoped projection of users + license/contact metadata)
//   • driver_documents (license/insurance/medical/permit registry with verify state)
//   • driver_compliance_events (immutable ledger of compliance decisions)
//
// Demo dataset shape (additive only — does not touch the existing
// `domain-routes.drivers` array which models route_run drivers, not the new
// driver_profiles roster). Twelve drivers were chosen so the page demonstrates:
//   • status mix (active / inactive / suspended) per canonical
//     `driver_status` lookup. Live duty granularity (on_shift / on_break /
//     off_duty) lives on `hours_of_service_state` — see FLEET Wave 5
//     RE-AUDIT D4 closure (apps/console-v2/__audit__/REAUDIT/FLEET.md §3).
//   • license expiry mix (some <7d, some 7-30d, some long-tail) so ExpiryChip
//     can demonstrate every tone bucket
//   • compliance score mix so KPI tones differ
//   • document expiry rotation across all 4 doc kinds for the worst-of chip
//
// The reference time anchor is **2026-04-26** (matches the seeded shipments /
// route_plans cohort in the rest of the demo seed). Dates are computed by hand
// against this anchor — no Date.now() because seed must stay deterministic.

// Anchor: 2026-04-26 (today in demo). All `expires_at` / `occurred_at` values
// below are calibrated against this anchor so ExpiryChip thresholds (warn=30d,
// danger=7d) demonstrate every state at first paint.

export const driver_profiles = [
  {
    id: 'drvp_khalid',
    user_id: 'usr_dr_khalid',
    organization_id: 'org_rashed',
    name: 'Khalid Al-Otaibi',
    initials: 'KA',
    license_number: 'KSA-DRV-44A1-0118',
    license_class: 'C+E (heavy)',
    license_expires_at: '2027-09-12',
    current_vehicle_id: 'veh_van_118',
    current_branch_id: 'hub_ruh_n',
    status: 'active',
    hours_of_service_state: 'driving',
    compliance_score: 96,
    phone: '+447 70 090 0103',
    emergency_contact_name: 'Layla Al-Otaibi (spouse)',
    emergency_contact_phone: '+447 70 090 0122',
    hired_at: '2022-04-12',
    deliveries_today: 18,
    deliveries_week: 92,
    on_time_pct: 0.96,
    customer_rating: 4.8,
  },
  {
    id: 'drvp_mohammed',
    user_id: 'usr_dr_mohammed',
    organization_id: 'org_rashed',
    name: 'Mohammed Hassan',
    initials: 'MH',
    license_number: 'KSA-DRV-44A1-0204',
    license_class: 'C (commercial)',
    // Anchor 2026-04-26 → 5 days out → ExpiryChip tone:danger
    license_expires_at: '2026-05-01',
    current_vehicle_id: 'veh_van_204',
    current_branch_id: 'hub_ruh_n',
    status: 'active',
    hours_of_service_state: 'on_duty',
    compliance_score: 78,
    phone: '+447 70 090 0101',
    emergency_contact_name: 'Hassan Al-Misri (father)',
    emergency_contact_phone: '+447 70 090 0125',
    hired_at: '2023-01-22',
    deliveries_today: 14,
    deliveries_week: 71,
    on_time_pct: 0.91,
    customer_rating: 4.5,
  },
  {
    id: 'drvp_faisal',
    user_id: 'usr_dr_faisal',
    organization_id: 'org_rashed',
    name: 'Faisal Al-Harbi',
    initials: 'FH',
    license_number: 'KSA-DRV-22B2-0022',
    license_class: 'A (motorcycle)',
    license_expires_at: '2028-02-19',
    current_vehicle_id: 'veh_bike_22',
    current_branch_id: 'hub_jed_n',
    status: 'active',
    hours_of_service_state: 'driving',
    compliance_score: 88,
    phone: '+447 70 090 0130',
    emergency_contact_name: 'Sara Al-Harbi (mother)',
    emergency_contact_phone: '+447 70 090 0112',
    hired_at: '2024-06-04',
    deliveries_today: 27,
    deliveries_week: 142,
    on_time_pct: 0.94,
    customer_rating: 4.6,
  },
  {
    id: 'drvp_tariq',
    user_id: 'usr_dr_tariq',
    organization_id: 'org_rashed',
    name: 'Tariq Al-Mutairi',
    initials: 'TM',
    license_number: 'KSA-DRV-77C3-0091',
    license_class: 'C+E (heavy) · hazmat',
    // Anchor 2026-04-26 → 22 days out → ExpiryChip tone:warn
    license_expires_at: '2026-05-18',
    current_vehicle_id: 'veh_van_091',
    current_branch_id: 'hub_dmm_c',
    status: 'active',
    hours_of_service_state: 'off_duty',
    compliance_score: 84,
    phone: '+447 70 090 0118',
    emergency_contact_name: 'Nora Al-Mutairi (spouse)',
    emergency_contact_phone: '+447 70 090 0116',
    hired_at: '2021-11-08',
    deliveries_today: 9,
    deliveries_week: 58,
    on_time_pct: 0.89,
    customer_rating: 4.3,
  },
  {
    id: 'drvp_yousef',
    user_id: 'usr_dr_yousef',
    organization_id: 'org_rashed',
    name: 'Yousef Al-Shehri',
    initials: 'YS',
    license_number: 'KSA-DRV-44A1-0156',
    license_class: 'C (commercial)',
    license_expires_at: '2027-01-30',
    current_vehicle_id: 'veh_van_156',
    current_branch_id: 'hub_ruh_s',
    status: 'active',
    hours_of_service_state: 'driving',
    compliance_score: 92,
    phone: '+447 70 090 0106',
    emergency_contact_name: 'Mansour Al-Shehri (brother)',
    emergency_contact_phone: '+447 70 090 0127',
    hired_at: '2022-09-17',
    deliveries_today: 16,
    deliveries_week: 84,
    on_time_pct: 0.95,
    customer_rating: 4.7,
  },
  {
    id: 'drvp_ahmed',
    user_id: 'usr_dr_ahmed',
    organization_id: 'org_rashed',
    name: 'Ahmed Bin Salem',
    initials: 'AB',
    license_number: 'KSA-DRV-44A1-0077',
    license_class: 'C (commercial)',
    license_expires_at: '2027-12-04',
    current_vehicle_id: 'veh_van_077',
    current_branch_id: 'hub_ruh_n',
    status: 'inactive',
    hours_of_service_state: 'off_duty',
    compliance_score: 90,
    phone: '+447 70 090 0113',
    emergency_contact_name: 'Salma Bin Salem (spouse)',
    emergency_contact_phone: '+447 70 090 0104',
    hired_at: '2023-04-30',
    deliveries_today: 0,
    deliveries_week: 64,
    on_time_pct: 0.93,
    customer_rating: 4.6,
  },
  {
    id: 'drvp_omar',
    user_id: 'usr_dr_omar',
    organization_id: 'org_rashed',
    name: 'Omar Al-Qahtani',
    initials: 'OQ',
    license_number: 'KSA-DRV-77C3-0155',
    license_class: 'C+E (heavy)',
    // Anchor 2026-04-26 → 3 days out → ExpiryChip tone:danger
    license_expires_at: '2026-04-29',
    current_vehicle_id: null,
    current_branch_id: 'hub_dmm_c',
    status: 'suspended',
    hours_of_service_state: 'off_duty',
    compliance_score: 41,
    phone: '+447 70 090 0128',
    emergency_contact_name: 'Reem Al-Qahtani (sister)',
    emergency_contact_phone: '+447 70 090 0117',
    hired_at: '2020-08-19',
    deliveries_today: 0,
    deliveries_week: 12,
    on_time_pct: 0.74,
    customer_rating: 3.9,
  },
  {
    id: 'drvp_saleh',
    user_id: 'usr_dr_saleh',
    organization_id: 'org_rashed',
    name: 'Saleh Al-Dosari',
    initials: 'SD',
    license_number: 'KSA-DRV-22B2-0088',
    license_class: 'A (motorcycle)',
    // Anchor 2026-04-26 → 18 days out → ExpiryChip tone:warn
    license_expires_at: '2026-05-14',
    current_vehicle_id: 'veh_bike_88',
    current_branch_id: 'hub_jed_n',
    status: 'active',
    hours_of_service_state: 'driving',
    compliance_score: 87,
    phone: '+447 70 090 0107',
    emergency_contact_name: 'Hanan Al-Dosari (spouse)',
    emergency_contact_phone: '+447 70 090 0124',
    hired_at: '2024-02-11',
    deliveries_today: 23,
    deliveries_week: 121,
    on_time_pct: 0.92,
    customer_rating: 4.4,
  },
  {
    id: 'drvp_nasser',
    user_id: 'usr_dr_nasser',
    organization_id: 'org_rashed',
    name: 'Nasser Al-Ghamdi',
    initials: 'NG',
    license_number: 'KSA-DRV-44A1-0220',
    license_class: 'C (commercial)',
    license_expires_at: '2027-06-22',
    current_vehicle_id: 'veh_van_220',
    current_branch_id: 'hub_ruh_s',
    status: 'active',
    hours_of_service_state: 'off_duty',
    compliance_score: 81,
    phone: '+447 70 090 0114',
    emergency_contact_name: 'Mohammed Al-Ghamdi (father)',
    emergency_contact_phone: '+447 70 090 0109',
    hired_at: '2023-08-03',
    deliveries_today: 11,
    deliveries_week: 74,
    on_time_pct: 0.88,
    customer_rating: 4.2,
  },
  {
    id: 'drvp_bandar',
    user_id: 'usr_dr_bandar',
    organization_id: 'org_rashed',
    name: 'Bandar Al-Jabri',
    initials: 'BJ',
    license_number: 'KSA-DRV-44A1-0301',
    license_class: 'C+E (heavy)',
    license_expires_at: '2028-11-09',
    current_vehicle_id: 'veh_van_301',
    current_branch_id: 'hub_jed_n',
    status: 'active',
    hours_of_service_state: 'driving',
    compliance_score: 94,
    phone: '+447 70 090 0131',
    emergency_contact_name: 'Yara Al-Jabri (spouse)',
    emergency_contact_phone: '+447 70 090 0121',
    hired_at: '2021-05-26',
    deliveries_today: 21,
    deliveries_week: 110,
    on_time_pct: 0.97,
    customer_rating: 4.9,
  },
  {
    id: 'drvp_majed',
    user_id: 'usr_dr_majed',
    organization_id: 'org_rashed',
    name: 'Majed Al-Khaldi',
    initials: 'MK',
    license_number: 'KSA-DRV-77C3-0408',
    license_class: 'C (commercial) · hazmat',
    license_expires_at: '2027-03-15',
    current_vehicle_id: 'veh_van_408',
    current_branch_id: 'hub_ruh_n',
    status: 'inactive',
    hours_of_service_state: 'off_duty',
    compliance_score: 86,
    phone: '+447 70 090 0105',
    emergency_contact_name: 'Aisha Al-Khaldi (mother)',
    emergency_contact_phone: '+447 70 090 0115',
    hired_at: '2022-12-19',
    deliveries_today: 0,
    deliveries_week: 51,
    on_time_pct: 0.9,
    customer_rating: 4.5,
  },
  {
    id: 'drvp_hamad',
    user_id: 'usr_dr_hamad',
    organization_id: 'org_rashed',
    name: 'Hamad Al-Suwailem',
    initials: 'HS',
    license_number: 'KSA-DRV-22B2-0162',
    license_class: 'A (motorcycle)',
    // Anchor 2026-04-26 → 11 days out → ExpiryChip tone:warn
    license_expires_at: '2026-05-07',
    current_vehicle_id: 'veh_bike_62',
    current_branch_id: 'hub_dmm_c',
    status: 'active',
    hours_of_service_state: 'on_duty',
    compliance_score: 79,
    phone: '+447 70 090 0129',
    emergency_contact_name: 'Khalid Al-Suwailem (brother)',
    emergency_contact_phone: '+447 70 090 0111',
    hired_at: '2024-09-08',
    deliveries_today: 19,
    deliveries_week: 98,
    on_time_pct: 0.86,
    customer_rating: 4.1,
  },
];

// driver_documents — 4-5 docs per driver covering license/insurance/medical/permit
// with mixed expiry windows so the worst-of expiry chip animates per driver.
// status ∈ {submitted, verified, rejected, expired} mirrors the canonical
// driver_document_status lookup posture (one row of each surfaces in the demo).

function isoDate(year, month, day) {
  // Helper to keep dates literal while readable.
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export const driver_documents = [
  // --- Khalid (drvp_khalid) — strong compliance ---
  { id: 'drvd_khalid_lic', driver_id: 'drvp_khalid', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_khalid_2024', issued_at: isoDate(2022, 9, 12), expires_at: isoDate(2027, 9, 12), verified_at: '2024-09-15T08:22:00Z', status: 'verified' },
  { id: 'drvd_khalid_ins', driver_id: 'drvp_khalid', kind: 'insurance', issuer: 'Tawuniya', file_ref: 'art_ins_khalid_2025', issued_at: isoDate(2025, 1, 1), expires_at: isoDate(2026, 12, 31), verified_at: '2025-01-08T09:14:00Z', status: 'verified' },
  { id: 'drvd_khalid_med', driver_id: 'drvp_khalid', kind: 'medical', issuer: 'Saudi German Hospital', file_ref: 'art_med_khalid_2025', issued_at: isoDate(2025, 6, 4), expires_at: isoDate(2027, 6, 4), verified_at: '2025-06-09T10:00:00Z', status: 'verified' },
  { id: 'drvd_khalid_prm', driver_id: 'drvp_khalid', kind: 'permit', issuer: 'Riyadh Municipality', file_ref: 'art_prm_khalid_2025', issued_at: isoDate(2025, 3, 1), expires_at: isoDate(2027, 3, 1), verified_at: '2025-03-04T11:32:00Z', status: 'verified' },

  // --- Mohammed (drvp_mohammed) — license imminent ---
  { id: 'drvd_mohammed_lic', driver_id: 'drvp_mohammed', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_mohammed_2021', issued_at: isoDate(2021, 5, 1), expires_at: isoDate(2026, 5, 1), verified_at: '2021-05-08T08:00:00Z', status: 'verified' },
  { id: 'drvd_mohammed_ins', driver_id: 'drvp_mohammed', kind: 'insurance', issuer: 'Bupa Arabia', file_ref: 'art_ins_mohammed_2025', issued_at: isoDate(2025, 1, 1), expires_at: isoDate(2026, 12, 31), verified_at: '2025-01-12T09:01:00Z', status: 'verified' },
  { id: 'drvd_mohammed_med', driver_id: 'drvp_mohammed', kind: 'medical', issuer: 'Dr Sulaiman Al Habib', file_ref: 'art_med_mohammed_2024', issued_at: isoDate(2024, 11, 1), expires_at: isoDate(2026, 11, 1), verified_at: '2024-11-04T08:42:00Z', status: 'verified' },
  { id: 'drvd_mohammed_prm', driver_id: 'drvp_mohammed', kind: 'permit', issuer: 'Riyadh Municipality', file_ref: 'art_prm_mohammed_2024', issued_at: isoDate(2024, 6, 11), expires_at: isoDate(2026, 6, 11), verified_at: '2024-06-15T13:20:00Z', status: 'verified' },

  // --- Faisal (drvp_faisal) — bike, complete ---
  { id: 'drvd_faisal_lic', driver_id: 'drvp_faisal', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_faisal_2024', issued_at: isoDate(2024, 2, 19), expires_at: isoDate(2028, 2, 19), verified_at: '2024-02-22T07:55:00Z', status: 'verified' },
  { id: 'drvd_faisal_ins', driver_id: 'drvp_faisal', kind: 'insurance', issuer: 'Tawuniya', file_ref: 'art_ins_faisal_2026', issued_at: isoDate(2026, 1, 1), expires_at: isoDate(2027, 12, 31), verified_at: '2026-01-09T10:14:00Z', status: 'verified' },
  { id: 'drvd_faisal_med', driver_id: 'drvp_faisal', kind: 'medical', issuer: 'Jeddah National Hospital', file_ref: 'art_med_faisal_2024', issued_at: isoDate(2024, 6, 1), expires_at: isoDate(2026, 6, 1), verified_at: '2024-06-04T08:00:00Z', status: 'verified' },

  // --- Tariq (drvp_tariq) — hazmat permit needs review ---
  { id: 'drvd_tariq_lic', driver_id: 'drvp_tariq', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_tariq_2021', issued_at: isoDate(2021, 5, 18), expires_at: isoDate(2026, 5, 18), verified_at: '2021-05-23T09:11:00Z', status: 'verified' },
  { id: 'drvd_tariq_ins', driver_id: 'drvp_tariq', kind: 'insurance', issuer: 'Walaa', file_ref: 'art_ins_tariq_2025', issued_at: isoDate(2025, 3, 1), expires_at: isoDate(2027, 2, 28), verified_at: '2025-03-04T08:30:00Z', status: 'verified' },
  { id: 'drvd_tariq_med', driver_id: 'drvp_tariq', kind: 'medical', issuer: 'Mouwasat Hospital', file_ref: 'art_med_tariq_2024', issued_at: isoDate(2024, 12, 1), expires_at: isoDate(2026, 12, 1), verified_at: '2024-12-04T11:42:00Z', status: 'verified' },
  { id: 'drvd_tariq_prm', driver_id: 'drvp_tariq', kind: 'permit', issuer: 'Hazmat Authority KSA', file_ref: 'art_prm_tariq_2026', issued_at: isoDate(2026, 4, 12), expires_at: isoDate(2028, 4, 12), verified_at: null, status: 'submitted' },

  // --- Yousef (drvp_yousef) ---
  { id: 'drvd_yousef_lic', driver_id: 'drvp_yousef', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_yousef_2024', issued_at: isoDate(2022, 1, 30), expires_at: isoDate(2027, 1, 30), verified_at: '2022-02-02T08:00:00Z', status: 'verified' },
  { id: 'drvd_yousef_ins', driver_id: 'drvp_yousef', kind: 'insurance', issuer: 'Tawuniya', file_ref: 'art_ins_yousef_2025', issued_at: isoDate(2025, 1, 1), expires_at: isoDate(2026, 12, 31), verified_at: '2025-01-09T08:30:00Z', status: 'verified' },
  { id: 'drvd_yousef_med', driver_id: 'drvp_yousef', kind: 'medical', issuer: 'Saudi German Hospital', file_ref: 'art_med_yousef_2025', issued_at: isoDate(2025, 4, 12), expires_at: isoDate(2027, 4, 12), verified_at: '2025-04-15T09:00:00Z', status: 'verified' },
  { id: 'drvd_yousef_prm', driver_id: 'drvp_yousef', kind: 'permit', issuer: 'Riyadh Municipality', file_ref: 'art_prm_yousef_2025', issued_at: isoDate(2025, 8, 1), expires_at: isoDate(2027, 8, 1), verified_at: '2025-08-03T12:11:00Z', status: 'verified' },

  // --- Ahmed (drvp_ahmed) ---
  { id: 'drvd_ahmed_lic', driver_id: 'drvp_ahmed', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_ahmed_2024', issued_at: isoDate(2022, 12, 4), expires_at: isoDate(2027, 12, 4), verified_at: '2022-12-08T08:18:00Z', status: 'verified' },
  { id: 'drvd_ahmed_ins', driver_id: 'drvp_ahmed', kind: 'insurance', issuer: 'Bupa Arabia', file_ref: 'art_ins_ahmed_2025', issued_at: isoDate(2025, 6, 1), expires_at: isoDate(2027, 5, 31), verified_at: '2025-06-04T08:55:00Z', status: 'verified' },
  { id: 'drvd_ahmed_med', driver_id: 'drvp_ahmed', kind: 'medical', issuer: 'Dr Sulaiman Al Habib', file_ref: 'art_med_ahmed_2025', issued_at: isoDate(2025, 5, 1), expires_at: isoDate(2027, 5, 1), verified_at: '2025-05-04T09:11:00Z', status: 'verified' },
  { id: 'drvd_ahmed_prm', driver_id: 'drvp_ahmed', kind: 'permit', issuer: 'Riyadh Municipality', file_ref: 'art_prm_ahmed_2025', issued_at: isoDate(2025, 1, 11), expires_at: isoDate(2027, 1, 11), verified_at: '2025-01-15T08:42:00Z', status: 'verified' },

  // --- Omar (drvp_omar) — suspended; rejected medical + expired permit ---
  { id: 'drvd_omar_lic', driver_id: 'drvp_omar', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_omar_2021', issued_at: isoDate(2020, 4, 29), expires_at: isoDate(2026, 4, 29), verified_at: '2020-05-04T08:00:00Z', status: 'verified' },
  { id: 'drvd_omar_ins', driver_id: 'drvp_omar', kind: 'insurance', issuer: 'Walaa', file_ref: 'art_ins_omar_2025', issued_at: isoDate(2025, 1, 1), expires_at: isoDate(2026, 12, 31), verified_at: '2025-01-22T09:00:00Z', status: 'verified' },
  { id: 'drvd_omar_med', driver_id: 'drvp_omar', kind: 'medical', issuer: 'Dr Sulaiman Al Habib', file_ref: 'art_med_omar_2025', issued_at: isoDate(2025, 11, 1), expires_at: isoDate(2027, 11, 1), verified_at: null, status: 'rejected' },
  // permit expired in past relative to anchor 2026-04-26 → ExpiryChip danger / "expired"
  { id: 'drvd_omar_prm', driver_id: 'drvp_omar', kind: 'permit', issuer: 'Hazmat Authority KSA', file_ref: 'art_prm_omar_2024', issued_at: isoDate(2024, 1, 1), expires_at: isoDate(2026, 3, 31), verified_at: '2024-01-04T08:00:00Z', status: 'expired' },

  // --- Saleh (drvp_saleh) ---
  { id: 'drvd_saleh_lic', driver_id: 'drvp_saleh', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_saleh_2024', issued_at: isoDate(2024, 5, 14), expires_at: isoDate(2026, 5, 14), verified_at: '2024-05-19T08:11:00Z', status: 'verified' },
  { id: 'drvd_saleh_ins', driver_id: 'drvp_saleh', kind: 'insurance', issuer: 'Tawuniya', file_ref: 'art_ins_saleh_2025', issued_at: isoDate(2025, 5, 1), expires_at: isoDate(2027, 4, 30), verified_at: '2025-05-04T09:30:00Z', status: 'verified' },
  { id: 'drvd_saleh_med', driver_id: 'drvp_saleh', kind: 'medical', issuer: 'Jeddah National Hospital', file_ref: 'art_med_saleh_2025', issued_at: isoDate(2025, 8, 12), expires_at: isoDate(2027, 8, 12), verified_at: '2025-08-15T08:00:00Z', status: 'verified' },
  { id: 'drvd_saleh_prm', driver_id: 'drvp_saleh', kind: 'permit', issuer: 'Jeddah Municipality', file_ref: 'art_prm_saleh_2025', issued_at: isoDate(2025, 2, 1), expires_at: isoDate(2027, 2, 1), verified_at: '2025-02-04T08:42:00Z', status: 'verified' },

  // --- Nasser (drvp_nasser) ---
  { id: 'drvd_nasser_lic', driver_id: 'drvp_nasser', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_nasser_2024', issued_at: isoDate(2022, 6, 22), expires_at: isoDate(2027, 6, 22), verified_at: '2022-06-26T08:21:00Z', status: 'verified' },
  { id: 'drvd_nasser_ins', driver_id: 'drvp_nasser', kind: 'insurance', issuer: 'Bupa Arabia', file_ref: 'art_ins_nasser_2025', issued_at: isoDate(2025, 4, 1), expires_at: isoDate(2027, 3, 31), verified_at: '2025-04-04T09:11:00Z', status: 'verified' },
  { id: 'drvd_nasser_med', driver_id: 'drvp_nasser', kind: 'medical', issuer: 'Saudi German Hospital', file_ref: 'art_med_nasser_2025', issued_at: isoDate(2025, 9, 8), expires_at: isoDate(2027, 9, 8), verified_at: '2025-09-12T08:00:00Z', status: 'verified' },

  // --- Bandar (drvp_bandar) — pristine ---
  { id: 'drvd_bandar_lic', driver_id: 'drvp_bandar', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_bandar_2024', issued_at: isoDate(2023, 11, 9), expires_at: isoDate(2028, 11, 9), verified_at: '2023-11-13T08:34:00Z', status: 'verified' },
  { id: 'drvd_bandar_ins', driver_id: 'drvp_bandar', kind: 'insurance', issuer: 'Tawuniya', file_ref: 'art_ins_bandar_2026', issued_at: isoDate(2026, 1, 1), expires_at: isoDate(2027, 12, 31), verified_at: '2026-01-09T08:11:00Z', status: 'verified' },
  { id: 'drvd_bandar_med', driver_id: 'drvp_bandar', kind: 'medical', issuer: 'Jeddah National Hospital', file_ref: 'art_med_bandar_2025', issued_at: isoDate(2025, 5, 26), expires_at: isoDate(2027, 5, 26), verified_at: '2025-05-30T09:01:00Z', status: 'verified' },
  { id: 'drvd_bandar_prm', driver_id: 'drvp_bandar', kind: 'permit', issuer: 'Jeddah Municipality', file_ref: 'art_prm_bandar_2025', issued_at: isoDate(2025, 7, 1), expires_at: isoDate(2027, 7, 1), verified_at: '2025-07-04T08:00:00Z', status: 'verified' },

  // --- Majed (drvp_majed) ---
  { id: 'drvd_majed_lic', driver_id: 'drvp_majed', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_majed_2024', issued_at: isoDate(2022, 3, 15), expires_at: isoDate(2027, 3, 15), verified_at: '2022-03-19T08:11:00Z', status: 'verified' },
  { id: 'drvd_majed_ins', driver_id: 'drvp_majed', kind: 'insurance', issuer: 'Walaa', file_ref: 'art_ins_majed_2025', issued_at: isoDate(2025, 6, 1), expires_at: isoDate(2027, 5, 31), verified_at: '2025-06-04T09:14:00Z', status: 'verified' },
  { id: 'drvd_majed_med', driver_id: 'drvp_majed', kind: 'medical', issuer: 'Dr Sulaiman Al Habib', file_ref: 'art_med_majed_2025', issued_at: isoDate(2025, 4, 12), expires_at: isoDate(2027, 4, 12), verified_at: '2025-04-16T11:00:00Z', status: 'verified' },
  { id: 'drvd_majed_prm', driver_id: 'drvp_majed', kind: 'permit', issuer: 'Hazmat Authority KSA', file_ref: 'art_prm_majed_2025', issued_at: isoDate(2025, 9, 1), expires_at: isoDate(2027, 9, 1), verified_at: '2025-09-04T13:42:00Z', status: 'verified' },

  // --- Hamad (drvp_hamad) ---
  { id: 'drvd_hamad_lic', driver_id: 'drvp_hamad', kind: 'license', issuer: 'KSA Traffic Dept', file_ref: 'art_lic_hamad_2024', issued_at: isoDate(2024, 5, 7), expires_at: isoDate(2026, 5, 7), verified_at: '2024-05-12T08:22:00Z', status: 'verified' },
  { id: 'drvd_hamad_ins', driver_id: 'drvp_hamad', kind: 'insurance', issuer: 'Tawuniya', file_ref: 'art_ins_hamad_2025', issued_at: isoDate(2025, 9, 8), expires_at: isoDate(2027, 9, 8), verified_at: '2025-09-12T08:00:00Z', status: 'verified' },
  { id: 'drvd_hamad_med', driver_id: 'drvp_hamad', kind: 'medical', issuer: 'Mouwasat Hospital', file_ref: 'art_med_hamad_2025', issued_at: isoDate(2025, 4, 12), expires_at: isoDate(2027, 4, 12), verified_at: '2025-04-15T08:51:00Z', status: 'verified' },
];

// driver_compliance_events — immutable ledger snapshot.
// severity ∈ {info, warn, critical} drives TimelineLog tone.
export const driver_compliance_events = [
  // --- Recent / today (relative to 2026-04-26) ---
  { id: 'dce_001', driver_id: 'drvp_omar',     event_type: 'driver.suspended', occurred_at: '2026-04-25T11:42:00Z', severity: 'critical', actor: 'usr_admin_rashed', payload: { reason: 'expired_permit', permit_id: 'drvd_omar_prm' } },
  { id: 'dce_002', driver_id: 'drvp_mohammed', event_type: 'license.expiry_warning', occurred_at: '2026-04-25T08:00:00Z', severity: 'warn', actor: 'system', payload: { days_until: 6, license_id: 'drvd_mohammed_lic' } },
  { id: 'dce_003', driver_id: 'drvp_tariq',    event_type: 'document.submitted', occurred_at: '2026-04-24T15:18:00Z', severity: 'info', actor: 'usr_dr_tariq', payload: { document_id: 'drvd_tariq_prm', kind: 'permit' } },
  { id: 'dce_004', driver_id: 'drvp_omar',     event_type: 'document.rejected', occurred_at: '2026-04-22T10:11:00Z', severity: 'warn', actor: 'usr_admin_rashed', payload: { document_id: 'drvd_omar_med', reason: 'illegible_scan' } },
  { id: 'dce_005', driver_id: 'drvp_khalid',   event_type: 'inspection.passed', occurred_at: '2026-04-21T09:32:00Z', severity: 'info', actor: 'usr_admin_rashed', payload: { inspection_id: 'insp_2026_0421' } },

  // --- This week ---
  { id: 'dce_006', driver_id: 'drvp_hamad',    event_type: 'license.expiry_warning', occurred_at: '2026-04-19T08:00:00Z', severity: 'warn', actor: 'system', payload: { days_until: 18, license_id: 'drvd_hamad_lic' } },
  { id: 'dce_007', driver_id: 'drvp_bandar',   event_type: 'compliance.score_change', occurred_at: '2026-04-18T16:42:00Z', severity: 'info', actor: 'system', payload: { from: 92, to: 94, reason: 'on_time_streak_30d' } },
  { id: 'dce_008', driver_id: 'drvp_omar',     event_type: 'compliance.score_change', occurred_at: '2026-04-17T10:11:00Z', severity: 'critical', actor: 'system', payload: { from: 67, to: 41, reason: 'multiple_violations' } },

  // --- Earlier ---
  { id: 'dce_009', driver_id: 'drvp_faisal',   event_type: 'training.completed', occurred_at: '2026-04-12T13:55:00Z', severity: 'info', actor: 'usr_admin_rashed', payload: { training_id: 'trn_safe_riding_v3' } },
  { id: 'dce_010', driver_id: 'drvp_yousef',   event_type: 'inspection.passed', occurred_at: '2026-04-10T09:11:00Z', severity: 'info', actor: 'usr_admin_rashed', payload: { inspection_id: 'insp_2026_0410' } },
  { id: 'dce_011', driver_id: 'drvp_tariq',    event_type: 'incident.minor', occurred_at: '2026-04-08T16:42:00Z', severity: 'warn', actor: 'system', payload: { incident_id: 'inc_2026_0408', impact: 'late_delivery' } },
  { id: 'dce_012', driver_id: 'drvp_majed',    event_type: 'document.verified', occurred_at: '2026-04-05T08:18:00Z', severity: 'info', actor: 'usr_admin_rashed', payload: { document_id: 'drvd_majed_prm' } },
  { id: 'dce_013', driver_id: 'drvp_nasser',   event_type: 'compliance.score_change', occurred_at: '2026-04-02T11:55:00Z', severity: 'info', actor: 'system', payload: { from: 79, to: 81 } },
  { id: 'dce_014', driver_id: 'drvp_saleh',    event_type: 'training.completed', occurred_at: '2026-03-28T15:10:00Z', severity: 'info', actor: 'usr_admin_rashed', payload: { training_id: 'trn_route_safety' } },
  { id: 'dce_015', driver_id: 'drvp_ahmed',    event_type: 'inspection.passed', occurred_at: '2026-03-22T09:18:00Z', severity: 'info', actor: 'usr_admin_rashed', payload: { inspection_id: 'insp_2026_0322' } },
  { id: 'dce_016', driver_id: 'drvp_omar',     event_type: 'incident.major', occurred_at: '2026-03-18T17:42:00Z', severity: 'critical', actor: 'system', payload: { incident_id: 'inc_2026_0318', impact: 'vehicle_damage' } },
  { id: 'dce_017', driver_id: 'drvp_khalid',   event_type: 'compliance.score_change', occurred_at: '2026-03-12T08:30:00Z', severity: 'info', actor: 'system', payload: { from: 94, to: 96 } },
  { id: 'dce_018', driver_id: 'drvp_bandar',   event_type: 'training.completed', occurred_at: '2026-03-04T13:15:00Z', severity: 'info', actor: 'usr_admin_rashed', payload: { training_id: 'trn_eco_driving' } },
];

// NOTE — `vehicle_assignments` is owned by fleet-vehicles.js (CLAIM-FLEET-VEHICLES,
// a sibling claim in this Wave 1 batch). The driver-side "Vehicle history" tab
// reuses that canonical export and filters rows by `driver_user_id` matching
// the current driver_profile.user_id (no shadow table — single source of truth
// per the AGENTS.md zero-redundancy mandate).

// Per-driver hours-of-service segments (today + 7-day rollup).
// Stored as a map for O(1) lookup; segments respect the canonical
// HoursOfServiceMeter contract (DutyStatus + durationMinutes).
export const driver_hours_of_service = {
  drvp_khalid: {
    today: [
      { type: 'on_duty', durationMinutes: 35 },
      { type: 'driving', durationMinutes: 240 },
      { type: 'off_duty', durationMinutes: 30 },
      { type: 'driving', durationMinutes: 185 },
      { type: 'on_duty', durationMinutes: 25 },
    ],
    week_total: { driving: 2640, on_duty: 3300, off_duty: 5400, sleeper: 0 },
  },
  drvp_mohammed: {
    today: [
      { type: 'on_duty', durationMinutes: 45 },
      { type: 'driving', durationMinutes: 210 },
      { type: 'off_duty', durationMinutes: 40 },
      { type: 'driving', durationMinutes: 165 },
    ],
    week_total: { driving: 2280, on_duty: 2960, off_duty: 5640, sleeper: 0 },
  },
  drvp_faisal: {
    today: [
      { type: 'on_duty', durationMinutes: 20 },
      { type: 'driving', durationMinutes: 180 },
      { type: 'off_duty', durationMinutes: 30 },
      { type: 'driving', durationMinutes: 220 },
      { type: 'on_duty', durationMinutes: 20 },
    ],
    week_total: { driving: 2820, on_duty: 3120, off_duty: 5400, sleeper: 0 },
  },
  drvp_tariq: {
    today: [
      { type: 'on_duty', durationMinutes: 30 },
      { type: 'driving', durationMinutes: 195 },
      { type: 'off_duty', durationMinutes: 240 },
    ],
    week_total: { driving: 1840, on_duty: 2520, off_duty: 6720, sleeper: 0 },
  },
  drvp_yousef: {
    today: [
      { type: 'on_duty', durationMinutes: 30 },
      { type: 'driving', durationMinutes: 230 },
      { type: 'off_duty', durationMinutes: 35 },
      { type: 'driving', durationMinutes: 175 },
    ],
    week_total: { driving: 2520, on_duty: 3220, off_duty: 5520, sleeper: 0 },
  },
  drvp_ahmed: {
    today: [
      { type: 'off_duty', durationMinutes: 720 },
    ],
    week_total: { driving: 1980, on_duty: 2640, off_duty: 7440, sleeper: 0 },
  },
  drvp_omar: {
    today: [
      { type: 'off_duty', durationMinutes: 720 },
    ],
    week_total: { driving: 220, on_duty: 360, off_duty: 9720, sleeper: 0 },
  },
  drvp_saleh: {
    today: [
      { type: 'on_duty', durationMinutes: 25 },
      { type: 'driving', durationMinutes: 250 },
      { type: 'off_duty', durationMinutes: 30 },
      { type: 'driving', durationMinutes: 200 },
    ],
    week_total: { driving: 2780, on_duty: 3120, off_duty: 5340, sleeper: 0 },
  },
  drvp_nasser: {
    today: [
      { type: 'on_duty', durationMinutes: 35 },
      { type: 'driving', durationMinutes: 165 },
      { type: 'off_duty', durationMinutes: 240 },
    ],
    week_total: { driving: 2080, on_duty: 2700, off_duty: 6360, sleeper: 0 },
  },
  drvp_bandar: {
    today: [
      { type: 'on_duty', durationMinutes: 40 },
      { type: 'driving', durationMinutes: 220 },
      { type: 'off_duty', durationMinutes: 30 },
      { type: 'driving', durationMinutes: 185 },
      { type: 'on_duty', durationMinutes: 30 },
    ],
    week_total: { driving: 2640, on_duty: 3320, off_duty: 5520, sleeper: 0 },
  },
  drvp_majed: {
    today: [
      { type: 'off_duty', durationMinutes: 720 },
    ],
    week_total: { driving: 1660, on_duty: 2240, off_duty: 7920, sleeper: 0 },
  },
  drvp_hamad: {
    today: [
      { type: 'on_duty', durationMinutes: 30 },
      { type: 'driving', durationMinutes: 210 },
      { type: 'off_duty', durationMinutes: 35 },
      { type: 'driving', durationMinutes: 195 },
    ],
    week_total: { driving: 2520, on_duty: 3060, off_duty: 5400, sleeper: 0 },
  },
};

// Canonical driver-document type lookup (mirrors backend lookup category
// `driver_document_type` per migration 202601311230 line 391). Local module
// exports the array so the docs DataTable can resolve labels/tones without
// touching the global lookup catalog (additive only).
export const driver_document_kinds = [
  { value: 'license', label: 'License', tone: 'info' },
  { value: 'insurance', label: 'Insurance', tone: 'info' },
  { value: 'medical', label: 'Medical', tone: 'info' },
  { value: 'permit', label: 'Permit', tone: 'info' },
];

export const driver_document_status = [
  { value: 'submitted', label: 'Submitted', tone: 'info' },
  { value: 'verified', label: 'Verified', tone: 'good' },
  { value: 'rejected', label: 'Rejected', tone: 'danger' },
  { value: 'expired', label: 'Expired', tone: 'warn' },
];

// Canonical 3-value enum per supabase/migrations/202601311230_enterprise_ops_v1.sql:205-214
// (FLEET Wave 5 RE-AUDIT D4 alignment). Backward shim: pre-migration FE
// callers reading the {on_shift|on_break|off_duty|suspended} 4-value form
// should switch to `hours_of_service_state` on driver_profiles for duty
// granularity and use this lookup only for lifecycle status.
export const driver_status_lookup = [
  { value: 'active', label: 'Active', tone: 'good', is_default: true, metadata: { is_default: true } },
  { value: 'inactive', label: 'Inactive', tone: 'neutral' },
  { value: 'suspended', label: 'Suspended', tone: 'danger' },
];

export const driver_compliance_severity = [
  { value: 'info', label: 'Info', tone: 'neutral' },
  { value: 'warn', label: 'Warn', tone: 'warn' },
  { value: 'critical', label: 'Critical', tone: 'danger' },
];
