-- Attachment-only additive migration draft. No composer exposure.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('f675_task_completion_amount_guard_v1'));

CREATE OR REPLACE FUNCTION public.assert_task_completion_amount_v1(p_payload jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $fn$
BEGIN
  -- JSON number excludes strings, NaN and infinities; no currency rounding here.
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_payload->'amount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'task_completion_amount_required_nonnegative_number' USING ERRCODE='23514';
  END IF;
  IF (p_payload->>'amount')::numeric < 0 THEN
    RAISE EXCEPTION 'task_completion_amount_required_nonnegative_number' USING ERRCODE='23514';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.assert_task_completion_amount_v1(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_task_completion_amount_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
DECLARE v_contract jsonb;
BEGIN
  IF NEW.event_type IS DISTINCT FROM 'status_changed' OR NEW.to_status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;
  SELECT tt.metadata->'completion_amount_contract'
    INTO v_contract
    FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
   WHERE t.id=NEW.task_id;
  IF v_contract IS NULL THEN RETURN NEW; END IF;
  IF v_contract IS DISTINCT FROM '{"version":1,"field":"amount","minimum":0}'::jsonb THEN
    RAISE EXCEPTION 'task_completion_amount_contract_invalid' USING ERRCODE='23514';
  END IF;
  PERFORM public.assert_task_completion_amount_v1(NEW.payload);
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.enforce_task_completion_amount_v1() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_task_events_completion_amount
BEFORE INSERT OR UPDATE ON public.task_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_task_completion_amount_v1();

-- Existing materialized task types receive the same catalog-owned contract.
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM public.task_types
    WHERE key IN ('cod_cash_handover','cod_cashier_count')
    AND ((metadata IS NOT NULL AND jsonb_typeof(metadata) <> 'object')
      OR (metadata ? 'completion_amount_contract' AND metadata->'completion_amount_contract'
        IS DISTINCT FROM '{"version":1,"field":"amount","minimum":0}'::jsonb))) THEN
    RAISE EXCEPTION 'existing_completion_amount_contract_conflict';
  END IF;
END;
$check$;
UPDATE public.task_types
SET metadata=COALESCE(metadata,'{}'::jsonb)||
  '{"completion_amount_contract":{"version":1,"field":"amount","minimum":0}}'::jsonb
WHERE key IN ('cod_cash_handover','cod_cashier_count');

-- Preserve unrelated catalog entries and metadata; ensure future organizations inherit it.
DO $do$
DECLARE r record; v_next jsonb;
BEGIN
  FOR r IN SELECT s.category,s.scope_type,s.scope_id,sv.value,sv.schema_version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='task_type_catalog'
    FOR UPDATE OF s
  LOOP
    IF jsonb_typeof(r.value->'task_types') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'task_type_catalog_items_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(r.value->'task_types') x(entry)
      WHERE lower(btrim(entry->>'key')) IN ('cod_cash_handover','cod_cashier_count')
      AND ((entry ? 'metadata' AND jsonb_typeof(entry->'metadata') <> 'object')
        OR (entry->'metadata' ? 'completion_amount_contract' AND entry#>'{metadata,completion_amount_contract}'
          IS DISTINCT FROM '{"version":1,"field":"amount","minimum":0}'::jsonb))) THEN
      RAISE EXCEPTION 'catalog_completion_amount_contract_conflict';
    END IF;
    SELECT jsonb_set(r.value,'{task_types}',COALESCE(jsonb_agg(
      CASE WHEN lower(btrim(entry->>'key')) IN ('cod_cash_handover','cod_cashier_count') THEN
        jsonb_set(entry,'{metadata}',COALESCE(entry->'metadata','{}'::jsonb)||
          '{"completion_amount_contract":{"version":1,"field":"amount","minimum":0}}'::jsonb)
      ELSE entry END ORDER BY ordinal),'[]'::jsonb)) INTO v_next
    FROM jsonb_array_elements(r.value->'task_types') WITH ORDINALITY x(entry,ordinal);
    IF v_next IS DISTINCT FROM r.value THEN
      PERFORM public.upsert_settings_value_v1(r.category,r.scope_type,r.scope_id,
        v_next,r.schema_version,'Validate configured COD task completion amounts');
    END IF;
  END LOOP;
END;
$do$;
COMMIT;
