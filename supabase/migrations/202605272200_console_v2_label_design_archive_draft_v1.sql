-- Console V2 label designer draft archive lifecycle.
--
-- Draft archive is a soft cleanup action for stale, unpublished visual label
-- designs. Published designs remain immutable through this path.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605272200_console_v2_label_design_archive_draft_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.label_design_drafts
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE OR REPLACE FUNCTION public.label_designer_archive_draft(
  p_draft_id UUID,
  p_archive_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_existing public.label_design_drafts%ROWTYPE;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_archive_reason, '')), '');
  v_draft JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','auth_required','message','Authentication required')
    );
  END IF;

  IF v_org IS NULL AND NOT v_service_role THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','org_required','message','Organization context required')
    );
  END IF;

  SELECT *
    INTO v_existing
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND (v_service_role OR d.organization_id = v_org)
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_not_found','message','Draft not found')
    );
  END IF;

  IF v_existing.status IS DISTINCT FROM 'draft' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_not_archivable','message','Only draft rows can be archived')
    );
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.write', v_existing.scope_type, v_existing.scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.write capability is required')
    );
  END IF;

  UPDATE public.label_design_drafts d
     SET status = 'archived',
         archived_at = public.workflow_now(),
         archived_by = v_user,
         archive_reason = COALESCE(v_reason, 'Archived from Console V2 Labels'),
         updated_at = public.workflow_now()
   WHERE d.id = p_draft_id
     AND d.organization_id = v_existing.organization_id;

  SELECT to_jsonb(d)
    INTO v_draft
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND d.organization_id = v_existing.organization_id
   LIMIT 1;

  RETURN jsonb_build_object('ok', TRUE, 'draft', v_draft);
END;
$function$;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.label_designer_archive_draft(
  p_draft_id UUID,
  p_archive_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.label_designer_archive_draft(p_draft_id, p_archive_reason);
$function$;

REVOKE ALL ON FUNCTION public.label_designer_archive_draft(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.label_designer_archive_draft(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.label_designer_archive_draft(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.label_designer_archive_draft(UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.label_designer_archive_draft(UUID, TEXT) IS
  'Archives an unpublished label design draft with label_design.write enforcement and archived draft readback.';
COMMENT ON FUNCTION api.label_designer_archive_draft(UUID, TEXT) IS
  'Browser-safe api schema wrapper for public.label_designer_archive_draft.';

SELECT pg_advisory_unlock(hashtext('202605272200_console_v2_label_design_archive_draft_v1'));

COMMIT;
