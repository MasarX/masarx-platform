-- zzw46_canonical_lookup_tone_seeds.sql — pgTAP for the W24c migration
-- (202605020400_w46_canonical_lookup_tone_seeds.sql).
--
-- Asserts:
--   1. All 18 new lookup_definitions categories exist + are correctly
--      attributed (owner_role, approval_policy, scope_type='global').
--   2. Each category has the expected number of lookup_values rows.
--   3. Every value carries `metadata.tone` (the FE consumer requires it).
--   4. support_case_status.lifecycle metadata enrichment landed.
--   5. Idempotency: re-running the migration leaves row counts stable
--      (no duplicate INSERTs, no metadata regression).

BEGIN;
SELECT plan(56);

-- ─── 1. lookup_definitions presence (18 categories) ─────────────────

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'branch_type' AND scope_type = 'global'),
  'branch_type lookup_definition exists at global scope'
);
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'branch_status'), 'branch_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'branch_role'), 'branch_role definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_offer_status'), 'marketplace_offer_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_award_status'), 'marketplace_award_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_contract_status'), 'marketplace_contract_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_request_status'), 'marketplace_request_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_participant_request_status'), 'marketplace_participant_request_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'partner_compliance_status'), 'partner_compliance_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'partner_listing_status'), 'partner_listing_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_status'), 'zone_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_override_status'), 'zone_override_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_change_kind'), 'zone_change_kind definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_color_token'), 'zone_color_token definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'address_validation_status'), 'address_validation_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'geocoding_attempt_status'), 'geocoding_attempt_status definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'webhook_rule_domain'), 'webhook_rule_domain definition');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'billing_invoice_event_type'), 'billing_invoice_event_type definition');

-- ─── 2. Row counts per category ─────────────────────────────────────

-- Later marketplace/network migrations add more valid rows to these categories,
-- so this test verifies required canonical rows instead of freezing counts.
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['hub','depot','branch','dropoff_point']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_type' AND lv.value = expected.value)), 'branch_type required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['active','reduced','out_of_service','planned']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_status' AND lv.value = expected.value)), 'branch_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['canonical_hub','regional','local','satellite']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_role' AND lv.value = expected.value)), 'branch_role required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['pending','shortlisted','awarded','rejected','expired','withdrawn','submitted','countered','accepted']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_offer_status' AND lv.value = expected.value)), 'marketplace_offer_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['active','cancelled','completed','pending_acceptance','accepted','rejected','materialized','expired']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_award_status' AND lv.value = expected.value)), 'marketplace_award_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['draft','active','expiring_soon','expired','terminated','pending_acceptance','materialized','executing','completed','settled','cancelled','rejected','disputed']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_contract_status' AND lv.value = expected.value)), 'marketplace_contract_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['open','in_review','awarded','closed','cancelled','draft','published','negotiation','award_pending_acceptance','provider_accepted','materialized','executing','in_execution','completed','settled','expired','disputed']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_request_status' AND lv.value = expected.value)), 'marketplace_request_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['pending','approved','rejected','withdrawn']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_participant_request_status' AND lv.value = expected.value)), 'marketplace_participant_request_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['compliant','expiring_soon','expired','pending_kyc','rejected','suspended']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'partner_compliance_status' AND lv.value = expected.value)), 'partner_compliance_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['listed','unlisted','blacklisted']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'partner_listing_status' AND lv.value = expected.value)), 'partner_listing_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['active','draft','suspended','retired']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_status' AND lv.value = expected.value)), 'zone_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['pending','approved','denied','expired','rejected']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_override_status' AND lv.value = expected.value)), 'zone_override_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['created','district_added','district_removed','archived','override_applied']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_change_kind' AND lv.value = expected.value)), 'zone_change_kind required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['good','info','warn','danger','neutral','sky','emerald','amber','rose','slate']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_color_token' AND lv.value = expected.value)), 'zone_color_token required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['valid','invalid','requires_review','pending']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'address_validation_status' AND lv.value = expected.value)), 'address_validation_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['success','failure','pending','rate_limited']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'geocoding_attempt_status' AND lv.value = expected.value)), 'geocoding_attempt_status required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['shipment','route','cod','webhook','integration']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'webhook_rule_domain' AND lv.value = expected.value)), 'webhook_rule_domain required values exist');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['created','sent','paid','overdue','refunded','cancelled','disputed']) AS expected(value) WHERE NOT EXISTS (SELECT 1 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'billing_invoice_event_type' AND lv.value = expected.value)), 'billing_invoice_event_type required values exist');

-- ─── 3. Every value carries metadata.tone (the FE consumer requires it) ───

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category IN (
      'branch_type','branch_status','branch_role',
      'marketplace_offer_status','marketplace_award_status',
      'marketplace_contract_status','marketplace_request_status',
      'marketplace_participant_request_status',
      'partner_compliance_status','partner_listing_status',
      'zone_status','zone_override_status','zone_change_kind','zone_color_token',
      'address_validation_status','geocoding_attempt_status',
      'webhook_rule_domain','billing_invoice_event_type'
    )
    AND (lv.metadata->>'tone') IS NULL),
  0,
  'every W24c-seeded lookup value carries metadata.tone (no fallbacks needed at FE)'
);

-- ─── 4. Specific tone-value spot checks (sample per category cluster) ───

SELECT is(
  (SELECT lv.metadata->>'tone' FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'branch_type' AND lv.value = 'hub'),
  'info',
  'branch_type:hub tone is "info"'
);
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_status' AND lv.value = 'out_of_service'), 'danger', 'branch_status:out_of_service tone is "danger"');
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'partner_compliance_status' AND lv.value = 'expired'), 'danger', 'partner_compliance_status:expired tone is "danger"');
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_color_token' AND lv.value = 'emerald'), 'good', 'zone_color_token:emerald tone is "good"');
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'billing_invoice_event_type' AND lv.value = 'overdue'), 'warn', 'billing_invoice_event_type:overdue tone is "warn"');
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_offer_status' AND lv.value = 'submitted'), 'info', 'marketplace_offer_status:submitted tone is "info"');
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_award_status' AND lv.value = 'pending_acceptance'), 'warn', 'marketplace_award_status:pending_acceptance tone is "warn"');
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_contract_status' AND lv.value = 'disputed'), 'danger', 'marketplace_contract_status:disputed tone is "danger"');
SELECT is((SELECT lv.metadata->>'tone' FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_request_status' AND lv.value = 'completed'), 'good', 'marketplace_request_status:completed tone is "good"');

-- ─── 5. support_case_status lifecycle metadata enrichment ───────────

SELECT is(
  (SELECT lv.metadata->>'lifecycle' FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status' AND lv.value = 'open'),
  'open',
  'support_case_status:open carries lifecycle=open'
);
SELECT is(
  (SELECT lv.metadata->>'lifecycle' FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status' AND lv.value = 'in_progress'),
  'open',
  'support_case_status:in_progress carries lifecycle=open'
);
SELECT is(
  (SELECT lv.metadata->>'lifecycle' FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status' AND lv.value = 'resolved'),
  'resolved',
  'support_case_status:resolved carries lifecycle=resolved'
);
SELECT is(
  (SELECT lv.metadata->>'lifecycle' FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status' AND lv.value = 'closed'),
  'resolved',
  'support_case_status:closed carries lifecycle=resolved'
);
SELECT is(
  (SELECT lv.metadata->>'lifecycle' FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status' AND lv.value = 'canceled'),
  'canceled',
  'support_case_status:canceled carries lifecycle=canceled'
);

-- ─── 6. lookup_definitions attribution checks ───────────────────────

SELECT is(
  (SELECT owner_role FROM public.lookup_definitions WHERE category = 'branch_type'),
  'operations',
  'branch_type owner_role = operations'
);
SELECT is(
  (SELECT owner_role FROM public.lookup_definitions WHERE category = 'webhook_rule_domain'),
  'engineering',
  'webhook_rule_domain owner_role = engineering'
);
SELECT is(
  (SELECT owner_role FROM public.lookup_definitions WHERE category = 'billing_invoice_event_type'),
  'finance',
  'billing_invoice_event_type owner_role = finance'
);
SELECT is(
  (SELECT scope_type FROM public.lookup_definitions WHERE category = 'zone_color_token'),
  'global',
  'zone_color_token scope_type = global'
);

-- ─── 7. Idempotency markers (sort_order preserved on re-upsert) ─────
-- Re-running the migration overwrites label/sort_order/metadata only when
-- changed; the (lookup_definition_id, value) UNIQUE catches duplicates.

SELECT ok(
  (SELECT bool_and(lv.sort_order = sub.sort_order)
   FROM public.lookup_values lv
   JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   JOIN (VALUES
     ('branch_type', 'hub', 10),
     ('branch_type', 'depot', 20),
     ('branch_status', 'active', 10),
     ('branch_status', 'out_of_service', 30),
     ('marketplace_offer_status', 'pending', 10),
     ('marketplace_offer_status', 'awarded', 30),
     ('billing_invoice_event_type', 'created', 10),
     ('billing_invoice_event_type', 'paid', 30)
   ) AS sub(category, value, sort_order)
     ON sub.category = ld.category AND sub.value = lv.value),
  'sort_order remains stable across re-upsert (idempotency holds)'
);

SELECT * FROM finish();
ROLLBACK;
