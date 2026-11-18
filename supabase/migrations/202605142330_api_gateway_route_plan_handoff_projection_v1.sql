-- Console V2 first-tenant readiness: API Gateway shipment-create materialization
-- must carry enough row-driven planning truth for downstream route planning when
-- the provider/API payload supplies a promise date and a mapped service level.

SELECT pg_advisory_lock(hashtext('202605142330_api_gateway_route_plan_handoff_projection_v1'));

CREATE OR REPLACE FUNCTION public.resolve_api_gateway_shipment_service_offering_v1(
  p_organization_id uuid,
  p_source_id uuid,
  p_service_level_key text,
  p_request_body jsonb,
  p_policy jsonb,
  p_job_context jsonb
)
RETURNS TABLE (
  service_offering_id uuid,
  service_level_id uuid,
  service_level_key text,
  branch_id uuid,
  zone_id uuid,
  display_name text,
  resolution_source text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_policy jsonb := COALESCE(p_policy, '{}'::jsonb);
  v_post jsonb := COALESCE(v_policy->'postprocess', '{}'::jsonb);
  v_extract jsonb := COALESCE(v_post->'extract', '{}'::jsonb);
  v_candidate_text text;
  v_candidate_id uuid;
  v_count int;
  v_level_key text := lower(NULLIF(btrim(COALESCE(p_service_level_key, '')), ''));
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN;
  END IF;

  v_candidate_text := COALESCE(
    NULLIF(p_job_context #>> '{api_gateway_materialized,service_offering_id}', ''),
    NULLIF(workflow_handlers.resolve_path_text(COALESCE(p_request_body, '{}'::jsonb), v_extract->>'service_offering_id_path'), ''),
    NULLIF(v_post->>'service_offering_id', '')
  );

  IF v_candidate_text IS NULL AND p_source_id IS NOT NULL THEN
    SELECT COALESCE(
             NULLIF(ws.managed_metadata #>> '{defaults,service_offering_id}', ''),
             NULLIF(ws.managed_metadata->>'service_offering_id', '')
           )
      INTO v_candidate_text
      FROM public.webhook_sources ws
     WHERE ws.id = p_source_id
       AND ws.organization_id = p_organization_id
     LIMIT 1;
  END IF;

  IF v_candidate_text IS NOT NULL THEN
    BEGIN
      v_candidate_id := v_candidate_text::uuid;
    EXCEPTION WHEN others THEN
      v_candidate_id := NULL;
    END;

    IF v_candidate_id IS NOT NULL THEN
      RETURN QUERY
      SELECT
        so.id,
        sl.id,
        sl.key,
        so.branch_id,
        so.zone_id,
        so.metadata->'display'->>'name',
        'explicit_service_offering_id'::text
      FROM public.service_offerings so
      JOIN public.service_levels sl
        ON sl.id = so.service_level_id
      JOIN public.branches b
        ON b.id = so.branch_id
      WHERE so.id = v_candidate_id
        AND sl.organization_id = p_organization_id
        AND b.organization_id = p_organization_id
        AND so.is_active IS TRUE
        AND sl.is_active IS TRUE
        AND b.is_active IS TRUE
        AND now() >= so.effective_from
        AND (so.effective_to IS NULL OR now() < so.effective_to)
        AND lower(COALESCE(sl.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
        AND lower(COALESCE(so.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
      LIMIT 1;

      IF FOUND THEN
        RETURN;
      END IF;
    END IF;
  END IF;

  WITH eligible AS (
    SELECT so.id
    FROM public.service_offerings so
    JOIN public.service_levels sl
      ON sl.id = so.service_level_id
    JOIN public.branches b
      ON b.id = so.branch_id
    WHERE sl.organization_id = p_organization_id
      AND b.organization_id = p_organization_id
      AND so.is_active IS TRUE
      AND sl.is_active IS TRUE
      AND b.is_active IS TRUE
      AND now() >= so.effective_from
      AND (so.effective_to IS NULL OR now() < so.effective_to)
      AND lower(COALESCE(sl.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
      AND lower(COALESCE(so.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
      AND (v_level_key IS NULL OR lower(sl.key) = v_level_key)
  )
  SELECT count(*)::int, (array_agg(id ORDER BY id))[1]
    INTO v_count, v_candidate_id
    FROM eligible;

  IF COALESCE(v_count, 0) <> 1 OR v_candidate_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    so.id,
    sl.id,
    sl.key,
    so.branch_id,
    so.zone_id,
    so.metadata->'display'->>'name',
    'unique_active_service_level_offering'::text
  FROM public.service_offerings so
  JOIN public.service_levels sl
    ON sl.id = so.service_level_id
  WHERE so.id = v_candidate_id
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_api_gateway_shipment_service_offering_v1(
  uuid, uuid, text, jsonb, jsonb, jsonb
) IS
  'Resolves API Gateway shipment-create service offering from row-driven source/policy context or a unique active service-level offering; returns no row when ambiguous.';

REVOKE ALL ON FUNCTION public.resolve_api_gateway_shipment_service_offering_v1(uuid, uuid, text, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_api_gateway_shipment_service_offering_v1(uuid, uuid, text, jsonb, jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_api_gateway_shipment_service_offering_v1(uuid, uuid, text, jsonb, jsonb, jsonb) TO service_role;

DO $patch$
DECLARE
  v_def text;
  v_next text;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls,jsonb,public.api_gateway_requests,public.api_routes)'::regprocedure
  )
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 definition not found';
  END IF;

  IF position('v_service_offering_id UUID;' in v_def) = 0 THEN
    v_def := replace(
      v_def,
      E'  v_box_count INT;\n',
      E'  v_box_count INT;\n\n  v_service_offering_id UUID;\n  v_service_offering_service_level_id UUID;\n  v_service_offering_service_level_key TEXT;\n  v_service_offering_branch_id UUID;\n  v_service_offering_zone_id UUID;\n  v_service_offering_display_name TEXT;\n  v_service_offering_resolution_source TEXT;\n'
    );
  END IF;

  IF position('resolve_api_gateway_shipment_service_offering_v1' in v_def) = 0 THEN
    v_def := replace(
      v_def,
      E'  v_shipment_metadata := jsonb_strip_nulls(jsonb_build_object(\n',
      E'  SELECT resolved.service_offering_id,\n         resolved.service_level_id,\n         resolved.service_level_key,\n         resolved.branch_id,\n         resolved.zone_id,\n         resolved.display_name,\n         resolved.resolution_source\n    INTO v_service_offering_id,\n         v_service_offering_service_level_id,\n         v_service_offering_service_level_key,\n         v_service_offering_branch_id,\n         v_service_offering_zone_id,\n         v_service_offering_display_name,\n         v_service_offering_resolution_source\n    FROM public.resolve_api_gateway_shipment_service_offering_v1(\n      v_org,\n      v_source,\n      NULLIF(btrim(COALESCE(v_service_level, '''')), ''''),\n      v_request_body,\n      v_policy,\n      p_job.context\n    ) AS resolved\n   LIMIT 1;\n\n  IF v_service_offering_id IS NOT NULL THEN\n    v_service_level := COALESCE(NULLIF(btrim(COALESCE(v_service_level, '''')), ''''), v_service_offering_service_level_key);\n  END IF;\n\n  v_shipment_metadata := jsonb_strip_nulls(jsonb_build_object(\n'
    );
  END IF;

  v_def := replace(
    v_def,
    E'  v_shipment_metadata := jsonb_strip_nulls(jsonb_build_object(\n    ''source'', jsonb_strip_nulls(jsonb_build_object(\n      ''type'', ''api_gateway'',\n      ''api_gateway_request_id'', v_request.id,\n      ''route_id'', v_route.id\n    )),\n    ''provider'', jsonb_strip_nulls(jsonb_build_object(\n      ''id'', v_provider_id,\n      ''name'', v_provider_name,\n      ''shipment_id'', v_provider_shipment_id,\n      ''reference_id'', v_provider_reference_id\n    ))\n  ));',
    E'  v_shipment_metadata := jsonb_strip_nulls(jsonb_build_object(\n    ''source'', jsonb_strip_nulls(jsonb_build_object(\n      ''type'', ''api_gateway'',\n      ''api_gateway_request_id'', v_request.id,\n      ''route_id'', v_route.id\n    )),\n    ''provider'', jsonb_strip_nulls(jsonb_build_object(\n      ''id'', v_provider_id,\n      ''name'', v_provider_name,\n      ''shipment_id'', v_provider_shipment_id,\n      ''reference_id'', v_provider_reference_id\n    )),\n    ''service_offering_id'', v_service_offering_id,\n    ''service_level_id'', v_service_offering_service_level_id,\n    ''service_level_key'', COALESCE(NULLIF(btrim(COALESCE(v_service_level, '''')), ''''), v_service_offering_service_level_key),\n    ''service_offering_branch_id'', v_service_offering_branch_id,\n    ''service_offering_zone_id'', v_service_offering_zone_id,\n    ''service_offering_display_name'', v_service_offering_display_name,\n    ''promised_delivery_date'', v_promised_delivery_date,\n    ''planning'', jsonb_strip_nulls(jsonb_build_object(\n      ''service_offering_resolution_source'', v_service_offering_resolution_source\n    ))\n  ));'
  );

  v_def := replace(
    v_def,
    E'        service_level,\n        special_instructions,',
    E'        service_level,\n        branch_id,\n        zone_id,\n        special_instructions,'
  );

  v_def := replace(
    v_def,
    E'        NULLIF(btrim(v_service_level), ''''),\n        NULLIF(btrim(v_special_instructions), ''''),',
    E'        NULLIF(btrim(v_service_level), ''''),\n        v_service_offering_branch_id,\n        v_service_offering_zone_id,\n        NULLIF(btrim(v_special_instructions), ''''),'
  );

  v_def := replace(
    v_def,
    E'        service_level = COALESCE(NULLIF(public.shipments.service_level, ''''), NULLIF(btrim(v_service_level), '''')),\n        special_instructions = COALESCE(NULLIF(public.shipments.special_instructions, ''''), NULLIF(btrim(v_special_instructions), '''')),',
    E'        service_level = COALESCE(NULLIF(public.shipments.service_level, ''''), NULLIF(btrim(v_service_level), '''')),\n        branch_id = COALESCE(public.shipments.branch_id, v_service_offering_branch_id),\n        zone_id = COALESCE(public.shipments.zone_id, v_service_offering_zone_id),\n        special_instructions = COALESCE(NULLIF(public.shipments.special_instructions, ''''), NULLIF(btrim(v_special_instructions), '''')),'
  );

  v_def := replace(
    v_def,
    E'        ''cod_amount'', v_cod_amount,\n        ''operation'', v_operation,',
    E'        ''cod_amount'', v_cod_amount,\n        ''service_offering_id'', v_service_offering_id,\n        ''service_offering_branch_id'', v_service_offering_branch_id,\n        ''service_offering_zone_id'', v_service_offering_zone_id,\n        ''promised_delivery_date'', v_promised_delivery_date,\n        ''operation'', v_operation,'
  );

  IF position('v_service_offering_branch_id' in v_def) = 0
     OR position('resolve_api_gateway_shipment_service_offering_v1' in v_def) = 0 THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 route-plan handoff patch did not apply';
  END IF;

  EXECUTE v_def;

  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls,jsonb,public.api_gateway_requests,public.api_routes)'::regprocedure
  )
    INTO v_next;

  IF position('resolve_api_gateway_shipment_service_offering_v1' in v_next) = 0
     OR position('branch_id = COALESCE(public.shipments.branch_id, v_service_offering_branch_id)' in v_next) = 0 THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 route-plan handoff verification failed';
  END IF;
END;
$patch$;

COMMENT ON FUNCTION workflow_handlers.process_api_gateway_shipment_create_v1(
  public.outbound_calls,
  jsonb,
  public.api_gateway_requests,
  public.api_routes
) IS 'API Gateway shipment-create postprocessor. Materializes canonical shipment readback, service-offering planning projection for route-plan handoff, and shipment-scoped action/decision lineage for Console V2 drawer audit proof.';

SELECT pg_advisory_unlock(hashtext('202605142330_api_gateway_route_plan_handoff_projection_v1'));
