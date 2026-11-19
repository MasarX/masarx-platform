-- pgTAP: marketplace posted settlement helper follows canonical lifecycle
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

SELECT has_function(
  'public',
  'marketplace_create_posted_settlement_batch_v1',
  ARRAY['uuid', 'text', 'uuid', 'uuid', 'timestamp with time zone', 'jsonb', 'text']::name[],
  'marketplace_create_posted_settlement_batch_v1 exists'
);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-0000000f0606';
  v_contract UUID := '00000000-0000-4000-8000-0000000f0606';
  v_partner UUID := '00000000-0000-4000-8000-0000000f0607';
  v_finance_event UUID;
  v_batch UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Marketplace settlement proof org', 'marketplace-settlement-proof-org')
  ON CONFLICT (id) DO NOTHING;

  SELECT finance_event_id
    INTO v_finance_event
    FROM public.record_finance_event_v1(jsonb_build_object(
      'organization_id', v_org,
      'event_type', 'payout',
      'direction', 'out',
      'amount', 321.45,
      'currency', 'SAR',
      'account_type', 'external',
      'account_id', v_partner,
      'subject_type', 'marketplace_contract',
      'subject_id', v_contract,
      'idempotency_key', 'pgtap-marketplace-posted-settlement-finance-event',
      'metadata', jsonb_build_object(
        'event', 'remit',
        'partner_id', v_partner::text,
        'source', '0zz_marketplace_posted_settlement_lifecycle_v1'
      )
    ))
   LIMIT 1;

  SELECT public.marketplace_create_posted_settlement_batch_v1(
      v_org,
      'payout',
      v_contract,
      v_finance_event,
      now(),
      jsonb_build_object(
        'source', '0zz_marketplace_posted_settlement_lifecycle_v1',
        'partner_id', v_partner::text,
        'participant_id', v_partner::text,
        'supplier_participant_profile_id', v_partner::text,
        'expected_amount', 321.45,
        'collected_amount', 321.45,
        'remitted_amount', 321.45
      ),
      'pgtap-marketplace-posted-settlement-batch'
    )
    INTO v_batch;

  PERFORM set_config('test.marketplace_settlement_batch_id', v_batch::text, true);
  PERFORM set_config('test.marketplace_settlement_finance_event_id', v_finance_event::text, true);
  PERFORM set_config('test.marketplace_settlement_partner_id', v_partner::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT status FROM public.settlement_batches WHERE id = current_setting('test.marketplace_settlement_batch_id')::uuid),
  'posted',
  'marketplace helper leaves the settlement batch posted'
);

SELECT results_eq(
  $$
    SELECT from_status, to_status
      FROM public.settlement_events
     WHERE settlement_batch_id = current_setting('test.marketplace_settlement_batch_id')::uuid
       AND event_type = 'status_changed'
     ORDER BY batch_version
  $$,
  $$
    VALUES ('open'::text, 'locked'::text),
           ('locked'::text, 'approved'::text),
           ('approved'::text, 'posted'::text)
  $$,
  'marketplace helper transitions open -> locked -> approved -> posted'
);

SELECT is(
  (SELECT remitted_amount::text
     FROM public.v_settlement_batch_summary
    WHERE id = current_setting('test.marketplace_settlement_batch_id')::uuid),
  '321.45',
  'settlement summary exposes remitted payout amount'
);

SELECT is(
  (SELECT supplier_participant_profile_id
     FROM public.v_settlement_batch_summary
    WHERE id = current_setting('test.marketplace_settlement_batch_id')::uuid),
  current_setting('test.marketplace_settlement_partner_id'),
  'settlement summary preserves partner profile lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settlement_batch_finance_events sbfe
     WHERE sbfe.settlement_batch_id = current_setting('test.marketplace_settlement_batch_id')::uuid
       AND sbfe.finance_event_id = current_setting('test.marketplace_settlement_finance_event_id')::uuid
  ),
  'settlement batch is linked to the finance event membership table'
);

SELECT * FROM finish();
ROLLBACK;
