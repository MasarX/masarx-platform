-- Allow authenticated users to update their own profile without requiring the
-- broader users.read capability; cross-user edits still require users.manage.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031630_update_user_profile_self_edit_guard_v1'));
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.update_user_profile_v1(jsonb)'::regprocedure)
    INTO v_definition;

  v_definition := replace(
    v_definition,
    '  -- Self-edit allowed via users.read; cross-user edits require users.manage.
  IF v_is_self THEN
    PERFORM public.assert_capability_v1(''users.read'');
  ELSE
    PERFORM public.assert_capability_v1(''users.manage'');
  END IF;',
    '  -- Self-edit is allowed for the authenticated subject only; cross-user edits require users.manage.
  IF NOT v_is_self THEN
    PERFORM public.assert_capability_v1(''users.manage'');
  END IF;'
  );

  EXECUTE v_definition;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031630_update_user_profile_self_edit_guard_v1'));
COMMIT;
