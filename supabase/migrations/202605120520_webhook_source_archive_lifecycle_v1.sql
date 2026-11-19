-- Console V2 webhook source archive lifecycle.
--
-- Source archive is a soft lifecycle action: preserve the source row and all
-- inbox/rule history, fail closed for intake by setting enabled=false, and keep
-- archive lineage in managed_metadata plus decision/domain ledgers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120520_webhook_source_archive_lifecycle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.webhook_sources
  ADD COLUMN IF NOT EXISTS managed_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.webhook_source_metadata_is_archived_v1(p_metadata jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE($1->>'lifecycle', '') = 'archived'
      OR NULLIF($1->>'archived_at', '') IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_archived_webhook_source_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_bypass BOOLEAN := COALESCE(current_setting('app.webhook_source_archive_bypass', true), '') = 'on';
BEGIN
  IF v_bypass THEN
    RETURN NEW;
  END IF;

  IF public.webhook_source_metadata_is_archived_v1(COALESCE(OLD.managed_metadata, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'archived webhook source % cannot be mutated; use an explicit restore lifecycle', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF public.webhook_source_metadata_is_archived_v1(COALESCE(NEW.managed_metadata, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'webhook source archive lifecycle must use ui_archive_webhook_source_v1'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_archive_webhook_source_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_source_id UUID := NULLIF(p_args->>'source_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_before public.webhook_sources%ROWTYPE;
  v_archived_at TIMESTAMPTZ;
  v_already_archived BOOLEAN := FALSE;
  v_archive_reason TEXT;
  v_archived_by TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_archive_webhook_source_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_source_id IS NULL THEN
    RAISE EXCEPTION 'ui_archive_webhook_source_v1 requires source_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ui_archive_webhook_source_v1 requires reason'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before
    FROM public.webhook_sources
   WHERE id = v_source_id
   FOR UPDATE;

  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_archive_webhook_source_v1 webhook_source % not found', v_source_id
      USING ERRCODE = '23503';
  END IF;

  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_archive_webhook_source_v1 webhook_source % outside tenant scope', v_source_id
      USING ERRCODE = '42501';
  END IF;

  v_already_archived := public.webhook_source_metadata_is_archived_v1(COALESCE(v_before.managed_metadata, '{}'::jsonb));

  v_archived_at := COALESCE(NULLIF(v_before.managed_metadata->>'archived_at', '')::timestamptz, now());
  v_archive_reason := COALESCE(NULLIF(v_before.managed_metadata->>'archive_reason', ''), v_reason);
  v_archived_by := COALESCE(NULLIF(v_before.managed_metadata->>'archived_by', ''), v_user_id::text);

  PERFORM set_config('app.webhook_source_archive_bypass', 'on', true);
  UPDATE public.webhook_sources
     SET enabled = FALSE,
         managed_metadata = COALESCE(managed_metadata, '{}'::jsonb)
           || jsonb_build_object(
                'lifecycle', 'archived',
                'archived_at', v_archived_at,
                'archived_by', v_archived_by,
                'archive_reason', v_archive_reason
              ),
         updated_at = now()
   WHERE id = v_source_id;
  PERFORM set_config('app.webhook_source_archive_bypass', 'off', true);

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id,
    'webhook_processing', 'webhook_source', v_source_id,
    'ui_archive_webhook_source_v1',
    CASE WHEN v_already_archived THEN 'already_archived' ELSE 'archived' END,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', v_before.source_identifier,
      'name', v_before.name,
      'previous_enabled', v_before.enabled,
      'reason', v_reason,
      'already_processed', v_already_archived
    )),
    'ui_archive_webhook_source_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'webhook_source.archived', 'webhook_source', v_source_id,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', v_before.source_identifier,
      'name', v_before.name,
      'previous_enabled', v_before.enabled,
      'archive_reason', v_reason,
      'already_processed', v_already_archived
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', v_source_id,
    'source_id', v_source_id,
    'enabled', FALSE,
    'action', CASE WHEN v_already_archived THEN 'already_archived' ELSE 'archived' END,
    'already_processed', v_already_archived,
    'archived_at', v_archived_at,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

DROP TRIGGER IF EXISTS webhook_sources_prevent_archived_mutation_v1 ON public.webhook_sources;
CREATE TRIGGER webhook_sources_prevent_archived_mutation_v1
  BEFORE UPDATE ON public.webhook_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_archived_webhook_source_mutation_v1();

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_archive_webhook_source_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_archive_webhook_source_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.ui_archive_webhook_source_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_archive_webhook_source_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_archive_webhook_source_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_archive_webhook_source_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_archive_webhook_source_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_archive_webhook_source_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_archive_webhook_source_v1(jsonb)
  IS 'Console V2 canonical webhook source archive RPC. Soft-archives by setting webhook_sources.enabled=false and writing archive metadata, decision_log, and domain_events. Capability: webhooks.write.';
COMMENT ON FUNCTION api.ui_archive_webhook_source_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.ui_archive_webhook_source_v1(jsonb).';

CREATE OR REPLACE VIEW public.v_webhook_source_directory
  WITH (security_invoker = true)
  AS
SELECT
  ws.id,
  ws.organization_id,
  ws.source_identifier,
  ws.name,
  ws.provider_type,
  ws.mapping_config_id,
  ws.rate_limit_per_hour,
  ws.enabled,
  ws.created_at,
  ws.updated_at,
  mc.mapping_key AS mapping_label,
  inbox_agg.last_event_at,
  inbox_agg.last_event_status,
  COALESCE(inbox_agg.event_count_24h, 0) AS event_count_24h,
  COALESCE(inbox_agg.error_count_24h, 0) AS error_count_24h,
  COALESCE(rule_agg.rule_count, 0) AS rule_count,
  COALESCE(rule_agg.active_rule_count, 0) AS active_rule_count,
  (ws.enabled = TRUE AND COALESCE(inbox_agg.error_count_24h, 0) = 0) AS is_healthy,
  (COALESCE(inbox_agg.error_count_24h, 0) > 0) AS has_recent_errors,
  CASE
    WHEN ws.auth_token IS NOT NULL THEN 'stored'
    WHEN ws.auth_token_hash IS NOT NULL THEN 'stored'
    ELSE NULL
  END AS auth_token_masked,
  ws.sender_id,
  snd.client_id,
  snd.name AS sender_label,
  c.name AS client_label,
  COALESCE((source_policy.cached_value#>>'{validation,hmac,enabled}')::boolean, FALSE) AS hmac_enabled,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,header}', '') AS hmac_header,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,algorithm}', '') AS hmac_algorithm,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,signature_encoding}', '') AS hmac_signature_encoding,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,auth_config_id}', '')::uuid AS hmac_auth_config_id,
  NULLIF(ws.managed_metadata->>'lifecycle', '') AS lifecycle_state,
  NULLIF(ws.managed_metadata->>'archived_at', '') AS archived_at,
  NULLIF(ws.managed_metadata->>'archived_by', '') AS archived_by,
  NULLIF(ws.managed_metadata->>'archive_reason', '') AS archive_reason,
  ws.managed_metadata
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.senders snd ON snd.id = ws.sender_id
LEFT JOIN public.clients c ON c.id = snd.client_id
LEFT JOIN public.settings source_policy
  ON source_policy.category = 'webhook_ingest_policy'
 AND source_policy.scope_type = 'source'
 AND source_policy.scope_id = ws.id
LEFT JOIN LATERAL (
  SELECT
    max(wi.created_at) AS last_event_at,
    (
      SELECT wi2.processing_status
      FROM public.webhook_inbox wi2
      WHERE wi2.webhook_source_id = ws.id
      ORDER BY wi2.created_at DESC
      LIMIT 1
    ) AS last_event_status,
    count(*) FILTER (WHERE wi.created_at > (now() - INTERVAL '24 hours')) AS event_count_24h,
    count(*) FILTER (
      WHERE wi.created_at > (now() - INTERVAL '24 hours')
        AND wi.processing_status IN ('failed', 'dead_letter')
    ) AS error_count_24h
  FROM public.webhook_inbox wi
  WHERE wi.webhook_source_id = ws.id
) inbox_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT
    count(*) AS rule_count,
    count(*) FILTER (WHERE wr.enabled = TRUE) AS active_rule_count
  FROM public.webhook_rules wr
  WHERE wr.webhook_source_id = ws.id
) rule_agg ON TRUE;

GRANT SELECT ON public.v_webhook_source_directory TO authenticated, service_role;

COMMENT ON VIEW public.v_webhook_source_directory
  IS 'FE-friendly webhook source projection with sender/client binding, source health, token redaction, HMAC policy state, and archive lifecycle metadata. Mutations go through ui_upsert_webhook_source_v1 / ui_rotate_webhook_source_token_v1 / ui_archive_webhook_source_v1.';

DO $commands$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_commands JSONB;
  v_next_commands JSONB;
  v_next JSONB;
  v_archive_command JSONB := jsonb_build_object(
    'key', 'webhooks.archive_source',
    'label', 'Archive webhook source',
    'section', 'Integrations',
    'execution', 'rpc',
    'target', 'ui_archive_webhook_source_v1',
    'capability', 'webhooks.write',
    'route_targets', jsonb_build_object('console', jsonb_build_object('path', '/integrations/sources'))
  );
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN item.value->>'key' = 'webhooks.archive_source' THEN v_archive_command
        ELSE item.value
      END
      ORDER BY item.ordinality
    ), '[]'::jsonb)
      INTO v_next_commands
      FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS item(value, ordinality);

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_next_commands) AS item(value)
       WHERE item.value->>'key' = 'webhooks.archive_source'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_archive_command);
    END IF;

    v_next := jsonb_set(v_current, '{commands}', v_next_commands, true);
    IF v_next IS NOT DISTINCT FROM v_current THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_row.version + 1,
           change_reason = 'Add Console V2 webhook source archive command',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.settings_id;
  END LOOP;
END;
$commands$;

SELECT pg_advisory_unlock(hashtext('202605120520_webhook_source_archive_lifecycle_v1'));
COMMIT;
