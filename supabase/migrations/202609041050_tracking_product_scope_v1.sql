-- Bind public-tracking review, shipment offering lineage, and branch-zone catalog reads
-- to the same canonical tenant and coverage scope.
BEGIN;

SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609041050_tracking_product_scope_v1'));

-- Historical active rows with proven static contradictions must not survive the stricter guard.
UPDATE public.service_offerings so
   SET is_active = FALSE,
       updated_at = public.workflow_now()
  FROM public.service_levels sl,
       public.branches branch
 WHERE so.is_active IS TRUE
   AND sl.id = so.service_level_id
   AND branch.id = so.branch_id
   AND (
     sl.organization_id IS DISTINCT FROM branch.organization_id
     OR branch.is_active IS DISTINCT FROM TRUE
     OR (
       so.zone_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.zones zone
          WHERE zone.id = so.zone_id
            AND zone.organization_id = sl.organization_id
            AND zone.is_active IS TRUE
            AND EXISTS (
              SELECT 1
                FROM public.branch_zones baseline
               WHERE baseline.zone_id = zone.id
                 AND baseline.branch_id = branch.id
            )
       )
     )
   );

CREATE OR REPLACE FUNCTION public.public_tracking_assert_reviewer_v1()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := NULL;
BEGIN
  IF public.request_role_is_service_v1() THEN
    RETURN NULL;
  END IF;

  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'customer shipment change review requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('customer_shipment_changes', 'write') THEN
    RAISE EXCEPTION 'customer shipment change review requires customer_shipment_changes.write capability'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_review_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_support_case_id UUID := NULL;
  v_decision TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_input->>'decision', '')), ''), ''));
  v_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reason', '')), '');
  v_user_id UUID := NULL;
  v_case RECORD;
  v_policy JSONB;
  v_result JSONB := '{}'::jsonb;
  v_current_snapshot JSONB := '{}'::jsonb;
  v_is_service BOOLEAN := public.request_role_is_service_v1();
BEGIN
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  v_user_id := public.public_tracking_assert_reviewer_v1();

  IF v_support_case_id IS NULL OR v_decision NOT IN ('approve', 'approved', 'reject', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  IF v_decision = 'approve' THEN
    v_decision := 'approved';
  ELSIF v_decision = 'reject' THEN
    v_decision := 'rejected';
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.client_id,
    sc.sender_id,
    sc.resource_id,
    sc.status,
    sc.status_reason,
    sc.version,
    sc.request_source,
    sc.request_type_key,
    sc.metadata
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = v_support_case_id
  FOR UPDATE;

  IF v_case.id IS NULL OR v_case.request_source <> 'public_tracking' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF NOT v_is_service
     AND NOT public.workflow_template_scope_allowed(
       CASE
         WHEN v_case.sender_id IS NOT NULL THEN 'sender'
         WHEN v_case.client_id IS NOT NULL THEN 'client'
         ELSE 'tenant'
       END,
       COALESCE(v_case.sender_id, v_case.client_id, v_case.organization_id)
     ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_case.status = 'resolved' THEN
    v_current_snapshot := COALESCE(
      v_case.metadata->'current_snapshot',
      public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id),
      '{}'::jsonb
    );

    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', COALESCE(v_case.metadata->>'request_outcome', CASE WHEN v_case.status_reason = 'applied' THEN 'applied' ELSE 'rejected' END),
      'already_processed', TRUE,
      'current_snapshot', v_current_snapshot
    );
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_case.organization_id,
    'client_id', v_case.client_id,
    'sender_id', v_case.sender_id
  ));

  IF v_decision = 'approved' THEN
    v_result := public.public_tracking_apply_support_case_v1(
      jsonb_build_object(
        'support_case_id', v_case.id,
        'actor_user_id', v_user_id,
        'actor_system', 'console.customer_shipment_changes'
      )
    );

    IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      v_current_snapshot := COALESCE(
        v_result->'current_snapshot',
        public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id),
        '{}'::jsonb
      );

      UPDATE public.support_cases
         SET status = 'open',
             status_reason = 'apply_failed_pending_review',
             version = version + 1,
             metadata = public.deep_merge_jsonb(
               metadata,
               jsonb_strip_nulls(
                 jsonb_build_object(
                   'request_outcome', 'pending_review',
                   'last_apply_error', v_result->'error',
                   'current_snapshot', v_current_snapshot,
                   'review_reason', v_reason
                 )
               )
             ),
             updated_at = workflow_now()
       WHERE id = v_case.id
       RETURNING version, metadata INTO v_case.version, v_case.metadata;

      INSERT INTO public.support_case_events (
        support_case_id,
        organization_id,
        event_type,
        from_status,
        to_status,
        actor_user_id,
        actor_system,
        payload,
        idempotency_key,
        case_version,
        created_at
      )
      VALUES (
        v_case.id,
        v_case.organization_id,
        'apply_failed',
        v_case.status,
        'open',
        v_user_id,
        'console.customer_shipment_changes',
        public.public_tracking_event_payload_v1(
          v_case.request_type_key,
          COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
          COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
          jsonb_strip_nulls(
            jsonb_build_object(
              'apply_outcome', 'failed',
              'failure_reason', COALESCE(v_result #>> ARRAY['error','code'], 'apply_failed'),
              'current_snapshot', v_current_snapshot,
              'reason', v_reason
            )
          )
        ),
        format('customer-shipment-change:review-apply-failed:%s:%s', v_case.id, v_case.version),
        v_case.version,
        workflow_now()
      );

      RETURN v_result;
    END IF;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', 'applied',
      'current_snapshot', v_result->'current_snapshot'
    );
  END IF;

  v_current_snapshot := public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id);

  UPDATE public.support_cases
     SET status = 'resolved',
         status_reason = 'rejected',
         resolved_at = workflow_now(),
         version = version + 1,
         metadata = public.deep_merge_jsonb(
           metadata,
           jsonb_strip_nulls(
             jsonb_build_object(
               'request_outcome', 'rejected',
               'current_snapshot', v_current_snapshot,
               'review_reason', v_reason
             )
           )
         ),
         updated_at = workflow_now()
   WHERE id = v_case.id
   RETURNING version, metadata INTO v_case.version, v_case.metadata;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case.id,
    v_case.organization_id,
    'rejected',
    v_case.status,
    'resolved',
    v_user_id,
    'console.customer_shipment_changes',
    public.public_tracking_event_payload_v1(
      v_case.request_type_key,
      COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
      COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
      jsonb_strip_nulls(
        jsonb_build_object(
          'reason', v_reason,
          'current_snapshot', v_current_snapshot,
          'request_outcome', 'rejected'
        )
      )
    ),
    format('customer-shipment-change:review-rejected:%s:%s', v_case.id, v_case.version),
    v_case.version,
    workflow_now()
  );

  PERFORM public.public_tracking_emit_support_message_v1(
    v_case.id,
    v_case.organization_id,
    'internal',
    'internal',
    'console.customer_shipment_changes',
    COALESCE(v_reason, format('Customer shipment change rejected (%s).', v_case.request_type_key)),
    jsonb_build_object('request_outcome', 'rejected')
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_rejected'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case.id,
      v_case.organization_id,
      NULLIF(v_case.metadata->>'recipient_id', '')::UUID,
      'rejected',
      format('Your %s request was rejected.', replace(v_case.request_type_key, '_', ' ')),
      jsonb_strip_nulls(jsonb_build_object('reason', v_reason))
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case.id,
    'outcome', 'rejected',
    'current_snapshot', v_current_snapshot
  );
END;
$function$;

COMMENT ON FUNCTION public.public_tracking_assert_reviewer_v1()
  IS 'Require the canonical customer_shipment_changes.write capability for non-service tracking reviewers.';
COMMENT ON FUNCTION public.public_tracking_review_request_v1(JSONB)
  IS 'Review a public-tracking request only within the deepest sender, client, or tenant scope and return canonical readback.';

CREATE OR REPLACE FUNCTION public.service_offerings_validate_catalog_context_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_organization_id UUID;
BEGIN
  IF NEW.is_active IS DISTINCT FROM TRUE THEN
    RETURN NEW;
  END IF;

  SELECT sl.organization_id
    INTO v_organization_id
    FROM public.service_levels sl
    JOIN public.lookup_definitions ld
      ON ld.category = 'service_level'
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
     AND lv.value = sl.key
   WHERE sl.id = NEW.service_level_id
     AND sl.is_active IS TRUE
     AND lv.status = 'active'
     AND lv.retired_at IS NULL
     AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
     AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active service offering requires an active canonical service_level lookup value'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.branches branch
   WHERE branch.id = NEW.branch_id
     AND branch.organization_id = v_organization_id
     AND branch.is_active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active service offering requires an active organization-matched branch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.zone_id IS NOT NULL THEN
    PERFORM 1
      FROM public.zones zone
     WHERE zone.id = NEW.zone_id
       AND zone.organization_id = v_organization_id
       AND zone.is_active IS TRUE
       AND public.resolve_branch_id_for_zone_at(zone.id, public.workflow_now()) = NEW.branch_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active service offering zone must be active and currently mapped to its branch'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_service_offerings_validate_catalog_context_v1 ON public.service_offerings;
CREATE TRIGGER trg_service_offerings_validate_catalog_context_v1
  BEFORE INSERT OR UPDATE OF service_level_id, branch_id, zone_id, is_active
  ON public.service_offerings
  FOR EACH ROW
  EXECUTE FUNCTION public.service_offerings_validate_catalog_context_v1();

CREATE OR REPLACE FUNCTION public.resolve_service_offering_context_v1(
  p_organization_id UUID,
  p_service_offering_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_context JSONB;
BEGIN
  IF p_organization_id IS NULL OR p_service_offering_id IS NULL THEN
    RAISE EXCEPTION 'resolve_service_offering_context_v1 requires organization_id and service_offering_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
           'service_offering_id', so.id,
           'service_level_id', sl.id,
           'service_level_key', sl.key,
           'service_level_name', sl.name,
           'service_offering_branch_id', so.branch_id,
           'service_offering_zone_id', so.zone_id,
           'service_offering_display_name', NULLIF(btrim(so.metadata#>>'{display,name}'), '')
         ))
    INTO v_context
    FROM public.service_offerings so
    JOIN public.service_levels sl ON sl.id = so.service_level_id
    JOIN public.branches branch ON branch.id = so.branch_id
    LEFT JOIN public.zones zone ON zone.id = so.zone_id
    JOIN public.lookup_definitions ld ON ld.category = 'service_level'
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
     AND lv.value = sl.key
   WHERE so.id = p_service_offering_id
     AND sl.organization_id = p_organization_id
     AND branch.organization_id = p_organization_id
     AND (zone.id IS NULL OR zone.organization_id = p_organization_id)
     AND sl.is_active IS TRUE
     AND so.is_active IS TRUE
     AND branch.is_active IS TRUE
     AND (zone.id IS NULL OR zone.is_active IS TRUE)
     AND (
       zone.id IS NULL
       OR public.resolve_branch_id_for_zone_at(zone.id, public.workflow_now()) = branch.id
     )
     AND lv.status = 'active'
     AND lv.retired_at IS NULL
     AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
     AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now())
     AND public.workflow_now() >= so.effective_from
     AND (so.effective_to IS NULL OR public.workflow_now() < so.effective_to)
   LIMIT 1;

  IF v_context IS NULL THEN
    RAISE EXCEPTION 'service offering % is unavailable for organization %',
      p_service_offering_id,
      p_organization_id
      USING ERRCODE = '23503';
  END IF;

  RETURN v_context;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.shipments_apply_service_offering_context_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_offering_text TEXT := NULLIF(btrim(COALESCE(NEW.metadata->>'service_offering_id', '')), '');
  v_previous_offering_text TEXT;
  v_offering_id UUID;
  v_context JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_previous_offering_text := NULLIF(btrim(COALESCE(OLD.metadata->>'service_offering_id', '')), '');
  END IF;

  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
    - 'service_level_id'
    - 'service_level_key'
    - 'service_level_name'
    - 'service_offering_branch_id'
    - 'service_offering_zone_id'
    - 'service_offering_display_name';

  IF v_offering_text IS NULL THEN
    NEW.metadata := NEW.metadata - 'service_offering_id';
    IF TG_OP = 'UPDATE' AND v_previous_offering_text IS NOT NULL THEN
      IF OLD.metadata ? 'service_level_key'
         AND NEW.service_level IS NOT DISTINCT FROM OLD.service_level THEN
        NEW.service_level := NULL;
      END IF;
      IF OLD.metadata ? 'service_offering_branch_id'
         AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id THEN
        NEW.branch_id := NULL;
      END IF;
      IF OLD.metadata ? 'service_offering_zone_id'
         AND NEW.zone_id IS NOT DISTINCT FROM OLD.zone_id THEN
        NEW.zone_id := NULL;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  BEGIN
    v_offering_id := v_offering_text::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'shipments.metadata.service_offering_id must be a uuid'
        USING ERRCODE = '22P02';
  END;

  v_context := public.resolve_service_offering_context_v1(NEW.organization_id, v_offering_id);

  NEW.service_level := v_context->>'service_level_key';
  NEW.branch_id := NULLIF(v_context->>'service_offering_branch_id', '')::UUID;
  NEW.zone_id := NULLIF(v_context->>'service_offering_zone_id', '')::UUID;
  NEW.metadata := jsonb_strip_nulls(NEW.metadata || v_context);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_00_shipments_apply_service_offering_context_v1 ON public.shipments;
CREATE TRIGGER trg_00_shipments_apply_service_offering_context_v1
  BEFORE INSERT OR UPDATE OF organization_id, metadata, service_level, branch_id, zone_id
  ON public.shipments
  FOR EACH ROW
  EXECUTE FUNCTION public.shipments_apply_service_offering_context_v1();

CREATE OR REPLACE VIEW public.service_offering_directory
  WITH (security_invoker = true)
AS
SELECT
  so.id,
  sl.organization_id,
  so.service_level_id,
  sl.key AS service_level_key,
  sl.name AS service_level_name,
  so.branch_id,
  branch.name AS branch_name,
  so.zone_id,
  zone.name AS zone_name,
  so.effective_from,
  so.effective_to,
  so.priority,
  so.is_active,
  so.metadata,
  COALESCE(
    NULLIF(btrim(so.metadata#>>'{display,name}'), ''),
    concat_ws(' - ', sl.name, branch.name, zone.name)
  ) AS display_name,
  (
    sl.is_active IS TRUE
    AND so.is_active IS TRUE
    AND branch.organization_id = sl.organization_id
    AND branch.is_active IS TRUE
    AND (zone.id IS NULL OR zone.organization_id = sl.organization_id)
    AND (zone.id IS NULL OR zone.is_active IS TRUE)
    AND (
      zone.id IS NULL
      OR public.resolve_branch_id_for_zone_at(zone.id, public.workflow_now()) = branch.id
    )
    AND EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'service_level'
         AND lv.value = sl.key
         AND lv.status = 'active'
         AND lv.retired_at IS NULL
         AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
         AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now())
    )
    AND public.workflow_now() >= so.effective_from
    AND (so.effective_to IS NULL OR public.workflow_now() < so.effective_to)
  ) AS is_available,
  so.created_at,
  so.updated_at
FROM public.service_offerings so
JOIN public.service_levels sl ON sl.id = so.service_level_id
JOIN public.branches branch ON branch.id = so.branch_id
LEFT JOIN public.zones zone ON zone.id = so.zone_id
WHERE public.request_role_is_service_v1()
   OR public.is_platform_user()
   OR sl.organization_id = public.current_user_org_id();

CREATE OR REPLACE VIEW api.service_branch_zone_directory
WITH (security_invoker = true) AS
SELECT
  zone.id,
  zone.organization_id,
  zone.name,
  coverage.branch_id
FROM public.zones zone
CROSS JOIN LATERAL (
  SELECT public.resolve_branch_id_for_zone_at(zone.id, public.workflow_now()) AS branch_id
) coverage
JOIN public.branches branch
  ON branch.id = coverage.branch_id
 AND branch.organization_id = zone.organization_id
 AND branch.is_active IS TRUE
WHERE zone.is_active IS TRUE
  AND (
    public.request_role_is_service_v1()
    OR public.is_platform_user()
    OR zone.organization_id = public.current_user_org_id()
  );

REVOKE ALL ON api.service_branch_zone_directory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON api.service_branch_zone_directory TO service_role;

DO $registry$
DECLARE
  v_row RECORD;
  v_resource CONSTANT JSONB := jsonb_build_object(
    'key', 'service_branch_zone_directory',
    'label', 'Service branch zones',
    'relation', 'api.service_branch_zone_directory',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'agreements.read',
    'capability_write', 'agreements.write',
    'select', jsonb_build_array('id', 'organization_id', 'name', 'branch_id'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc'),
    'allow_view_relation', TRUE,
    'strict_columns', TRUE
  );
  v_version_resources JSONB;
  v_version_next JSONB;
  v_pairs_seen INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, s.category,
           s.scope_type, s.scope_id, s.scope_hash, s.cached_value,
           sv.schema_version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_read_registry'
  LOOP
    IF jsonb_typeof(v_row.value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_row.cached_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_row.cached_value->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry settings pair %/% has invalid resources',
        v_row.settings_id, v_row.settings_version_id;
    END IF;

    v_pairs_seen := v_pairs_seen + 1;
    SELECT COALESCE(
      jsonb_agg(resource ORDER BY ordinality)
        FILTER (WHERE resource->>'key' IS DISTINCT FROM 'service_branch_zone_directory'),
      '[]'::jsonb
    ) || jsonb_build_array(v_resource)
      INTO v_version_resources
      FROM jsonb_array_elements(v_row.value->'resources')
           WITH ORDINALITY AS entries(resource, ordinality);
    v_version_next := jsonb_set(v_row.value, '{resources}', v_version_resources, TRUE);

    IF v_row.value IS DISTINCT FROM v_version_next THEN
      WITH closed AS (
        UPDATE public.settings_versions
           SET effective_until = GREATEST(
                 clock_timestamp(),
                 effective_from + INTERVAL '1 microsecond'
               ),
               updated_at = clock_timestamp()
         WHERE id = v_row.settings_version_id
           AND scope_hash = v_row.scope_hash
           AND effective_until IS NULL
        RETURNING id
      ), inserted AS (
        INSERT INTO public.settings_versions (
          id, category, scope_type, scope_id, scope_hash, version, value,
          schema_version, change_reason, approved_at, effective_from
        )
        SELECT
          gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id,
          v_row.scope_hash,
          (
            SELECT COALESCE(MAX(candidate.version), 0) + 1
              FROM public.settings_versions candidate
             WHERE candidate.category = v_row.category
               AND candidate.scope_type = v_row.scope_type
               AND candidate.scope_hash = v_row.scope_hash
          ),
          v_version_next, v_row.schema_version,
          'Register the governed effective branch-zone service directory',
          clock_timestamp(), clock_timestamp()
          FROM closed
        RETURNING id, value
      )
      UPDATE public.settings s
         SET settings_version_id = inserted.id,
             cached_value = inserted.value,
             last_updated = clock_timestamp()
        FROM inserted
       WHERE s.id = v_row.settings_id
         AND s.settings_version_id = v_row.settings_version_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'failed to promote ui_read_registry settings pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    ELSIF v_row.cached_value IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings
         SET cached_value = v_row.value,
             last_updated = clock_timestamp()
       WHERE id = v_row.settings_id
         AND settings_version_id = v_row.settings_version_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'settings cache repair lost pointer CAS for pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    END IF;
  END LOOP;

  IF v_pairs_seen = 0 THEN
    RAISE EXCEPTION 'ui_read_registry settings pairs are missing';
  END IF;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%service_branch_zone_directory%'
      OR cache_key LIKE 'ui_get_resource:%service_branch_zone_directory%'
      OR cache_key LIKE 'ui_resource_metrics:%service_branch_zone_directory%'
      OR cache_key LIKE 'ui_filter_distinct_values:%service_branch_zone_directory%';
END;
$registry$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'api'
       AND c.relname = 'service_branch_zone_directory'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'api.service_branch_zone_directory must remain a security_invoker view';
  END IF;

  IF (
    SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)
      FROM information_schema.columns
     WHERE table_schema = 'api'
       AND table_name = 'service_branch_zone_directory'
  ) IS DISTINCT FROM ARRAY['id', 'organization_id', 'name', 'branch_id']::TEXT[] THEN
    RAISE EXCEPTION 'api.service_branch_zone_directory column identity drifted';
  END IF;

  IF has_table_privilege('anon', 'api.service_branch_zone_directory', 'SELECT')
     OR has_table_privilege('authenticated', 'api.service_branch_zone_directory', 'SELECT')
     OR NOT has_table_privilege('service_role', 'api.service_branch_zone_directory', 'SELECT') THEN
    RAISE EXCEPTION 'api.service_branch_zone_directory privilege boundary drifted';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS count, (jsonb_agg(resource ORDER BY ordinality)->0) AS resource
          FROM jsonb_array_elements(sv.value->'resources')
               WITH ORDINALITY AS entries(resource, ordinality)
         WHERE resource->>'key' = 'service_branch_zone_directory'
      ) version_entry
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS count, (jsonb_agg(resource ORDER BY ordinality)->0) AS resource
          FROM jsonb_array_elements(s.cached_value->'resources')
               WITH ORDINALITY AS entries(resource, ordinality)
         WHERE resource->>'key' = 'service_branch_zone_directory'
      ) cache_entry
     WHERE s.category = 'ui_read_registry'
       AND (
         version_entry.count <> 1
         OR cache_entry.count <> 1
         OR version_entry.resource IS DISTINCT FROM cache_entry.resource
         OR version_entry.resource->>'relation' IS DISTINCT FROM 'api.service_branch_zone_directory'
         OR version_entry.resource->'select' IS DISTINCT FROM '["id","organization_id","name","branch_id"]'::jsonb
         OR version_entry.resource->>'capability_read' IS DISTINCT FROM 'agreements.read'
         OR version_entry.resource->>'allow_view_relation' IS DISTINCT FROM 'true'
         OR version_entry.resource->>'strict_columns' IS DISTINCT FROM 'true'
       )
  ) THEN
    RAISE EXCEPTION 'service_branch_zone_directory registry settings/cache parity drifted';
  END IF;
END;
$assert$;

COMMIT;
