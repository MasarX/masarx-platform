BEGIN;
SET LOCAL lock_timeout = '10s';

REVOKE EXECUTE ON FUNCTION public.ensure_service_level_lookup_value_v1(uuid)
  FROM PUBLIC, anon, authenticated;

-- Recipient rows have no canonical sender binding. Keep the receiving executor
-- and its ancestor lookup for other resources, but fail closed for this directory.
DO $guard$
DECLARE
  v_function CONSTANT regprocedure :=
    'public.ui_assert_resource_read_scope_v1(jsonb,text,uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_function);
  v_anchor CONSTANT text := ' IF NOT (p_resource ? ''read_scope_types'') THEN RETURN; END IF;';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_anchor, ''))) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Unexpected resource read scope guard definition';
  END IF;
  EXECUTE replace(v_definition, v_anchor, $body$ IF p_scope = 'sender' AND p_resource->>'key' = 'recipient_directory' THEN
   RAISE EXCEPTION 'Recipient directory requires a sender scope binding' USING ERRCODE = '42501';
 END IF;
$body$ || v_anchor);
END;
$guard$;

COMMIT;
