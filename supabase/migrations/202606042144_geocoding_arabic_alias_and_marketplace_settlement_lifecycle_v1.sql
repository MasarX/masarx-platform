-- Repair Arabic geocoding aliases and make marketplace settlement finalization
-- follow the configured settlement transition lifecycle.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT pg_advisory_lock(hashtext('202606042144_geocoding_arabic_alias_and_marketplace_settlement_lifecycle_v1'));

DO $do$
DECLARE
  v_root_scope TEXT := public.get_root_scope_type_key_v1();
  v_current JSONB;
  v_cities JSONB;
BEGIN
  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = v_root_scope
     AND s.scope_id IS NULL
   ORDER BY s.last_updated DESC NULLS LAST, s.updated_at DESC NULLS LAST
   LIMIT 1;

  v_current := COALESCE(v_current, public.resolve_saas_onboarding_policy_v1(), '{}'::jsonb);

  SELECT jsonb_agg(
           CASE
             WHEN lower(city_row.value->>'name_canonical') = 'riyadh'
               AND COALESCE(NULLIF(city_row.value->>'country_code', ''), 'SA') = 'SA'
             THEN jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        city_row.value,
                        '{name_arabic}',
                        to_jsonb(U&'\0627\0644\0631\064A\0627\0636'::text),
                        TRUE
                      ),
                      '{province}',
                      to_jsonb('Riyadh'::text),
                      TRUE
                    ),
                    '{alternate_names}',
                    (
                      SELECT to_jsonb(ARRAY(
                        SELECT DISTINCT candidate.name
                          FROM (
                            SELECT alt.value AS name
                              FROM jsonb_array_elements_text(COALESCE(city_row.value->'alternate_names', '[]'::jsonb)) AS alt(value)
                            UNION ALL SELECT 'Riyadh'
                            UNION ALL SELECT 'Ryadh'
                            UNION ALL SELECT U&'\0627\0644\0631\064A\0627\0636'
                          ) candidate
                         WHERE NULLIF(btrim(candidate.name), '') IS NOT NULL
                         ORDER BY candidate.name
                      ))
                    ),
                    TRUE
                  )
             ELSE city_row.value
           END
           ORDER BY city_row.ordinality
         )
    INTO v_cities
    FROM jsonb_array_elements(COALESCE(v_current #> '{geography_defaults,cities}', '[]'::jsonb)) WITH ORDINALITY AS city_row(value, ordinality);

  IF v_cities IS NOT NULL THEN
    PERFORM public.upsert_settings_value_v1(
      'saas_onboarding_policy',
      v_root_scope,
      NULL,
      jsonb_set(v_current, '{geography_defaults,cities}', v_cities, TRUE),
      1,
      'repair Riyadh geography defaults for Arabic local lookup'
    );
  END IF;
END;
$do$;

UPDATE public.canonical_cities
   SET name_arabic = U&'\0627\0644\0631\064A\0627\0636',
       alternate_names = CASE
         WHEN U&'\0627\0644\0631\064A\0627\0636' = ANY(COALESCE(alternate_names, ARRAY[]::text[]))
           THEN COALESCE(alternate_names, ARRAY[]::text[])
         ELSE COALESCE(alternate_names, ARRAY[]::text[]) || ARRAY[U&'\0627\0644\0631\064A\0627\0636']::text[]
       END,
       province = 'Riyadh',
       region_code = COALESCE(NULLIF(region_code, ''), 'RD'),
       updated_at = now()
 WHERE lower(name_canonical) = 'riyadh'
   AND country_code = 'SA';

CREATE OR REPLACE FUNCTION public.marketplace_create_posted_settlement_batch_v1(
  p_organization_id UUID,
  p_kind TEXT,
  p_subject_id UUID,
  p_finance_event_id UUID,
  p_finance_occurred_at TIMESTAMPTZ,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_created RECORD;
  v_batch_id UUID;
  v_base_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_metadata JSONB := COALESCE(p_metadata, '{}'::jsonb);
BEGIN
  SELECT *
    INTO v_created
    FROM public.create_settlement_batch_v1(
      jsonb_build_object(
        'organization_id', p_organization_id,
        'kind', COALESCE(NULLIF(btrim(COALESCE(p_kind, '')), ''), 'billing'),
        'scope_type', 'marketplace_contract',
        'subject_type', 'marketplace_contract',
        'subject_id', p_subject_id,
        'window_start_at', COALESCE(p_finance_occurred_at, now()),
        'window_end_at', COALESCE(p_finance_occurred_at, now()),
        'actor_system', 'marketplace_create_posted_settlement_batch_v1',
        'idempotency_key', v_base_idempotency,
        'metadata', v_metadata
      )
    );

  v_batch_id := v_created.settlement_batch_id;

  PERFORM public.attach_finance_event_to_settlement_v1(
    jsonb_build_object(
      'settlement_batch_id', v_batch_id,
      'finance_event_id', p_finance_event_id,
      'finance_occurred_at', COALESCE(p_finance_occurred_at, now()),
      'actor_system', 'marketplace_create_posted_settlement_batch_v1',
      'idempotency_key', COALESCE(v_base_idempotency, v_batch_id::text) || ':attach',
      'payload', v_metadata
    )
  );

  PERFORM public.transition_settlement_batch_v1(
    jsonb_build_object(
      'settlement_batch_id', v_batch_id,
      'to_status', 'locked',
      'status_reason', 'marketplace_auto_recorded_internal',
      'actor_system', 'marketplace_create_posted_settlement_batch_v1',
      'idempotency_key', COALESCE(v_base_idempotency, v_batch_id::text) || ':lock',
      'payload', v_metadata
    )
  );

  PERFORM public.transition_settlement_batch_v1(
    jsonb_build_object(
      'settlement_batch_id', v_batch_id,
      'to_status', 'approved',
      'status_reason', 'marketplace_auto_recorded_internal',
      'actor_system', 'marketplace_create_posted_settlement_batch_v1',
      'idempotency_key', COALESCE(v_base_idempotency, v_batch_id::text) || ':approve',
      'payload', v_metadata
    )
  );

  PERFORM public.transition_settlement_batch_v1(
    jsonb_build_object(
      'settlement_batch_id', v_batch_id,
      'to_status', 'posted',
      'status_reason', 'marketplace_auto_recorded_internal',
      'actor_system', 'marketplace_create_posted_settlement_batch_v1',
      'idempotency_key', COALESCE(v_base_idempotency, v_batch_id::text) || ':post',
      'payload', v_metadata
    )
  );

  RETURN v_batch_id;
END;
$function$;

COMMENT ON FUNCTION public.marketplace_create_posted_settlement_batch_v1(UUID, TEXT, UUID, UUID, TIMESTAMPTZ, JSONB, TEXT)
IS 'Creates a marketplace settlement batch, attaches the finance event, and transitions open -> locked -> approved -> posted through the canonical settlement lifecycle.';

SELECT pg_advisory_unlock(hashtext('202606042144_geocoding_arabic_alias_and_marketplace_settlement_lifecycle_v1'));

COMMIT;
