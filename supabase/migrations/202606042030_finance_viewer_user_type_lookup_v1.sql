-- Console V2 Finance: keep the read-only finance viewer persona valid under
-- lookup-enforced user_type writes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042030_finance_viewer_user_type_lookup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $lookup_seed$
DECLARE
  v_user_type_definition_id UUID;
BEGIN
  SELECT id
    INTO v_user_type_definition_id
    FROM public.lookup_definitions
   WHERE category = 'user_type'
   LIMIT 1;

  IF v_user_type_definition_id IS NULL THEN
    RAISE EXCEPTION 'user_type lookup definition missing';
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    status,
    metadata
  )
  VALUES (
    v_user_type_definition_id,
    'finance_viewer',
    'Finance Viewer',
    'Read-only finance operator for COD, settlements, and finance closeout review.',
    891,
    FALSE,
    'active',
    jsonb_build_object('domain', 'Finance', 'persona', 'finance_readonly')
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET label = EXCLUDED.label,
         description = EXCLUDED.description,
         sort_order = EXCLUDED.sort_order,
         status = 'active',
         metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = now();
END;
$lookup_seed$;

SELECT pg_advisory_unlock(hashtext('202606042030_finance_viewer_user_type_lookup_v1'));
COMMIT;
