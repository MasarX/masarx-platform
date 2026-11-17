-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Evidence artifacts foundation v1 + dispatch evidence policy + route_stop_finalize v2
-- Date: 2026-01-24
--
-- Goals:
--   - Canonical artifact registry (SSOT) for evidence file references (storage bucket/key) and metadata.
--   - Generic artifact link model to attach evidence to any domain resource (shipment_action, settlement, etc.).
--   - Row-driven dispatch evidence extraction policy (no hardcoded payload parsing).
--   - Extend route_stop_finalize to link artifacts to the produced shipment_action while keeping idempotency by task_event_id.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601241200_dispatch_evidence_artifacts_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Evidence artifacts: public.artifacts + public.artifact_links
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  sha256 TEXT,
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  source_system TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_bucket_nonempty CHECK (btrim(storage_bucket) <> ''),
  CONSTRAINT artifacts_key_nonempty CHECK (btrim(storage_key) <> ''),
  CONSTRAINT artifacts_size_bytes_ck CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT artifacts_unique_storage UNIQUE (organization_id, storage_bucket, storage_key)
);

COMMENT ON TABLE public.artifacts IS
  'Canonical artifact registry (SSOT) for evidence file references (storage bucket/key) and metadata.';

CREATE INDEX IF NOT EXISTS idx_artifacts_org_created_at
  ON public.artifacts (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_org_storage
  ON public.artifacts (organization_id, storage_bucket, storage_key);

ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.artifacts FROM PUBLIC;
REVOKE ALL ON TABLE public.artifacts FROM anon;
REVOKE ALL ON TABLE public.artifacts FROM authenticated;

DROP POLICY IF EXISTS artifacts_select ON public.artifacts;
CREATE POLICY artifacts_select ON public.artifacts
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS artifacts_service_policy ON public.artifacts;
CREATE POLICY artifacts_service_policy ON public.artifacts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.artifacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.artifacts TO service_role;

DROP TRIGGER IF EXISTS trg_artifacts_set_updated_at ON public.artifacts;
CREATE TRIGGER trg_artifacts_set_updated_at
  BEFORE UPDATE ON public.artifacts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.artifact_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES public.artifacts(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'evidence',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifact_links_resource_type_ck CHECK (
    btrim(resource_type) <> '' AND resource_type = lower(resource_type)
  ),
  CONSTRAINT artifact_links_relation_type_ck CHECK (
    btrim(relation_type) <> '' AND relation_type = lower(relation_type)
  ),
  CONSTRAINT artifact_links_unique UNIQUE (
    organization_id, artifact_id, resource_type, resource_id, relation_type
  )
);

COMMENT ON TABLE public.artifact_links IS
  'Generic artifact link model: attach artifacts to domain resources (shipments, tasks, settlement batches, shipment_actions, etc.).';

CREATE INDEX IF NOT EXISTS idx_artifact_links_org_resource
  ON public.artifact_links (organization_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_org_artifact
  ON public.artifact_links (organization_id, artifact_id, relation_type);

ALTER TABLE public.artifact_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.artifact_links FROM PUBLIC;
REVOKE ALL ON TABLE public.artifact_links FROM anon;
REVOKE ALL ON TABLE public.artifact_links FROM authenticated;

DROP POLICY IF EXISTS artifact_links_select ON public.artifact_links;
CREATE POLICY artifact_links_select ON public.artifact_links
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS artifact_links_service_policy ON public.artifact_links;
CREATE POLICY artifact_links_service_policy ON public.artifact_links
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.artifact_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.artifact_links TO service_role;

DROP TRIGGER IF EXISTS trg_artifact_links_set_updated_at ON public.artifact_links;
CREATE TRIGGER trg_artifact_links_set_updated_at
  BEFORE UPDATE ON public.artifact_links
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) Service-only RPC: public.register_artifact_v1(jsonb)
--    Idempotent by (organization_id, storage_bucket, storage_key)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_artifact_v1(
  p_artifact JSONB
)
RETURNS TABLE (
  artifact_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_a JSONB := COALESCE(p_artifact, '{}'::jsonb);
  v_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_org UUID := NULL;
  v_bucket TEXT := NULL;
  v_key TEXT := NULL;
  v_mime TEXT := NULL;
  v_sha TEXT := NULL;
  v_size BIGINT := NULL;
  v_user UUID := NULL;
  v_source TEXT := NULL;
  v_meta JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(v_a) <> 'object' THEN
    RAISE EXCEPTION 'register_artifact_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org := NULLIF(v_a->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org := NULL; END;
  v_bucket := NULLIF(btrim(COALESCE(v_a->>'storage_bucket', '')), '');
  v_key := NULLIF(btrim(COALESCE(v_a->>'storage_key', '')), '');
  v_mime := NULLIF(btrim(COALESCE(v_a->>'mime_type', '')), '');
  v_sha := NULLIF(btrim(COALESCE(v_a->>'sha256', '')), '');
  BEGIN v_size := NULLIF(v_a->>'size_bytes', '')::bigint; EXCEPTION WHEN others THEN v_size := NULL; END;
  BEGIN v_user := NULLIF(v_a->>'created_by_user_id', '')::uuid; EXCEPTION WHEN others THEN v_user := NULL; END;
  v_source := NULLIF(btrim(COALESCE(v_a->>'source_system', '')), '');

  v_meta := COALESCE(v_a->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN
    v_meta := '{}'::jsonb;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'register_artifact_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_bucket IS NULL THEN
    RAISE EXCEPTION 'register_artifact_v1 missing storage_bucket' USING ERRCODE = '23514';
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'register_artifact_v1 missing storage_key' USING ERRCODE = '23514';
  END IF;
  IF v_size IS NOT NULL AND v_size < 0 THEN
    RAISE EXCEPTION 'register_artifact_v1 invalid size_bytes' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.artifacts(
    id, organization_id,
    storage_bucket, storage_key,
    mime_type, size_bytes, sha256,
    created_by_user_id, source_system, metadata,
    created_at, updated_at
  ) VALUES (
    v_id, v_org,
    v_bucket, v_key,
    v_mime, v_size, v_sha,
    v_user, v_source, v_meta,
    now(), now()
  )
  ON CONFLICT (organization_id, storage_bucket, storage_key) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT v_id, TRUE;
    RETURN;
  END IF;

  UPDATE public.artifacts a
     SET mime_type = COALESCE(v_mime, a.mime_type),
         size_bytes = COALESCE(v_size, a.size_bytes),
         sha256 = COALESCE(v_sha, a.sha256),
         created_by_user_id = COALESCE(v_user, a.created_by_user_id),
         source_system = COALESCE(v_source, a.source_system),
         metadata = a.metadata || v_meta,
         updated_at = now()
   WHERE a.organization_id = v_org
     AND a.storage_bucket = v_bucket
     AND a.storage_key = v_key
  RETURNING a.id INTO v_id;

  v_created := FALSE;
  RETURN QUERY SELECT v_id, v_created;
END;
$function$;

COMMENT ON FUNCTION public.register_artifact_v1(JSONB) IS
  'Service write-path: register/update an artifact record (idempotent by organization_id + storage_bucket + storage_key).';

REVOKE ALL ON FUNCTION public.register_artifact_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_artifact_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Settings category + schema: dispatch_evidence_policy
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'dispatch_evidence_policy',
  'Dispatch evidence extraction policy: where artifact ids live in task payloads and how to link them (row-driven; ladder-resolved; branch/resource-aware).',
  TRUE,
  TRUE,
  FALSE,
  'return_null',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    resource_scope_rel = EXCLUDED.resource_scope_rel;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'dispatch_evidence_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'artifact_id_paths', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'string'),
        'description', 'JSONPath expressions evaluated against task_events.payload to extract artifact ids (strings).'
      ),
      'relation_type', jsonb_build_object(
        'type', 'string',
        'description', 'Relation type used when linking artifacts (e.g., pod, cod_receipt, bank_statement).'
      ),
      'invalid_artifact_behavior', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('hard_fail', 'skip'),
        'description', 'What to do when provided artifact ids do not exist or are cross-tenant.'
      )
    )
  ),
  'Policy that controls how dispatch workflows extract/link evidence artifacts from task payloads (no hardcoded payload parsing).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'artifact_id_paths', jsonb_build_array('$.artifact_ids[*]'),
      'relation_type', 'pod',
      'invalid_artifact_behavior', 'hard_fail'
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-- Seed global defaults (no hardcoded payload parsing in handler logic).
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'artifact_id_paths', jsonb_build_array('$.artifact_ids[*]'),
    'relation_type', 'pod',
    'invalid_artifact_behavior', 'hard_fail'
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'dispatch_evidence_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global dispatch_evidence_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'dispatch_evidence_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'dispatch_evidence_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-------------------------------------------------------------------------------
-- 4) Workflow handler v2: route_stop_finalize links evidence artifacts (policy-driven)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v2(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'dispatch_stop');

  v_domain_event_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_task_event_payload JSONB := '{}'::jsonb;
  v_event_created_at TIMESTAMPTZ := NULL;
  v_correlation_id UUID := NULL;

  v_stop RECORD;
  v_ship RECORD;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_kind_policy JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;

  v_stop_kind TEXT := NULL;
  v_new_status TEXT := NULL;
  v_action_type TEXT := NULL;
  v_action_category TEXT := NULL;

  v_settings_resolution_id UUID := NULL;
  v_existing BOOLEAN := FALSE;

  -- Evidence policy + extracted artifact ids.
  v_evidence_row RECORD;
  v_evidence_settings_resolution_id UUID := NULL;
  v_evidence_policy JSONB := '{}'::jsonb;
  v_evidence_paths JSONB := '[]'::jsonb;
  v_relation_type TEXT := 'evidence';
  v_invalid_behavior TEXT := 'hard_fail';
  v_artifact_ids UUID[] := NULL;

  v_path TEXT;
  v_matches JSONB;
  v_elem JSONB;
  v_uuid UUID;
  v_expected INT := 0;
  v_found INT := 0;

  v_action_id UUID := NULL;

  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  BEGIN v_domain_event_id := NULLIF(v_ctx->>'domain_event_id', '')::uuid; EXCEPTION WHEN others THEN v_domain_event_id := NULL; END;
  BEGIN v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_route_stop_id := NULL; END;
  BEGIN v_task_id := NULLIF(v_payload->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_task_event_id := NULLIF(v_payload->>'task_event_id', '')::uuid; EXCEPTION WHEN others THEN v_task_event_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_payload->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := NULLIF(btrim(COALESCE(v_payload->>'actor_system', '')), '');
  v_task_event_payload := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  BEGIN v_event_created_at := NULLIF(v_payload->>'task_event_created_at', '')::timestamptz; EXCEPTION WHEN others THEN v_event_created_at := NULL; END;
  BEGIN v_correlation_id := NULLIF(v_task_event_payload->>'correlation_id', '')::uuid; EXCEPTION WHEN others THEN v_correlation_id := NULL; END;

  IF v_route_stop_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: missing resource_id(route_stop_id) (workflow_run_id=% step_id=%)', p_run.id, p_step.id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    rs.id AS route_stop_id,
    rs.organization_id,
    rs.client_id,
    rs.shipment_id,
    rs.stop_kind,
    rs.route_run_id,
    rr.branch_id
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr ON rr.id = rs.route_run_id
  WHERE rs.id = v_route_stop_id
  LIMIT 1;

  IF v_stop.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop % not found', v_route_stop_id USING ERRCODE = '23503';
  END IF;

  SELECT
    s.id AS shipment_id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.status AS shipment_status
  INTO v_ship
  FROM public.shipments s
  WHERE s.id = v_stop.shipment_id
    AND s.client_id = v_stop.client_id
  LIMIT 1;

  IF v_ship.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: shipment % not found for client %', v_stop.shipment_id, v_stop.client_id
      USING ERRCODE = '23503';
  END IF;

  v_stop_kind := lower(COALESCE(NULLIF(btrim(COALESCE(v_stop.stop_kind, '')), ''), 'delivery'));

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'resource_id', v_stop.branch_id,
    'organization_id', v_stop.organization_id,
    'client_id', v_stop.client_id,
    'sender_id', v_ship.sender_id
  ));

  -- Stop policy resolution (controls shipment status/action type).
  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('dispatch_stop_policy', v_policy_ctx)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  v_defaults := COALESCE(v_policy->'defaults', '{}'::jsonb);
  IF jsonb_typeof(v_defaults) <> 'object' THEN
    v_defaults := '{}'::jsonb;
  END IF;

  v_kind_policy := COALESCE(v_policy->'stop_kind_map'->v_stop_kind, '{}'::jsonb);
  IF jsonb_typeof(v_kind_policy) <> 'object' THEN
    v_kind_policy := '{}'::jsonb;
  END IF;

  v_new_status := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'shipment_status', '')), ''));
  v_action_type := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'action_type', v_defaults->>'action_type')), ''));
  v_action_category := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'action_category', v_defaults->>'action_category')), ''));

  IF v_new_status IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: policy missing stop_kind_map.% for shipment_status', v_stop_kind
      USING ERRCODE = '23514';
  END IF;
  IF v_action_type IS NULL OR v_action_category IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: policy missing defaults action_type/action_category' USING ERRCODE = '23514';
  END IF;

  -- Stop policy provenance (settings ladder + scope path) -> settings_resolution_log.
  IF v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_stop.organization_id,
      p_category := 'dispatch_stop_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'route_run_id', v_stop.route_run_id,
        'branch_id', v_stop.branch_id,
        'shipment_id', v_ship.shipment_id,
        'stop_kind', v_stop_kind,
        'task_event_id', v_task_event_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Evidence policy resolution (controls how to find artifact ids in task payload).
  SELECT *
    INTO v_evidence_row
    FROM public.resolve_settings_row_from_policy_context_v1('dispatch_evidence_policy', v_policy_ctx)
   LIMIT 1;

  v_evidence_policy := COALESCE(v_evidence_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_evidence_policy) <> 'object' THEN
    v_evidence_policy := '{}'::jsonb;
  END IF;

  v_evidence_paths := COALESCE(v_evidence_policy->'artifact_id_paths', '[]'::jsonb);
  IF jsonb_typeof(v_evidence_paths) <> 'array' THEN
    v_evidence_paths := '[]'::jsonb;
  END IF;

  v_relation_type := lower(COALESCE(NULLIF(btrim(COALESCE(v_evidence_policy->>'relation_type', '')), ''), 'evidence'));
  v_invalid_behavior := lower(COALESCE(NULLIF(btrim(COALESCE(v_evidence_policy->>'invalid_artifact_behavior', '')), ''), 'hard_fail'));
  IF v_invalid_behavior NOT IN ('hard_fail','skip') THEN
    v_invalid_behavior := 'hard_fail';
  END IF;

  -- Evidence policy provenance (settings ladder + scope path) -> settings_resolution_log.
  IF v_evidence_row.settings_id IS NOT NULL THEN
    v_evidence_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_stop.organization_id,
      p_category := 'dispatch_evidence_policy',
      p_winning_scope_type := v_evidence_row.scope_type,
      p_winning_scope_id := v_evidence_row.scope_id,
      p_winning_settings_id := v_evidence_row.settings_id,
      p_winning_settings_version_id := v_evidence_row.settings_version_id,
      p_winning_version := COALESCE(v_evidence_row.version, 1),
      p_scope_path := v_evidence_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'route_run_id', v_stop.route_run_id,
        'branch_id', v_stop.branch_id,
        'shipment_id', v_ship.shipment_id,
        'stop_kind', v_stop_kind,
        'task_event_id', v_task_event_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Extract artifact ids (strings) using policy jsonpaths.
  v_artifact_ids := ARRAY[]::uuid[];
  FOR v_path IN
    SELECT jsonb_array_elements_text(v_evidence_paths)
  LOOP
    v_path := NULLIF(btrim(COALESCE(v_path, '')), '');
    IF v_path IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      v_matches := jsonb_path_query_array(v_task_event_payload, v_path::jsonpath);
    EXCEPTION WHEN others THEN
      v_matches := '[]'::jsonb;
    END;

    IF jsonb_typeof(v_matches) <> 'array' THEN
      CONTINUE;
    END IF;

    FOR v_elem IN
      SELECT jsonb_array_elements(v_matches)
    LOOP
      IF jsonb_typeof(v_elem) IS DISTINCT FROM 'string' THEN
        CONTINUE;
      END IF;

      BEGIN
        v_uuid := NULLIF(btrim(COALESCE(v_elem#>>'{}', '')), '')::uuid;
      EXCEPTION WHEN others THEN
        v_uuid := NULL;
      END;

      IF v_uuid IS NOT NULL THEN
        v_artifact_ids := array_append(v_artifact_ids, v_uuid);
      END IF;
    END LOOP;
  END LOOP;

  -- Dedupe artifact ids.
  IF array_length(v_artifact_ids, 1) IS NULL THEN
    v_artifact_ids := NULL;
  ELSE
    SELECT array_agg(DISTINCT x)
      INTO v_artifact_ids
      FROM unnest(v_artifact_ids) AS x;
  END IF;

  -- Idempotency: if this task_event already emitted a shipment action, do nothing.
  IF v_task_event_id IS NOT NULL THEN
    SELECT TRUE
      INTO v_existing
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_ship.shipment_id
       AND sa.organization_id = v_stop.organization_id
       AND sa.client_id = v_stop.client_id
       AND (sa.action_data->>'task_event_id') = v_task_event_id::text
     LIMIT 1;

    IF v_existing THEN
      PERFORM public.log_decision(
        p_organization_id := v_stop.organization_id,
        p_decision_category := 'dispatch',
        p_resource_type := 'shipment',
        p_resource_id := v_ship.shipment_id,
        p_decision_point := 'route_stop_finalize',
        p_decision_outcome := 'duplicate_ignored',
        p_performed_by_system := 'dispatch_route_stop_finalize_v2',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'route_stop_id', v_route_stop_id,
          'stop_kind', v_stop_kind,
          'task_event_id', v_task_event_id,
          'domain_event_id', v_domain_event_id,
          'evidence_settings_resolution_id', v_evidence_settings_resolution_id,
          'artifact_ids', v_artifact_ids
        )),
        p_decision_reason := 'shipment_action already exists for task_event_id',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'shipment_id', v_ship.shipment_id,
        'status', 'skipped',
        'reason', 'duplicate_task_event'
      ));
      v_resp.context_patch := jsonb_build_object(
        v_context_key,
        jsonb_strip_nulls(jsonb_build_object(
          'shipment_id', v_ship.shipment_id,
          'applied', FALSE,
          'reason', 'duplicate_task_event'
        ))
      );
      RETURN v_resp;
    END IF;
  END IF;

  -- Apply status update.
  UPDATE public.shipments
     SET status = v_new_status,
         status_updated_at = COALESCE(v_event_created_at, now()),
         updated_at = now()
   WHERE id = v_ship.shipment_id
     AND client_id = v_stop.client_id;

  -- Insert shipment action and capture id for evidence links.
  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_user_id,
    performed_by_system,
    action_data,
    timestamp
  ) VALUES (
    v_ship.shipment_id,
    v_stop.organization_id,
    v_stop.client_id,
    v_action_type,
    v_action_category,
    v_new_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'workflow_engine'),
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_stop.route_run_id,
      'route_stop_id', v_route_stop_id,
      'stop_kind', v_stop_kind,
      'task_id', v_task_id,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id,
      'workflow_run_id', p_run.id,
      'settings_resolution_id', v_settings_resolution_id,
      'evidence_settings_resolution_id', v_evidence_settings_resolution_id,
      'artifact_ids', v_artifact_ids,
      'task_event_payload', v_task_event_payload
    )),
    COALESCE(v_event_created_at, now())
  )
  RETURNING id INTO v_action_id;

  -- Link artifacts to shipment_action (policy-driven, org-safe).
  IF v_artifact_ids IS NOT NULL THEN
    v_expected := array_length(v_artifact_ids, 1);

    SELECT COUNT(*)::int
      INTO v_found
      FROM public.artifacts a
     WHERE a.organization_id = v_stop.organization_id
       AND a.id = ANY (v_artifact_ids);

    IF v_found <> v_expected AND v_invalid_behavior = 'hard_fail' THEN
      RAISE EXCEPTION 'route_stop_finalize: invalid artifact_ids (expected %, found %) for org %', v_expected, v_found, v_stop.organization_id
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.artifact_links (
      organization_id,
      artifact_id,
      resource_type,
      resource_id,
      relation_type,
      metadata
    )
    SELECT
      v_stop.organization_id,
      a.id,
      'shipment_action',
      v_action_id,
      v_relation_type,
      jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_ship.shipment_id,
        'route_stop_id', v_route_stop_id,
        'task_event_id', v_task_event_id,
        'workflow_run_id', p_run.id
      ))
    FROM public.artifacts a
    WHERE a.organization_id = v_stop.organization_id
      AND a.id = ANY (v_artifact_ids)
    ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type)
    DO NOTHING;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_stop.organization_id,
    p_decision_category := 'dispatch',
    p_resource_type := 'shipment',
    p_resource_id := v_ship.shipment_id,
    p_decision_point := 'route_stop_finalize',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'dispatch_route_stop_finalize_v2',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_ship.shipment_status,
      'new_status', v_new_status,
      'route_stop_id', v_route_stop_id,
      'stop_kind', v_stop_kind,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id,
      'shipment_action_id', v_action_id,
      'evidence_settings_resolution_id', v_evidence_settings_resolution_id,
      'artifact_ids', v_artifact_ids,
      'artifact_relation_type', v_relation_type,
      'artifact_invalid_behavior', v_invalid_behavior
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'route_stop_id', v_route_stop_id,
    'shipment_id', v_ship.shipment_id,
    'applied', TRUE,
    'shipment_status', v_new_status,
    'shipment_action_id', v_action_id,
    'artifact_ids', v_artifact_ids
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_ship.shipment_id,
      'applied', TRUE,
      'shipment_status', v_new_status,
      'shipment_action_id', v_action_id
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Operation handler registry: route_stop_finalize -> v2
-------------------------------------------------------------------------------

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v2',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v2',
  TRUE,
  'Finalize a dispatch route_stop execution: update shipment status + emit shipment_actions; link evidence artifacts (policy-driven; idempotent by task_event_id).',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

-------------------------------------------------------------------------------
-- 6) Update workflow template step to use handler_version=v2 (idempotent)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_stop_finalize_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
     SET handler_version = 'v2',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601241200_dispatch_evidence_artifacts_v1'));
COMMIT;
