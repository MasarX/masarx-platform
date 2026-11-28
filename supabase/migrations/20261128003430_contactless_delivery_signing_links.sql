BEGIN;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'customer_device_sign_policy', 'Tenant opt-in for customer delivery signing links.',
  TRUE, FALSE, TRUE, 'return_null', '["tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'customer_device_sign_policy', 1,
  '{"type":"object","properties":{"enabled":{"type":"boolean"}},"required":["enabled"],"additionalProperties":false}'::jsonb,
  'Enable delivery signing links explicitly for a tenant.', '[{"enabled":false}]'::jsonb, TRUE
);

CREATE TABLE public.contactless_pod_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_digest bytea NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  issued_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  attempt_id uuid,
  attempt_expires_at timestamptz,
  submitted_at timestamptz,
  signature_sha256 text,
  signature_length integer,
  signature_artifact_id uuid REFERENCES public.artifacts(id) ON DELETE SET NULL
);
CREATE INDEX contactless_pod_submissions_task_idx ON public.contactless_pod_submissions (task_id, created_at DESC);
CREATE INDEX contactless_pod_submissions_org_idx ON public.contactless_pod_submissions (organization_id);
CREATE INDEX contactless_pod_submissions_issuer_idx ON public.contactless_pod_submissions (issued_by);
CREATE INDEX contactless_pod_submissions_artifact_idx ON public.contactless_pod_submissions (signature_artifact_id);
ALTER TABLE public.contactless_pod_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contactless_pod_submissions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contactless_pod_submissions TO postgres;
CREATE POLICY contactless_pod_submissions_api_only ON public.contactless_pod_submissions
  AS RESTRICTIVE FOR ALL TO service_role, anon, authenticated USING (FALSE) WITH CHECK (FALSE);

INSERT INTO public.table_contracts (
  table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes
) VALUES (
  'public', 'contactless_pod_submissions', TRUE, FALSE, FALSE,
  'Private signing receipts use explicit lifecycle timestamps and hold sensitive signing metadata.'
);

CREATE FUNCTION public.contactless_pod_signing_origin_v1(p_origin text, p_tenant_enabled boolean)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT CASE WHEN p_tenant_enabled IS TRUE
    AND btrim(p_origin) ~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?/?$'
    AND COALESCE(substring(btrim(p_origin) FROM ':([0-9]{1,5})/?$')::integer BETWEEN 1 AND 65535, TRUE)
    THEN rtrim(btrim(p_origin), '/') END;
$function$;
REVOKE ALL ON FUNCTION public.contactless_pod_signing_origin_v1(text, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.contactless_pod_origin_for_tenant_v1(p_organization_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT public.contactless_pod_signing_origin_v1(
    (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'contactless_pod_signing_origin'),
    EXISTS (
      SELECT 1 FROM public.settings s
       WHERE s.category = 'customer_device_sign_policy' AND s.scope_type = 'tenant'
         AND s.scope_id = p_organization_id AND s.cached_value->'enabled' = 'true'::jsonb
    )
  );
$function$;
REVOKE ALL ON FUNCTION public.contactless_pod_origin_for_tenant_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION api.contactless_pod_link_available_v1(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(public.current_user_scope_type() = 'tenant', FALSE)
    AND EXISTS (SELECT 1 FROM storage.buckets b WHERE b.id = 'fieldops-evidence' AND b.public IS FALSE)
    AND COALESCE(public.user_has_capability_v1('tasks.complete', 'tenant',
      COALESCE(public.current_user_scope_id(), public.current_user_org_id())), FALSE)
    AND EXISTS (
    SELECT 1 FROM public.tasks t
    JOIN public.route_stops r ON r.id = t.resource_id AND r.organization_id = t.organization_id
     WHERE t.id = p_task_id AND t.organization_id = public.current_user_org_id() AND t.assigned_to = auth.uid()
       AND t.resource_type = 'route_stop' AND r.stop_kind = 'delivery' AND t.status IN ('assigned', 'in_progress')
       AND public.contactless_pod_origin_for_tenant_v1(t.organization_id) IS NOT NULL
  );
$function$;
REVOKE ALL ON FUNCTION api.contactless_pod_link_available_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.contactless_pod_link_available_v1(uuid) TO authenticated;

CREATE FUNCTION api.mint_contactless_pod_token_v1(p_task_id uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_organization uuid := public.current_user_org_id();
  v_origin text;
  v_token text;
BEGIN
  IF api.contactless_pod_link_available_v1(p_task_id) IS DISTINCT FROM TRUE THEN RETURN NULL; END IF;

  PERFORM 1
    FROM public.tasks t
    JOIN public.route_stops r ON r.id = t.resource_id AND r.organization_id = t.organization_id
   WHERE t.id = p_task_id AND t.organization_id = v_organization AND t.assigned_to = v_actor
     AND t.resource_type = 'route_stop' AND r.stop_kind = 'delivery' AND t.status IN ('assigned', 'in_progress')
   FOR UPDATE OF t;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_origin := public.contactless_pod_origin_for_tenant_v1(v_organization);
  IF v_origin IS NULL THEN RETURN NULL; END IF;

  DELETE FROM public.contactless_pod_submissions s
   WHERE s.task_id = p_task_id AND s.submitted_at IS NULL;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.contactless_pod_submissions (token_digest, organization_id, task_id, issued_by, expires_at)
  VALUES (extensions.digest(v_token, 'sha256'), v_organization, p_task_id, v_actor, clock_timestamp() + interval '15 minutes');
  RETURN v_origin || '/delivery-signing#token=' || v_token;
END;
$function$;
REVOKE ALL ON FUNCTION api.mint_contactless_pod_token_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.mint_contactless_pod_token_v1(uuid) TO authenticated;

CREATE FUNCTION public.lock_contactless_pod_task_v1(p_digest bytea)
RETURNS boolean LANGUAGE plpgsql VOLATILE
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM 1 FROM public.tasks t
    JOIN public.contactless_pod_submissions s ON s.task_id = t.id AND s.organization_id = t.organization_id
    JOIN public.route_stops r ON r.id = t.resource_id AND r.organization_id = t.organization_id
   WHERE s.token_digest = p_digest AND t.assigned_to = s.issued_by
     AND t.resource_type = 'route_stop' AND r.stop_kind = 'delivery' AND t.status IN ('assigned', 'in_progress')
   FOR UPDATE OF t;
  RETURN FOUND;
END;
$function$;
REVOKE ALL ON FUNCTION public.lock_contactless_pod_task_v1(bytea) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION api.begin_contactless_pod_attempt_v1(p_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_digest bytea;
  v_submission public.contactless_pod_submissions%ROWTYPE;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets b WHERE b.id = 'fieldops-evidence' AND b.public IS FALSE) THEN
    RETURN NULL;
  END IF;
  v_digest := extensions.digest(p_token, 'sha256');
  IF NOT public.lock_contactless_pod_task_v1(v_digest) THEN RETURN NULL; END IF;

  UPDATE public.contactless_pod_submissions s
     SET attempt_count = s.attempt_count + 1,
         attempt_id = gen_random_uuid(),
         attempt_expires_at = LEAST(s.expires_at, clock_timestamp() + interval '90 seconds')
   WHERE s.token_digest = v_digest
     AND s.submitted_at IS NULL AND s.expires_at > clock_timestamp()
     AND s.attempt_count < 5
     AND (s.attempt_id IS NULL OR s.attempt_expires_at <= clock_timestamp())
     AND public.contactless_pod_origin_for_tenant_v1(s.organization_id) IS NOT NULL
   RETURNING s.* INTO v_submission;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'attempt_id', v_submission.attempt_id,
    'storage_key', format('%s/%s/customer-signature-%s.png',
      v_submission.organization_id, v_submission.task_id, v_submission.attempt_id)
  );
END;
$function$;
REVOKE ALL ON FUNCTION api.begin_contactless_pod_attempt_v1(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION api.submit_contactless_pod_v1(
  p_token text, p_attempt_id uuid, p_signature_sha256 text, p_signature_length integer
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_digest bytea;
  v_submission public.contactless_pod_submissions%ROWTYPE;
  v_key text;
  v_artifact_id uuid;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' OR p_attempt_id IS NULL THEN RETURN FALSE; END IF;
  v_digest := extensions.digest(p_token, 'sha256');
  IF NOT public.lock_contactless_pod_task_v1(v_digest) THEN RETURN FALSE; END IF;

  IF p_signature_sha256 IS NULL OR p_signature_sha256 !~ '^[0-9a-f]{64}$'
     OR p_signature_length IS NULL OR p_signature_length NOT BETWEEN 9 AND 1048576 THEN
    UPDATE public.contactless_pod_submissions s SET attempt_id = NULL, attempt_expires_at = NULL
     WHERE s.token_digest = v_digest AND s.attempt_id = p_attempt_id AND s.submitted_at IS NULL;
    RETURN FALSE;
  END IF;

  UPDATE public.contactless_pod_submissions s
     SET submitted_at = clock_timestamp(), signature_sha256 = p_signature_sha256, signature_length = p_signature_length
   WHERE s.token_digest = v_digest AND s.attempt_id = p_attempt_id
     AND s.submitted_at IS NULL AND s.expires_at > clock_timestamp() AND s.attempt_expires_at > clock_timestamp()
     AND public.contactless_pod_origin_for_tenant_v1(s.organization_id) IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM storage.objects o
        JOIN storage.buckets b ON b.id = o.bucket_id AND b.public IS FALSE
        WHERE o.bucket_id = 'fieldops-evidence'
          AND o.name = format('%s/%s/customer-signature-%s.png', s.organization_id, s.task_id, s.attempt_id)
          AND o.metadata->>'size' = p_signature_length::text AND o.metadata->>'mimetype' = 'image/png'
     )
   RETURNING s.* INTO v_submission;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  v_key := format('%s/%s/customer-signature-%s.png', v_submission.organization_id, v_submission.task_id, p_attempt_id);
  SELECT a.artifact_id INTO STRICT v_artifact_id FROM public.register_artifact_v1(jsonb_build_object(
    'organization_id', v_submission.organization_id, 'storage_bucket', 'fieldops-evidence',
    'storage_key', v_key, 'mime_type', 'image/png', 'sha256', p_signature_sha256, 'size_bytes', p_signature_length,
    'source_system', 'contactless_pod', 'metadata', jsonb_build_object('file_name', 'customer-signature.png')
  )) a;
  UPDATE public.contactless_pod_submissions SET signature_artifact_id = v_artifact_id WHERE id = v_submission.id;
  INSERT INTO public.artifact_links (organization_id, artifact_id, resource_type, resource_id, relation_type)
  VALUES (v_submission.organization_id, v_artifact_id, 'task', v_submission.task_id, 'pod')
  ON CONFLICT DO NOTHING;
  RETURN TRUE;
END;
$function$;
REVOKE ALL ON FUNCTION api.submit_contactless_pod_v1(text, uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'contactless_pod_intake') THEN
    CREATE ROLE contactless_pod_intake NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END;
$role$;
-- Enable gateway membership and API schema usage together after verifying the effective API allowlist.
GRANT EXECUTE ON FUNCTION api.begin_contactless_pod_attempt_v1(text) TO contactless_pod_intake;
GRANT EXECUTE ON FUNCTION api.submit_contactless_pod_v1(text, uuid, text, integer) TO contactless_pod_intake;

CREATE FUNCTION public.link_contactless_pod_to_shipment_action_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_event_id text := NEW.action_data->>'task_event_id';
  v_artifact_id uuid;
BEGIN
  IF v_event_id IS NULL OR v_event_id !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  SELECT s.signature_artifact_id INTO v_artifact_id
    FROM public.task_events e
    JOIN public.tasks t ON t.id = e.task_id AND t.organization_id = e.organization_id
    JOIN public.route_stops r ON r.id = t.resource_id AND r.organization_id = t.organization_id
    JOIN public.contactless_pod_submissions s ON s.task_id = t.id AND s.organization_id = t.organization_id
   WHERE e.id = v_event_id::uuid AND e.to_status = 'completed' AND e.organization_id = NEW.organization_id
     AND t.resource_type = 'route_stop' AND r.stop_kind = 'delivery' AND r.shipment_id = NEW.shipment_id
     AND s.signature_artifact_id IS NOT NULL AND s.submitted_at <= e.created_at
   ORDER BY s.submitted_at DESC, s.id
   LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO public.artifact_links (organization_id, artifact_id, resource_type, resource_id, relation_type)
  VALUES (NEW.organization_id, v_artifact_id, 'shipment_action', NEW.id, 'pod')
  ON CONFLICT DO NOTHING;
  IF COALESCE(
    NEW.action_data #>> '{delivery_completion,signature_artifact_id}',
    NEW.action_data #>> '{task_event_payload,pod,signature_artifact_id}',
    NEW.action_data #>> '{task_event_payload,signature_artifact_id}',
    NEW.action_data #>> '{pod,signature_artifact_id}',
    NEW.action_data ->> 'signature_artifact_id'
  ) IS NULL THEN
    NEW.action_data := jsonb_set(NEW.action_data, '{delivery_completion,signature_artifact_id}', to_jsonb(v_artifact_id));
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.link_contactless_pod_to_shipment_action_v1() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER link_contactless_pod_to_shipment_action
BEFORE INSERT OR UPDATE OF action_data ON public.shipment_actions
FOR EACH ROW
WHEN (NEW.action_data #>> '{delivery_completion,completion_kind}' IN ('full', 'partial'))
EXECUTE FUNCTION public.link_contactless_pod_to_shipment_action_v1();

COMMIT;
