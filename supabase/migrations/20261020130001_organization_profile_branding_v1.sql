BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.organization_profile_assert_writer_v1(p_organization_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $function$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  -- Editor read/preview is intentionally write-only; ordinary resource reads retain their own read permission.
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_actor AND status = 'active') THEN
    RAISE EXCEPTION 'Authenticated active user required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('organizations.write', public.current_user_scope_type(), public.current_user_scope_id());
  IF public.user_has_resource_capability_v1('organizations', 'write') IS NOT TRUE THEN
    RAISE EXCEPTION 'Organization resource write denied' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR (
    public.is_platform_user() OR (
      public.current_user_scope_type() = 'tenant' AND p_organization_id = public.current_user_org_id()
    )
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Organization outside writer scope' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('actor_user_id', v_actor, 'organization_id', p_organization_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.organization_profile_read_v1(p_organization_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $function$
DECLARE
  v_guard JSONB := public.organization_profile_assert_writer_v1(p_organization_id);
  v_profile JSONB;
  v_logo JSONB;
  v_defaults JSONB;
BEGIN
  SELECT COALESCE(default_settings, '{}'::jsonb) INTO v_defaults FROM public.organizations WHERE id = p_organization_id;
  SELECT jsonb_build_object('id', id, 'name', name, 'timezone', timezone, 'locale', locale,
    'default_settings', jsonb_build_object('branding', jsonb_strip_nulls(jsonb_build_object(
      'primary_color', CASE WHEN default_settings->'branding'->>'primary_color' ~ '^#[0-9A-Fa-f]{6}$' THEN default_settings->'branding'->>'primary_color' END,
      'secondary_color', CASE WHEN default_settings->'branding'->>'secondary_color' ~ '^#[0-9A-Fa-f]{6}$' THEN default_settings->'branding'->>'secondary_color' END)))) INTO v_profile
  FROM public.organizations WHERE id = p_organization_id;
  SELECT jsonb_build_object('artifact_id', a.id, 'storage_bucket', a.storage_bucket,
    'storage_key', a.storage_key, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes,
    'file_name', a.metadata->>'file_name') INTO v_logo
  FROM public.artifacts a
  WHERE a.id::text = v_defaults->'branding'->>'logo_artifact_id'
    AND a.organization_id = p_organization_id AND a.source_system = 'organization-profile'
    AND a.storage_bucket = 'label-render-assets'
    AND a.created_by_user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = a.created_by_user_id)
    AND a.metadata->>'upload_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND a.metadata->>'file_name' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
    AND a.storage_key = p_organization_id::text || '/branding/' || (a.metadata->>'upload_id') || '/' || (a.metadata->>'file_name')
    AND a.sha256 ~ '^[0-9a-f]{64}$'
    AND a.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
    AND a.size_bytes BETWEEN 1 AND 5242880
    AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = a.storage_bucket AND o.name = a.storage_key);
  RETURN v_guard || jsonb_build_object('profile', v_profile, 'logo', v_logo);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_update_organization_profile_v1(p_args JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $function$
DECLARE
  v_org UUID := (p_args->>'organization_id')::UUID;
  v_guard JSONB;
  v_defaults JSONB;
  v_branding JSONB;
  v_artifact public.artifacts%ROWTYPE;
  v_key TEXT;
BEGIN
  v_guard := public.organization_profile_assert_writer_v1(v_org);
  IF jsonb_typeof(p_args) IS DISTINCT FROM 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN
      ('organization_id','name','timezone','locale','primary_color','secondary_color','logo_artifact_id')
  ) THEN RAISE EXCEPTION 'Invalid profile fields' USING ERRCODE = '22023'; END IF;
  IF p_args ? 'name' AND (jsonb_typeof(p_args->'name') IS DISTINCT FROM 'string' OR length(btrim(p_args->>'name')) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'Invalid organization name' USING ERRCODE = '22023';
  END IF;
  IF p_args ? 'timezone' AND (jsonb_typeof(p_args->'timezone') IS DISTINCT FROM 'string' OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_args->>'timezone')) THEN
    RAISE EXCEPTION 'Invalid timezone' USING ERRCODE = '22023';
  END IF;
  IF p_args ? 'locale' AND (jsonb_typeof(p_args->'locale') IS DISTINCT FROM 'string' OR length(p_args->>'locale') > 100 OR p_args->>'locale' !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$') THEN
    RAISE EXCEPTION 'Invalid locale' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['primary_color','secondary_color'] LOOP
    IF p_args ? v_key AND (jsonb_typeof(p_args->v_key) IS DISTINCT FROM 'string' OR p_args->>v_key !~ '^#[0-9A-Fa-f]{6}$') THEN
      RAISE EXCEPTION 'Invalid branding color' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT COALESCE(default_settings, '{}'::jsonb) INTO v_defaults FROM public.organizations WHERE id = v_org FOR UPDATE;
  IF jsonb_typeof(v_defaults) <> 'object' OR (v_defaults ? 'branding' AND jsonb_typeof(v_defaults->'branding') <> 'object') THEN
    RAISE EXCEPTION 'Existing organization defaults require repair' USING ERRCODE = '22023';
  END IF;
  -- This command edits profile/branding only, never arbitrary auth, onboarding or runtime defaults.
  v_branding := COALESCE(v_defaults->'branding', '{}'::jsonb);
  FOREACH v_key IN ARRAY ARRAY['primary_color','secondary_color'] LOOP
    IF p_args ? v_key THEN v_branding := jsonb_set(v_branding, ARRAY[v_key], p_args->v_key); END IF;
  END LOOP;
  IF p_args ? 'logo_artifact_id' THEN
    SELECT * INTO v_artifact FROM public.artifacts a
    WHERE a.id = (p_args->>'logo_artifact_id')::UUID AND a.organization_id = v_org
      AND a.created_by_user_id = auth.uid() AND a.source_system = 'organization-profile'
      AND a.storage_bucket = 'label-render-assets' AND a.size_bytes BETWEEN 1 AND 5242880
      AND a.mime_type IN ('image/png','image/jpeg','image/webp')
      AND a.metadata->>'upload_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND a.metadata->>'file_name' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
      AND a.storage_key = v_org::text || '/branding/' || (a.metadata->>'upload_id') || '/' || (a.metadata->>'file_name')
      AND a.storage_key !~ '(^|/)\.\.(/|$)' AND a.sha256 ~ '^[0-9a-f]{64}$' FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = v_artifact.storage_bucket AND o.name = v_artifact.storage_key) THEN
      RAISE EXCEPTION 'Logo artifact is not an owned branding upload' USING ERRCODE = '42501';
    END IF;
    v_branding := (v_branding - 'logo_url') || jsonb_build_object(
      'logo_artifact_id', v_artifact.id, 'logo_storage_bucket', v_artifact.storage_bucket,
      'logo_storage_key', v_artifact.storage_key, 'logo_file_name', v_artifact.metadata->>'file_name',
      'logo_content_type', v_artifact.mime_type);
  END IF;
  v_defaults := jsonb_set(v_defaults, '{branding}', v_branding);
  UPDATE public.organizations SET
    name = CASE WHEN p_args ? 'name' THEN btrim(p_args->>'name') ELSE name END,
    timezone = CASE WHEN p_args ? 'timezone' THEN p_args->>'timezone' ELSE timezone END,
    locale = CASE WHEN p_args ? 'locale' THEN p_args->>'locale' ELSE locale END,
    default_settings = v_defaults, updated_at = now()
  WHERE id = v_org;
  RETURN public.organization_profile_read_v1(v_org);
END;
$function$;

-- Compensation is limited to the new registered object, never a previous logo or a linked artifact.
CREATE OR REPLACE FUNCTION public.organization_profile_abort_upload_v1(
  p_artifact_id UUID, p_organization_id UUID, p_actor_user_id UUID, p_upload_id UUID, p_storage_key TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $function$
DECLARE v_artifact public.artifacts%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_artifact FROM public.artifacts WHERE id = p_artifact_id FOR UPDATE;
  IF NOT FOUND OR p_actor_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor_user_id)
    OR v_artifact.organization_id IS DISTINCT FROM p_organization_id
    OR v_artifact.created_by_user_id IS DISTINCT FROM p_actor_user_id
    OR v_artifact.source_system IS DISTINCT FROM 'organization-profile'
    OR v_artifact.storage_bucket IS DISTINCT FROM 'label-render-assets'
    OR v_artifact.storage_key IS DISTINCT FROM p_storage_key
    OR v_artifact.metadata->>'upload_id' IS DISTINCT FROM p_upload_id::text
    OR p_storage_key IS DISTINCT FROM p_organization_id::text || '/branding/' || p_upload_id::text || '/' || (v_artifact.metadata->>'file_name')
    OR EXISTS (SELECT 1 FROM public.organizations WHERE default_settings->'branding'->>'logo_artifact_id' = p_artifact_id::text
      OR (default_settings->'branding'->>'logo_storage_bucket' = 'label-render-assets' AND default_settings->'branding'->>'logo_storage_key' = p_storage_key))
    OR EXISTS (SELECT 1 FROM public.artifacts WHERE id <> p_artifact_id AND storage_bucket = 'label-render-assets' AND storage_key = p_storage_key)
    OR EXISTS (SELECT 1 FROM public.artifact_links WHERE artifact_id = p_artifact_id)
  THEN RAISE EXCEPTION 'Upload identity is missing, changed or linked' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.artifacts WHERE id = p_artifact_id;
  RETURN TRUE;
END;
$function$;

REVOKE ALL ON FUNCTION public.organization_profile_assert_writer_v1(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.organization_profile_read_v1(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ui_update_organization_profile_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.organization_profile_abort_upload_v1(UUID,UUID,UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organization_profile_assert_writer_v1(UUID), public.organization_profile_read_v1(UUID), public.ui_update_organization_profile_v1(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.organization_profile_abort_upload_v1(UUID,UUID,UUID,UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION api.organization_profile_read_v1(p_organization_id UUID) RETURNS JSONB
LANGUAGE sql SET search_path TO public, extensions, pg_temp AS $function$ SELECT public.organization_profile_read_v1(p_organization_id); $function$;
CREATE OR REPLACE FUNCTION api.ui_update_organization_profile_v1(p_args JSONB) RETURNS JSONB
LANGUAGE sql SET search_path TO public, extensions, pg_temp AS $function$ SELECT public.ui_update_organization_profile_v1(p_args); $function$;
CREATE OR REPLACE FUNCTION api.organization_profile_abort_upload_v1(p_artifact_id UUID,p_organization_id UUID,p_actor_user_id UUID,p_upload_id UUID,p_storage_key TEXT) RETURNS BOOLEAN
LANGUAGE sql SET search_path TO public, extensions, pg_temp AS $function$ SELECT public.organization_profile_abort_upload_v1(p_artifact_id,p_organization_id,p_actor_user_id,p_upload_id,p_storage_key); $function$;
REVOKE ALL ON FUNCTION api.organization_profile_read_v1(UUID), api.ui_update_organization_profile_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.organization_profile_abort_upload_v1(UUID,UUID,UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.organization_profile_read_v1(UUID), api.ui_update_organization_profile_v1(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION api.organization_profile_abort_upload_v1(UUID,UUID,UUID,UUID,TEXT) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
