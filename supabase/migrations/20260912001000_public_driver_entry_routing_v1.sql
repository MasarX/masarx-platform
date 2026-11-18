BEGIN;
-- Deliberately public routing identifiers only; no invitation tokens or private metadata.
UPDATE public.schema_registry
SET schema=jsonb_set(schema,'{properties}',COALESCE(schema->'properties','{}'::jsonb) ||
  '{"public_entries":{"type":"object","additionalProperties":{"type":"object","additionalProperties":false,"required":["enabled","public","organization_id","participant_type_key"],"properties":{"enabled":{"type":"boolean"},"public":{"const":true},"organization_id":{"type":"string","format":"uuid"},"participant_type_key":{"type":"string","minLength":1}}}}}'::jsonb)
WHERE category='marketplace_compliance_policy' AND is_active;

CREATE OR REPLACE FUNCTION public.marketplace_public_entry_resolve_v1(p_entry_key TEXT,p_participant_type_key TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public,extensions,pg_temp
AS $function$
DECLARE
 v_entry JSONB;
 v_org UUID;
 v_slug TEXT;
BEGIN
 -- Deliberately omit every caller-supplied scope selector.
 v_entry:=public.marketplace_compliance_policy_v1('{}'::jsonb)#>ARRAY['public_entries',p_entry_key];
 IF p_entry_key IS NULL OR btrim(p_entry_key)='' OR p_participant_type_key IS NULL
    OR jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
    OR v_entry->'enabled' IS DISTINCT FROM 'true'::jsonb
    OR v_entry->'public' IS DISTINCT FROM 'true'::jsonb
    OR v_entry->>'participant_type_key' IS DISTINCT FROM p_participant_type_key THEN
  RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','public_entry_not_allowed'));
 END IF;
 IF v_entry-ARRAY['enabled','public','organization_id','participant_type_key'] <> '{}'::jsonb THEN
  RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','public_entry_not_allowed'));
 END IF;
 BEGIN
  v_org:=(v_entry->>'organization_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','public_entry_not_allowed'));
 END;
 SELECT slug INTO v_slug FROM public.organizations WHERE id=v_org;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','public_entry_not_allowed'));
 END IF;
 RETURN jsonb_build_object('ok',true,'organization_id',v_org,'organization_slug',v_slug);
END;
$function$;
REVOKE ALL ON FUNCTION public.marketplace_public_entry_resolve_v1(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_public_entry_resolve_v1(TEXT,TEXT) TO service_role;
CREATE OR REPLACE FUNCTION api.marketplace_public_entry_resolve_v1(p_entry_key TEXT,p_participant_type_key TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public,extensions,pg_temp
AS $function$
 SELECT public.marketplace_public_entry_resolve_v1(p_entry_key,p_participant_type_key);
$function$;
REVOKE ALL ON FUNCTION api.marketplace_public_entry_resolve_v1(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api.marketplace_public_entry_resolve_v1(TEXT,TEXT) TO service_role;
COMMENT ON FUNCTION public.marketplace_public_entry_resolve_v1(TEXT,TEXT) IS
 'Resolve deliberately public application entry identifiers from global canonical policy; no membership or approval.';
COMMIT;
