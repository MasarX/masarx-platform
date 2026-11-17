-- F619 G3: server-authorized, device-scoped FieldOps active-role preference.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260913094000_fieldops_active_role_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.user_devices ADD COLUMN IF NOT EXISTS active_role_id UUID;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_devices'::regclass
       AND conname = 'user_devices_active_role_fk'
  ) THEN
    ALTER TABLE public.user_devices
      ADD CONSTRAINT user_devices_active_role_fk
      FOREIGN KEY (active_role_id) REFERENCES public.rbac_roles(id) ON DELETE SET NULL;
  END IF;
END;
$block$;

COMMENT ON COLUMN public.user_devices.active_role_id
  IS 'Current FieldOps work-mode preference. Authorization is always recomputed from active RBAC assignments.';

CREATE OR REPLACE FUNCTION public.ui_get_fieldops_active_role_v1(p_device_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_organization_id UUID := public.current_user_org_id();
  v_active_role_id UUID;
  v_selected_role_key TEXT;
  v_eligible_roles JSONB := '[]'::jsonb;
  v_eligible_count INTEGER := 0;
BEGIN
  IF v_user_id IS NULL OR v_organization_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_fieldops_active_role_v1 requires authenticated tenant context'
      USING ERRCODE = '42501';
  END IF;
  SELECT d.active_role_id INTO v_active_role_id
    FROM public.user_devices d
   WHERE d.id = p_device_id
     AND d.organization_id = v_organization_id
     AND d.user_id = v_user_id
     AND d.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_get_fieldops_active_role_v1 device is not active and owned'
      USING ERRCODE = '42501';
  END IF;

  WITH eligible AS (
    SELECT DISTINCT r.id, r.key, r.name,
      COALESCE((
        SELECT jsonb_agg(bm.branch_id ORDER BY bm.branch_id)
          FROM public.branch_memberships bm
          JOIN public.branches b
            ON b.id = bm.branch_id
           AND b.organization_id = v_organization_id
           AND b.is_active
         WHERE bm.user_id = v_user_id
           AND bm.role_key = r.key
           AND bm.is_active
           AND bm.effective_from <= now()
           AND (bm.effective_to IS NULL OR bm.effective_to > now())
      ), '[]'::jsonb) AS branch_ids
      FROM public.rbac_user_role_assignments a
      JOIN public.rbac_roles r
        ON r.id = a.role_id
       AND r.organization_id = a.organization_id
       AND r.is_active
     WHERE a.organization_id = v_organization_id
       AND a.user_id = v_user_id
       AND a.revoked_at IS NULL
  )
  SELECT count(*)::integer,
    COALESCE(jsonb_agg(jsonb_build_object(
      'role_id', id, 'role_key', key, 'label', name, 'branch_ids', branch_ids
    ) ORDER BY key), '[]'::jsonb),
    max(key) FILTER (WHERE id = v_active_role_id)
    INTO v_eligible_count, v_eligible_roles, v_selected_role_key
    FROM eligible;

  RETURN jsonb_build_object(
    'version', 1,
    'device_id', p_device_id,
    'selected_role_id', CASE WHEN v_selected_role_key IS NULL THEN NULL ELSE v_active_role_id END,
    'selected_role', v_selected_role_key,
    'selection_state', CASE
      WHEN v_selected_role_key IS NOT NULL THEN 'selected'
      WHEN v_eligible_count = 1 THEN 'single_eligible'
      ELSE 'absent'
    END,
    'eligible_roles', v_eligible_roles
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_set_fieldops_active_role_v1(p_device_id UUID, p_role_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_organization_id UUID := public.current_user_org_id();
BEGIN
  IF v_user_id IS NULL OR v_organization_id IS NULL THEN
    RAISE EXCEPTION 'ui_set_fieldops_active_role_v1 requires authenticated tenant context'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.user_devices d
   WHERE d.id = p_device_id
     AND d.organization_id = v_organization_id
     AND d.user_id = v_user_id
     AND d.revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_set_fieldops_active_role_v1 device is not active and owned'
      USING ERRCODE = '42501';
  END IF;
  IF p_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments a
      JOIN public.rbac_roles r
        ON r.id = a.role_id
       AND r.organization_id = a.organization_id
       AND r.is_active
     WHERE a.organization_id = v_organization_id
       AND a.user_id = v_user_id
       AND a.role_id = p_role_id
       AND a.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'ui_set_fieldops_active_role_v1 role is not eligible'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.user_devices
     SET active_role_id = p_role_id, updated_at = now()
   WHERE id = p_device_id;
  RETURN public.ui_get_fieldops_active_role_v1(p_device_id);
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_get_fieldops_active_role_v1(p_device_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$ SELECT public.ui_get_fieldops_active_role_v1(p_device_id); $function$;

CREATE OR REPLACE FUNCTION api.ui_set_fieldops_active_role_v1(p_device_id UUID, p_role_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$ SELECT public.ui_set_fieldops_active_role_v1(p_device_id, p_role_id); $function$;

REVOKE ALL ON FUNCTION public.ui_get_fieldops_active_role_v1(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ui_set_fieldops_active_role_v1(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_get_fieldops_active_role_v1(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_set_fieldops_active_role_v1(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_get_fieldops_active_role_v1(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_set_fieldops_active_role_v1(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_fieldops_active_role_v1(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_set_fieldops_active_role_v1(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.ui_get_fieldops_active_role_v1(UUID)
  IS 'Returns an owned device active-role preference and currently eligible server-authorized roles.';
COMMENT ON FUNCTION public.ui_set_fieldops_active_role_v1(UUID, UUID)
  IS 'Sets or clears an owned device work-mode preference after active RBAC eligibility validation; grants no authority.';

SELECT pg_advisory_unlock(hashtext('20260913094000_fieldops_active_role_v1'));
COMMIT;
