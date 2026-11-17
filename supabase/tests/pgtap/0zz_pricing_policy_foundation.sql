-- Plan: PLAN-202601-commercial-agreements-pricing-policy / Step: S95
-- pgTAP: Commercial agreements - pricing_policy foundations (ladder + quote compute)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

SELECT has_function('public', 'resolve_pricing_policy', ARRAY['jsonb'], 'resolve_pricing_policy(jsonb) exists');
SELECT has_function('public', 'compute_pricing_quote_v1', ARRAY['jsonb','jsonb'], 'compute_pricing_quote_v1(jsonb,jsonb) exists');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry sr
    WHERE sr.category = 'pricing_policy'
      AND sr.version = 1
      AND sr.is_active = TRUE
    LIMIT 1
  ),
  'pricing_policy schema_registry v1 is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry sr
    WHERE sr.category = 'pricing_policy'
      AND sr.version = 2
      AND sr.is_active = TRUE
    LIMIT 1
  ),
  'pricing_policy schema_registry v2 is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry sr
    WHERE sr.category = 'pricing_policy'
      AND sr.version = 3
      AND sr.is_active = TRUE
    LIMIT 1
  ),
  'pricing_policy schema_registry v3 is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'pricing_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  'pricing_policy global settings default present'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();

  v_tenant_version UUID;
  v_client_version UUID;
  v_sender_version UUID;

  v_res RECORD;
  v_quote RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Pricing Policy Org', 'pricing-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'pricing-' || left(v_user::text, 8) || '@example.com', 'Pricing User', 'tenant');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Pricing Client', 'pricing-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Pricing Sender', 'active');

  -- Tenant default: delivery priced as flat=20 (used only when no client/sender override exists).
  SELECT up.settings_version_id
    INTO v_tenant_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'tenant',
      p_scope_id := v_org,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 10,
            'is_active', true,
            'match', jsonb_build_object('service_type', 'delivery'),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 20)
            )
          )
        )
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap pricing_policy_foundation'
    ) AS up
   LIMIT 1;

  -- Client override: flat=30 (wins over tenant).
  SELECT up.settings_version_id
    INTO v_client_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'client',
      p_scope_id := v_client,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 10,
            'is_active', true,
            'match', jsonb_build_object('service_type', 'delivery'),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 30)
            )
          )
        )
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap pricing_policy_foundation'
    ) AS up
   LIMIT 1;

  -- Sender override: flat=10 + per-km=2 (wins over client/tenant).
  SELECT up.settings_version_id
    INTO v_sender_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'sender',
      p_scope_id := v_sender,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 100,
            'is_active', true,
            'match', jsonb_build_object('service_type', 'delivery'),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 10),
              jsonb_build_object('type', 'distance_km', 'amount', 2)
            ),
            'min_total', 10
          )
        )
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap pricing_policy_foundation'
    ) AS up
   LIMIT 1;

  SELECT *
    INTO v_res
    FROM public.resolve_pricing_policy(
      jsonb_build_object(
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender
      )
    )
   LIMIT 1;

  PERFORM is(v_res.scope_type, 'sender', 'resolve_pricing_policy prefers sender override');

  SELECT *
    INTO v_res
    FROM public.resolve_pricing_policy(
      jsonb_build_object(
        'organization_id', v_org,
        'client_id', v_client
      )
    )
   LIMIT 1;

  PERFORM is(v_res.scope_type, 'client', 'resolve_pricing_policy falls back to client when sender missing');

  SELECT *
    INTO v_res
    FROM public.resolve_pricing_policy(
      jsonb_build_object(
        'organization_id', v_org
      )
    )
   LIMIT 1;

  PERFORM is(v_res.scope_type, 'tenant', 'resolve_pricing_policy falls back to tenant when client/sender missing');

  SELECT *
    INTO v_res
    FROM public.resolve_pricing_policy(
      jsonb_build_object(
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender
      )
    )
   LIMIT 1;

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object(
        'service_type', 'delivery',
        'distance_km', 3
      ),
      v_res.value
    )
   LIMIT 1;

  PERFORM is(v_quote.currency, 'SAR', 'compute_pricing_quote_v1 returns configured currency');
  PERFORM is(v_quote.total_amount::NUMERIC, 16::NUMERIC, 'compute_pricing_quote_v1 computes flat + per-km');

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object(
        'service_type', 'pickup',
        'distance_km', 3
      ),
      v_res.value
    )
   LIMIT 1;

  PERFORM ok(v_quote.total_amount IS NULL, 'compute_pricing_quote_v1 returns NULL when no rule matches');

  -- Tiered match: box_count_min + cod_amount_min (tests v2 matcher fields).
  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object(
        'service_type', 'delivery',
        'distance_km', 1,
        'box_count', 3,
        'cod_amount', 200
      ),
      jsonb_build_object(
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 1,
            'is_active', true,
            'match', jsonb_build_object(
              'service_type', 'delivery',
              'box_count_min', 2,
              'cod_amount_min', 0.01
            ),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 10),
              jsonb_build_object('type', 'box_count', 'amount', 2),
              jsonb_build_object('type', 'cod_pct', 'amount', 5)
            )
          )
        )
      )
    )
   LIMIT 1;

  PERFORM is(v_quote.total_amount::NUMERIC, 26::NUMERIC, 'compute_pricing_quote_v1 supports box_count + cod_pct with tiered match');

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object(
        'service_type', 'delivery',
        'distance_km', 1,
        'box_count', 1,
        'cod_amount', 200
      ),
      jsonb_build_object(
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 1,
            'is_active', true,
            'match', jsonb_build_object(
              'service_type', 'delivery',
              'box_count_min', 2,
              'cod_amount_min', 0.01
            ),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 10)
            )
          )
        )
      )
    )
   LIMIT 1;

  PERFORM ok(v_quote.total_amount IS NULL, 'compute_pricing_quote_v1 respects box_count_min match');

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object(
        'service_type', 'delivery',
        'distance_km', 1,
        'box_count', 3,
        'cod_amount', 0
      ),
      jsonb_build_object(
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 1,
            'is_active', true,
            'match', jsonb_build_object(
              'service_type', 'delivery',
              'box_count_min', 2,
              'cod_amount_min', 0.01
            ),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 10)
            )
          )
        )
      )
    )
   LIMIT 1;

  PERFORM ok(v_quote.total_amount IS NULL, 'compute_pricing_quote_v1 respects cod_amount_min match');

  -- Enterprise components: multiplier (with included) + pct_total (VAT/surcharge) (tests v3 component types).
  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object(
        'service_type', 'delivery',
        'distance_km', 7
      ),
      jsonb_build_object(
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 1,
            'is_active', true,
            'match', jsonb_build_object('service_type', 'delivery'),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 10),
              jsonb_build_object('type', 'multiplier', 'amount', 2, 'key', 'distance_km', 'included', 5),
              jsonb_build_object('type', 'pct_total', 'amount', 15)
            )
          )
        )
      )
    )
   LIMIT 1;

  PERFORM is(v_quote.total_amount::NUMERIC, 16.1::NUMERIC, 'compute_pricing_quote_v1 supports multiplier(included) + pct_total');

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object(
        'service_type', 'delivery',
        'cod_amount', 200
      ),
      jsonb_build_object(
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 1,
            'is_active', true,
            'match', jsonb_build_object('service_type', 'delivery'),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'pct_of', 'amount', 5, 'key', 'cod_amount')
            )
          )
        )
      )
    )
   LIMIT 1;

  PERFORM is(v_quote.total_amount::NUMERIC, 10::NUMERIC, 'compute_pricing_quote_v1 supports pct_of(key)');
END $$;

SELECT * FROM finish();

ROLLBACK;
