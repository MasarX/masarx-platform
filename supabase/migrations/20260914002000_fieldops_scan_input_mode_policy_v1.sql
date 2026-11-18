-- F638 S2: scanner is an untrusted input-mode label, not sender authentication.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260914002000_fieldops_scan_input_mode_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Historical v1 schemas and examples remain valid for their recorded settings versions.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'scan_policy' AND version = 2) THEN
    RAISE EXCEPTION 'scan_policy schema v2 already exists';
  END IF;
END;
$do$;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'scan_policy',
  2,
  jsonb_set(
    jsonb_set(v1.schema, '{properties,scan_input_modes}',
      '{"type":"array","minItems":1,"maxItems":2,"uniqueItems":true,"items":{"type":"string","enum":["camera","scanner"]}}'::jsonb,
      TRUE),
    '{required}', COALESCE(v1.schema->'required', '[]'::jsonb) || '["scan_input_modes"]'::jsonb, TRUE),
  'Scan policy v2: required camera/scanner input-mode labels; sender provenance remains unverified.',
  (SELECT jsonb_agg(
    jsonb_set(jsonb_set(example.value, '{version}', '2'::jsonb, TRUE),
      '{scan_input_modes}', '["camera","scanner"]'::jsonb, TRUE)
   ) FROM jsonb_array_elements(v1.examples) AS example(value)),
  TRUE
FROM public.schema_registry v1
WHERE v1.category = 'scan_policy' AND v1.version = 1;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'scan_policy' AND version = 2) THEN
    RAISE EXCEPTION 'scan_policy schema v1 missing; cannot create v2';
  END IF;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_modes JSONB;
BEGIN
  FOR v_row IN
    SELECT s.scope_type, s.scope_id, sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'scan_policy'
    FOR UPDATE OF s
  LOOP
    IF jsonb_typeof(v_row.value) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'scan_policy value is not an object for scope %', v_row.scope_type;
    END IF;
    v_modes := v_row.value->'scan_input_modes';
    IF v_modes IS NULL THEN
      v_modes := COALESCE(v_row.value->'accepted_input_modes', '["camera","scanner"]'::jsonb);
    END IF;
    IF jsonb_typeof(v_modes) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid scan_input_modes for scope %', v_row.scope_type;
    END IF;
    IF jsonb_array_length(v_modes) NOT BETWEEN 1 AND 2
      OR NOT (v_modes <@ '["camera","scanner"]'::jsonb)
      OR jsonb_array_length(v_modes) <> (
        SELECT count(DISTINCT mode.value)
        FROM jsonb_array_elements(v_modes) AS mode(value)
      )
    THEN
      RAISE EXCEPTION 'invalid scan_input_modes for scope %', v_row.scope_type;
    END IF;
    PERFORM 1 FROM public.upsert_settings_value_v1(
      'scan_policy', v_row.scope_type, v_row.scope_id,
      jsonb_set(v_row.value, '{scan_input_modes}', v_modes, TRUE),
      2, 'F638 S2 scan input mode policy v2 backfill');
  END LOOP;
END;
$do$;

-- Every canonical scan RPC writes this ledger; validate the actual inserted scope.
CREATE FUNCTION public.enforce_scan_input_mode_policy_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_sender_id UUID;
  v_modes JSONB;
  v_mode TEXT;
BEGIN
  IF NOT (COALESCE(NEW.metadata, '{}'::jsonb) ? 'scan_input_mode') THEN
    RETURN NEW; -- Legacy rows make no input-mode claim.
  END IF;

  v_mode := NEW.metadata->>'scan_input_mode';
  IF NEW.shipment_id IS NOT NULL THEN
    SELECT sh.sender_id INTO v_sender_id
    FROM public.shipments sh
    WHERE sh.id = NEW.shipment_id
      AND sh.organization_id = NEW.organization_id
      AND sh.client_id = NEW.client_id;
  END IF;

  SELECT policy.value->'scan_input_modes' INTO v_modes
  FROM public.resolve_scan_policy(jsonb_strip_nulls(jsonb_build_object(
    'organization_id', NEW.organization_id,
    'user_id', NEW.actor_user_id,
    'resource_id', NEW.branch_id,
    'client_id', NEW.client_id,
    'sender_id', v_sender_id,
    'event_type', 'scan_event'
  ))) AS policy
  LIMIT 1;

  IF jsonb_typeof(NEW.metadata->'scan_input_mode') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_modes) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.scan_input_modes'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_array_length(v_modes) NOT BETWEEN 1 AND 2
    OR NOT (v_modes <@ '["camera","scanner"]'::jsonb)
    OR jsonb_array_length(v_modes) <> (
      SELECT count(DISTINCT mode.value)
      FROM jsonb_array_elements(v_modes) AS mode(value)
    )
    OR COALESCE(v_modes ? v_mode, FALSE) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.scan_input_modes'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_scan_input_mode_policy_v1() FROM PUBLIC;
CREATE TRIGGER trg_enforce_scan_input_mode_policy_v1
  BEFORE INSERT ON public.scan_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_scan_input_mode_policy_v1();

SELECT pg_advisory_unlock(hashtext('20260914002000_fieldops_scan_input_mode_policy_v1'));
COMMIT;
