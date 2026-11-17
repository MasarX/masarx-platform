-- OAuth secrets are available only through a live, single-use, connection-bound attempt.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261019024000_automation_marketplace_oauth_attempts_v1'));

CREATE TABLE public.integration_connection_oauth_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES public.integration_connections(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_scope_type TEXT NOT NULL,
  owner_scope_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  actor_session_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  credential_generation BIGINT NOT NULL,
  provider_binding JSONB NOT NULL CHECK(jsonb_typeof(provider_binding)='object'),
  binding_hash TEXT NOT NULL,
  pkce_verifier_vault_id UUID REFERENCES vault.secrets(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  claim_token UUID,
  finished_at TIMESTAMPTZ,
  CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '5 minutes'),
  CHECK((consumed_at IS NULL)=(claim_token IS NULL))
);
-- An uncertain refresh exchange must never reuse the same generation's token.
CREATE UNIQUE INDEX integration_connection_oauth_refresh_claim_once
  ON public.integration_connection_oauth_attempts(connection_id,credential_generation)
  WHERE operation='refresh' AND consumed_at IS NOT NULL;
CREATE INDEX idx_marketplace_oauth_attempts_connection ON public.integration_connection_oauth_attempts (connection_id);
CREATE INDEX idx_marketplace_oauth_attempts_organization ON public.integration_connection_oauth_attempts (organization_id);
CREATE INDEX idx_marketplace_oauth_attempts_actor ON public.integration_connection_oauth_attempts (actor_user_id);
CREATE INDEX idx_marketplace_oauth_attempts_verifier ON public.integration_connection_oauth_attempts (pkce_verifier_vault_id);
ALTER TABLE public.integration_connection_oauth_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.integration_connection_oauth_attempts FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY integration_connection_oauth_attempts_service_all ON public.integration_connection_oauth_attempts FOR ALL TO service_role USING(TRUE) WITH CHECK(TRUE);
INSERT INTO public.lookup_definitions(category,description,owner_role,approval_policy,is_mutable)
VALUES('integration_connection_oauth_operation','Single-use OAuth attempt protocol operation.','engineering','tier_1',FALSE)
ON CONFLICT(category) DO NOTHING;
INSERT INTO public.lookup_values(lookup_definition_id,value,label,sort_order,is_default,status)
SELECT definition.id,operation.value,operation.label,operation.sort_order,FALSE,'active'
 FROM public.lookup_definitions definition
 CROSS JOIN (VALUES ('authorize','Authorize',10),('refresh','Refresh',20)) AS operation(value,label,sort_order)
 WHERE definition.category='integration_connection_oauth_operation'
ON CONFLICT(lookup_definition_id,value) DO NOTHING;
INSERT INTO public.lookup_column_contracts(table_schema,table_name,column_name,lookup_category,allow_inactive)
VALUES('public','integration_connection_oauth_attempts','operation','integration_connection_oauth_operation',FALSE)
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE SET lookup_category=EXCLUDED.lookup_category,allow_inactive=FALSE;
SELECT public.apply_lookup_column_contracts('public');
INSERT INTO public.table_contracts(table_schema,table_name,created_at_required,updated_at_required,audit_enabled,notes)
VALUES('public','integration_connection_oauth_attempts',TRUE,FALSE,FALSE,'RPC-only OAuth attempts; lifecycle timestamps replace updated_at and secrets remain in Vault.')
ON CONFLICT(table_schema,table_name) DO UPDATE SET created_at_required=EXCLUDED.created_at_required,
  updated_at_required=EXCLUDED.updated_at_required,audit_enabled=EXCLUDED.audit_enabled,notes=EXCLUDED.notes;

CREATE FUNCTION public.integration_connection_oauth_assert_actor_v1(
  p_user_id UUID,p_session_id TEXT,p_scope_type TEXT,p_scope_id UUID,p_organization_id UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE
  previous_claims TEXT:=current_setting('request.jwt.claims',TRUE);
  previous_sub TEXT:=current_setting('request.jwt.claim.sub',TRUE);
  previous_role TEXT:=current_setting('request.jwt.claim.role',TRUE);
  allowed BOOLEAN;
  actor_scope TEXT; actor_scope_id UUID; actor_org_id UUID; target_type TEXT:=public.normalize_scope_type_v1(p_scope_type,TRUE);
BEGIN
  SELECT u.access_scope_type,u.access_scope_id,u.organization_id INTO actor_scope,actor_scope_id,actor_org_id FROM auth.sessions s
    JOIN public.users u ON u.id=s.user_id
    JOIN auth.users au ON au.id=u.id
    JOIN public.organizations actor_org ON actor_org.id=u.organization_id
    JOIN public.organizations target_org ON target_org.id=p_organization_id
   WHERE s.id::text=p_session_id AND s.user_id=p_user_id
     AND (s.not_after IS NULL OR s.not_after>clock_timestamp())
     AND au.deleted_at IS NULL AND (au.banned_until IS NULL OR au.banned_until<=clock_timestamp())
     AND lower(u.status)='active'
     AND lower(COALESCE(actor_org.billing_status,'active'))<>'suspended'
     AND lower(COALESCE(target_org.billing_status,'active'))<>'suspended'
   FOR SHARE OF s,u,au,actor_org,target_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501'; END IF;
  -- The service database role bypasses shared scope helpers even with actor JWT claims.
  IF NOT COALESCE(actor_scope IN ('platform',public.get_root_scope_type_key_v1()) OR (
    actor_org_id=p_organization_id AND (
      actor_scope='tenant' OR (actor_scope=target_type AND actor_scope_id=p_scope_id)
      OR (actor_scope='client' AND target_type='sender' AND EXISTS(
        SELECT 1 FROM public.senders s JOIN public.clients c ON c.id=s.client_id
         WHERE s.id=p_scope_id AND s.client_id=actor_scope_id AND c.organization_id=actor_org_id))
    )
  ),FALSE) THEN RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501'; END IF;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub',p_user_id::text,TRUE);
    PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id,'role','authenticated','session_id',p_session_id)::text,TRUE);
    PERFORM public.automation_marketplace_assert_scope_v1(p_scope_type,p_scope_id,p_organization_id);
    allowed:=COALESCE((public.user_capability_eval_v1('automation_marketplace.manage_connections',p_scope_type,p_scope_id)->>'allowed')::boolean,FALSE);
    IF NOT allowed THEN RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501'; END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims',COALESCE(previous_claims,''),TRUE);
    PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_sub,''),TRUE);
    PERFORM set_config('request.jwt.claim.role',COALESCE(previous_role,''),TRUE);
    RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501';
  END;
  PERFORM set_config('request.jwt.claims',COALESCE(previous_claims,''),TRUE);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_sub,''),TRUE);
  PERFORM set_config('request.jwt.claim.role',COALESCE(previous_role,''),TRUE);
END;
$function$;

CREATE FUNCTION public.integration_connection_oauth_callback_valid_v1(p_console_origin TEXT,p_redirect_uri TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $function$
 SELECT COALESCE(
   p_console_origin ~ '^https://[^/@?#:[:space:]]+(:443)?$'
   AND p_console_origin !~ '[[:cntrl:]]' AND strpos(p_console_origin,chr(92))=0 AND strpos(p_console_origin,'%')=0
   AND p_redirect_uri !~ '[[:cntrl:]]'
   AND left(p_redirect_uri,char_length(p_console_origin)+1)=p_console_origin||'/'
   AND substring(p_redirect_uri FROM char_length(p_console_origin)+1) ~ '^(/[A-Za-z0-9._~!$&''()*+,;=:@-]+)*/api/automation-marketplace/oauth/callback$'
   AND substring(p_redirect_uri FROM char_length(p_console_origin)+1) !~ '(^|/)[.]{1,2}(/|$)',
   FALSE);
$function$;

CREATE FUNCTION public.integration_connection_oauth_binding_v1(p_connection_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE
  connection public.integration_connections%ROWTYPE;
  provider JSONB;
  binding JSONB;
BEGIN
  SELECT * INTO STRICT connection FROM public.integration_connections WHERE id=p_connection_id;
  IF connection.provider_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.providers p
    WHERE p.id=connection.provider_id AND p.organization_id=connection.organization_id AND p.enabled) THEN
    RAISE EXCEPTION 'OAuth provider configuration invalid' USING ERRCODE='22023';
  END IF;
  provider:=public.automation_marketplace_resolve_policy_v1(connection.owner_scope_type,connection.owner_scope_id,connection.organization_id)
    #> ARRAY['oauth','providers',connection.provider_key];
  IF provider IS NULL OR provider='{}'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(provider) IS DISTINCT FROM 'object' OR jsonb_typeof(provider->'scopes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'OAuth provider configuration invalid' USING ERRCODE='22023';
  END IF;
  IF COALESCE(provider->>'provider_key',connection.provider_key) IS DISTINCT FROM connection.provider_key
    OR NULLIF(btrim(provider->>'client_id'),'') IS NULL
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(provider->'scopes') scope WHERE jsonb_typeof(scope)<>'string')
    OR COALESCE(provider->>'authorization_url','') !~ '^https://[^/@?#:[:space:]]+(:443)?(/[^#[:space:]]*)?$'
    OR COALESCE(provider->>'token_url','') !~ '^https://[^/@?#:[:space:]]+(:443)?(/[^#[:space:]]*)?$'
    OR NOT public.integration_connection_oauth_callback_valid_v1(provider->>'console_origin',provider->>'redirect_uri')
  THEN RAISE EXCEPTION 'OAuth provider configuration invalid' USING ERRCODE='22023'; END IF;
  binding:=jsonb_build_object('provider_key',connection.provider_key,
    'authorization_url',provider->>'authorization_url','token_url',provider->>'token_url',
    'client_id',provider->>'client_id','scopes',provider->'scopes',
    'redirect_uri',provider->>'redirect_uri','console_origin',provider->>'console_origin');
  RETURN jsonb_build_object('provider_binding',binding,'binding_hash',encode(digest(binding::text,'sha256'),'hex'));
END;
$function$;

CREATE FUNCTION public.integration_connection_oauth_context_v1(p_connection_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE connection public.integration_connections%ROWTYPE; context JSONB;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO connection FROM public.integration_connections WHERE id=p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501'; END IF;
  PERFORM public.integration_connection_oauth_assert_actor_v1(auth.uid(),auth.jwt()->>'session_id',connection.owner_scope_type,connection.owner_scope_id,connection.organization_id);
  IF connection.auth_type<>'oauth2_authorization_code_pkce' OR connection.revoked_at IS NOT NULL OR connection.status IN ('revoked','disabled') THEN
    RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501';
  END IF;
  context:=public.integration_connection_oauth_binding_v1(connection.id);
  IF context IS NULL THEN RETURN jsonb_build_object('configured',FALSE); END IF;
  RETURN context||jsonb_build_object('configured',TRUE,'connection_id',connection.id,'provider_key',connection.provider_key,
    'status',connection.status,'credential_generation',connection.credential_generation);
END;
$function$;

CREATE FUNCTION public.integration_connection_oauth_begin_v1(
  p_connection_id UUID,p_operation TEXT,p_state_hash TEXT,p_pkce_verifier TEXT,p_redirect_uri TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE
  connection public.integration_connections%ROWTYPE; context JSONB;
  attempt_id UUID:=gen_random_uuid(); verifier_id UUID; started_at TIMESTAMPTZ; deadline TIMESTAMPTZ; expired RECORD;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'OAuth authorization denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT connection FROM public.integration_connections WHERE id=p_connection_id FOR UPDATE;
  context:=public.integration_connection_oauth_context_v1(connection.id);
  IF COALESCE((context->>'configured')::boolean,FALSE) IS NOT TRUE OR p_operation IS NULL OR p_operation NOT IN ('authorize','refresh')
    OR p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$'
    OR p_redirect_uri IS DISTINCT FROM context#>>'{provider_binding,redirect_uri}'
    OR (p_operation='authorize' AND (p_pkce_verifier IS NULL OR p_pkce_verifier !~ '^[A-Za-z0-9._~-]{43,128}$'))
    OR (p_operation='refresh' AND (p_pkce_verifier IS NOT NULL OR connection.status<>'ready' OR connection.credentials_vault_id IS NULL))
  THEN RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000'; END IF;
  FOR expired IN SELECT id,pkce_verifier_vault_id FROM public.integration_connection_oauth_attempts
    WHERE connection_id=connection.id AND actor_user_id=auth.uid() AND expires_at<=clock_timestamp()
      AND pkce_verifier_vault_id IS NOT NULL LIMIT 32 FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.integration_connection_oauth_attempts SET pkce_verifier_vault_id=NULL WHERE id=expired.id;
    DELETE FROM vault.secrets WHERE id=expired.pkce_verifier_vault_id;
  END LOOP;
  IF p_operation='authorize' THEN
    verifier_id:=public.automation_marketplace_store_secret_payload_v1(NULL,jsonb_build_object('pkce_verifier',p_pkce_verifier));
  END IF;
  started_at:=clock_timestamp(); deadline:=started_at+INTERVAL '5 minutes';
  INSERT INTO public.integration_connection_oauth_attempts(id,connection_id,organization_id,owner_scope_type,owner_scope_id,
    actor_user_id,actor_session_id,operation,state_hash,credential_generation,provider_binding,binding_hash,pkce_verifier_vault_id,created_at,expires_at)
  VALUES(attempt_id,connection.id,connection.organization_id,connection.owner_scope_type,connection.owner_scope_id,
    auth.uid(),auth.jwt()->>'session_id',p_operation,p_state_hash,connection.credential_generation,
    context->'provider_binding',context->>'binding_hash',verifier_id,started_at,deadline);
  RETURN jsonb_build_object('attempt_id',attempt_id,'expires_at',deadline,
    'credential_generation',connection.credential_generation,'binding_hash',context->>'binding_hash');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000';
END;
$function$;

CREATE FUNCTION public.integration_connection_oauth_consume_v1(
  p_state_hash TEXT,p_actor_user_id UUID,p_session_id TEXT,p_connection_id UUID,p_operation TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE
  attempt public.integration_connection_oauth_attempts%ROWTYPE;
  connection public.integration_connections%ROWTYPE;
  context JSONB; secret JSONB; claim UUID:=gen_random_uuid();
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT attempt FROM public.integration_connection_oauth_attempts
   WHERE state_hash=p_state_hash AND actor_user_id=p_actor_user_id AND actor_session_id=p_session_id
     AND connection_id=p_connection_id AND operation=p_operation FOR UPDATE;
  SELECT * INTO STRICT connection FROM public.integration_connections WHERE id=attempt.connection_id FOR UPDATE;
  IF attempt.consumed_at IS NOT NULL OR attempt.finished_at IS NOT NULL OR attempt.expires_at<=clock_timestamp()
    OR connection.credential_generation<>attempt.credential_generation OR connection.organization_id<>attempt.organization_id
    OR connection.owner_scope_type<>attempt.owner_scope_type OR connection.owner_scope_id<>attempt.owner_scope_id
    OR connection.revoked_at IS NOT NULL OR connection.status IN ('revoked','disabled')
    OR connection.auth_type<>'oauth2_authorization_code_pkce'
  THEN RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000'; END IF;
  PERFORM public.integration_connection_oauth_assert_actor_v1(attempt.actor_user_id,attempt.actor_session_id,
    connection.owner_scope_type,connection.owner_scope_id,connection.organization_id);
  context:=public.integration_connection_oauth_binding_v1(connection.id);
  IF context IS NULL OR context->>'binding_hash' IS DISTINCT FROM attempt.binding_hash
    OR context->'provider_binding' IS DISTINCT FROM attempt.provider_binding THEN
    RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000';
  END IF;
  UPDATE public.integration_connection_oauth_attempts SET consumed_at=clock_timestamp(),claim_token=claim WHERE id=attempt.id;
  IF attempt.operation='authorize' THEN
    SELECT decrypted_secret::jsonb INTO STRICT secret FROM vault.decrypted_secrets WHERE id=attempt.pkce_verifier_vault_id;
    IF NULLIF(secret->>'pkce_verifier','') IS NULL THEN RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000'; END IF;
    UPDATE public.integration_connection_oauth_attempts SET pkce_verifier_vault_id=NULL WHERE id=attempt.id;
    DELETE FROM vault.secrets WHERE id=attempt.pkce_verifier_vault_id;
  ELSE
    IF connection.status<>'ready' THEN RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000'; END IF;
    SELECT decrypted_secret::jsonb INTO STRICT secret FROM vault.decrypted_secrets WHERE id=connection.credentials_vault_id;
    IF NULLIF(secret->>'refresh_token','') IS NULL THEN RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('attempt_id',attempt.id,'claim_token',claim,'connection_id',connection.id,
    'credential_generation',connection.credential_generation,'provider_binding',attempt.provider_binding,'binding_hash',attempt.binding_hash,
    'expires_at',attempt.expires_at,'pkce_verifier',CASE WHEN attempt.operation='authorize' THEN secret->>'pkce_verifier' END,
    'refresh_token',CASE WHEN attempt.operation='refresh' THEN secret->>'refresh_token' END));
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'OAuth attempt invalid' USING ERRCODE='55000';
END;
$function$;

CREATE FUNCTION public.integration_connection_oauth_finish_v1(
  p_attempt_id UUID,p_claim_token UUID,p_secret_payload JSONB,p_oauth_metadata JSONB,
  p_status TEXT,p_expires_at TIMESTAMPTZ,p_status_reason TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE
  attempt public.integration_connection_oauth_attempts%ROWTYPE;
  connection public.integration_connections%ROWTYPE;
  context JSONB; secret JSONB; previous_secret JSONB; secret_id UUID; updated_count INT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'OAuth completion conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT attempt FROM public.integration_connection_oauth_attempts WHERE id=p_attempt_id FOR UPDATE;
  SELECT * INTO STRICT connection FROM public.integration_connections WHERE id=attempt.connection_id FOR UPDATE;
  IF attempt.claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL OR attempt.consumed_at IS NULL
    OR attempt.finished_at IS NOT NULL OR attempt.expires_at<=clock_timestamp()
    OR connection.credential_generation<>attempt.credential_generation OR connection.organization_id<>attempt.organization_id
    OR connection.owner_scope_type<>attempt.owner_scope_type OR connection.owner_scope_id<>attempt.owner_scope_id
    OR connection.revoked_at IS NOT NULL OR connection.status IN ('revoked','disabled')
    OR connection.auth_type<>'oauth2_authorization_code_pkce' OR p_status IS NULL OR p_status NOT IN ('ready','reauth_required')
  THEN RAISE EXCEPTION 'OAuth completion conflict' USING ERRCODE='55000'; END IF;
  PERFORM public.integration_connection_oauth_assert_actor_v1(attempt.actor_user_id,attempt.actor_session_id,
    connection.owner_scope_type,connection.owner_scope_id,connection.organization_id);
  context:=public.integration_connection_oauth_binding_v1(connection.id);
  IF context IS NULL OR context->>'binding_hash' IS DISTINCT FROM attempt.binding_hash
    OR context->'provider_binding' IS DISTINCT FROM attempt.provider_binding THEN
    RAISE EXCEPTION 'OAuth completion conflict' USING ERRCODE='55000';
  END IF;
  secret_id:=connection.credentials_vault_id;
  IF p_status='ready' THEN
    IF jsonb_typeof(p_secret_payload) IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_secret_payload->'access_token') IS DISTINCT FROM 'string'
      OR NULLIF(p_secret_payload->>'access_token','') IS NULL OR octet_length(p_secret_payload::text)>65536
      OR (p_expires_at IS NOT NULL AND p_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'OAuth completion conflict' USING ERRCODE='55000';
    END IF;
    IF attempt.operation='refresh' THEN
      SELECT decrypted_secret::jsonb INTO STRICT previous_secret FROM vault.decrypted_secrets WHERE id=connection.credentials_vault_id;
    END IF;
    secret:=jsonb_strip_nulls(jsonb_build_object('access_token',p_secret_payload->>'access_token',
      'refresh_token',COALESCE(NULLIF(p_secret_payload->>'refresh_token',''),previous_secret->>'refresh_token'),
      'token_type',p_secret_payload->>'token_type','scope',p_secret_payload->>'scope'));
    secret_id:=public.automation_marketplace_store_secret_payload_v1(connection.credentials_vault_id,secret);
  ELSIF p_secret_payload IS NOT NULL OR p_status_reason IS NULL OR p_status_reason NOT IN ('authorization_denied','token_exchange_failed') THEN
    RAISE EXCEPTION 'OAuth completion conflict' USING ERRCODE='55000';
  END IF;
  UPDATE public.integration_connections SET credentials_vault_id=secret_id,credential_generation=credential_generation+1,
    secret_storage_mode='vault',verifier_secret_hash=NULL,status=p_status,expires_at=CASE WHEN p_status='ready' THEN p_expires_at ELSE expires_at END,
    oauth_metadata=jsonb_strip_nulls(jsonb_build_object('scope',p_oauth_metadata->>'scope','token_type',p_oauth_metadata->>'token_type')),
    metadata=(metadata-'status_reason')||jsonb_build_object('status_reason',CASE WHEN p_status='ready' THEN
      CASE WHEN attempt.operation='refresh' THEN 'refreshed' ELSE 'authorized' END ELSE p_status_reason END),
    updated_by=attempt.actor_user_id,updated_at=clock_timestamp(),last_rotated_at=CASE WHEN p_status='ready' THEN clock_timestamp() ELSE last_rotated_at END
   WHERE id=connection.id AND credential_generation=attempt.credential_generation AND revoked_at IS NULL AND status NOT IN ('revoked','disabled');
  GET DIAGNOSTICS updated_count=ROW_COUNT;
  IF updated_count<>1 THEN RAISE EXCEPTION 'OAuth completion conflict' USING ERRCODE='55000'; END IF;
  IF p_status='ready' THEN
    PERFORM public.automation_marketplace_sync_runtime_auth_config_v1(connection.id);
  ELSE
    UPDATE public.provider_auth_configs SET credentials='{}'::jsonb,credentials_vault_id=NULL,expires_at=clock_timestamp()
      WHERE id=connection.runtime_auth_config_id AND provider_id=connection.provider_id;
  END IF;
  UPDATE public.integration_connection_oauth_attempts SET finished_at=clock_timestamp() WHERE id=attempt.id AND claim_token=p_claim_token AND finished_at IS NULL;
  RETURN jsonb_build_object('ok',TRUE);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'OAuth completion conflict' USING ERRCODE='55000';
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_connection_oauth_assert_actor_v1(UUID,TEXT,TEXT,UUID,UUID),
  public.integration_connection_oauth_binding_v1(UUID),public.integration_connection_oauth_callback_valid_v1(TEXT,TEXT)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.integration_connection_oauth_context_v1(UUID),
  public.integration_connection_oauth_begin_v1(UUID,TEXT,TEXT,TEXT,TEXT),
  public.integration_connection_oauth_consume_v1(TEXT,UUID,TEXT,UUID,TEXT),
  public.integration_connection_oauth_finish_v1(UUID,UUID,JSONB,JSONB,TEXT,TIMESTAMPTZ,TEXT) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.integration_connection_oauth_context_v1(UUID),
  public.integration_connection_oauth_begin_v1(UUID,TEXT,TEXT,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.integration_connection_oauth_consume_v1(TEXT,UUID,TEXT,UUID,TEXT),
  public.integration_connection_oauth_finish_v1(UUID,UUID,JSONB,JSONB,TEXT,TIMESTAMPTZ,TEXT) TO service_role;

CREATE FUNCTION api.integration_connection_oauth_context_v1(p_connection_id UUID)
RETURNS JSONB LANGUAGE sql SET search_path TO public,extensions,pg_temp AS $function$
 SELECT public.integration_connection_oauth_context_v1(p_connection_id);
$function$;
CREATE FUNCTION api.integration_connection_oauth_begin_v1(p_connection_id UUID,p_operation TEXT,p_state_hash TEXT,p_pkce_verifier TEXT,p_redirect_uri TEXT)
RETURNS JSONB LANGUAGE sql SET search_path TO public,extensions,pg_temp AS $function$
 SELECT public.integration_connection_oauth_begin_v1(p_connection_id,p_operation,p_state_hash,p_pkce_verifier,p_redirect_uri);
$function$;
CREATE FUNCTION api.integration_connection_oauth_consume_v1(p_state_hash TEXT,p_actor_user_id UUID,p_session_id TEXT,p_connection_id UUID,p_operation TEXT)
RETURNS JSONB LANGUAGE sql SET search_path TO public,extensions,pg_temp AS $function$
 SELECT public.integration_connection_oauth_consume_v1(p_state_hash,p_actor_user_id,p_session_id,p_connection_id,p_operation);
$function$;
CREATE FUNCTION api.integration_connection_oauth_finish_v1(p_attempt_id UUID,p_claim_token UUID,p_secret_payload JSONB,p_oauth_metadata JSONB,p_status TEXT,p_expires_at TIMESTAMPTZ,p_status_reason TEXT)
RETURNS JSONB LANGUAGE sql SET search_path TO public,extensions,pg_temp AS $function$
 SELECT public.integration_connection_oauth_finish_v1(p_attempt_id,p_claim_token,p_secret_payload,p_oauth_metadata,p_status,p_expires_at,p_status_reason);
$function$;
REVOKE ALL ON FUNCTION api.integration_connection_oauth_context_v1(UUID),api.integration_connection_oauth_begin_v1(UUID,TEXT,TEXT,TEXT,TEXT),
  api.integration_connection_oauth_consume_v1(TEXT,UUID,TEXT,UUID,TEXT),api.integration_connection_oauth_finish_v1(UUID,UUID,JSONB,JSONB,TEXT,TIMESTAMPTZ,TEXT)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION api.integration_connection_oauth_context_v1(UUID),api.integration_connection_oauth_begin_v1(UUID,TEXT,TEXT,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION api.integration_connection_oauth_consume_v1(TEXT,UUID,TEXT,UUID,TEXT),api.integration_connection_oauth_finish_v1(UUID,UUID,JSONB,JSONB,TEXT,TIMESTAMPTZ,TEXT) TO service_role;
COMMIT;
