BEGIN;
SET LOCAL search_path TO public, pgtap, workflow_handlers, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

CREATE FUNCTION pg_temp.test_selected_coordinate_dispatch()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $test$
DECLARE
    v_org UUID := gen_random_uuid();
    v_client UUID := gen_random_uuid();
    v_provider UUID := gen_random_uuid();
    v_provider_name TEXT := 'geocode-test-' || v_provider::text;
    v_mapping_id UUID := gen_random_uuid();
    v_template UUID := gen_random_uuid();
    v_template_step UUID := gen_random_uuid();
    v_address UUID;
    v_run_id UUID;
    v_step_id UUID;
    v_policy JSONB;
    v_policy_version INTEGER;
    v_fallback BOOLEAN;
    v_geocoding JSONB;
    v_run public.workflow_runs%ROWTYPE;
    v_step public.workflow_run_steps%ROWTYPE;
    v_response public.workflow_handler_response;
    v_job public.outbound_calls%ROWTYPE;
BEGIN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

    PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
    INSERT INTO public.organizations (id, name, slug)
    VALUES (v_org, 'Synthetic Dispatch Tenant', 'geo-test-' || v_org::text);
    PERFORM set_config('app.organization_onboarding_source', '', true);

    INSERT INTO public.clients (id, organization_id, name, slug, status)
    VALUES (v_client, v_org, 'Synthetic Dispatch Client', 'geo-test-' || v_client::text, 'active');

    INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status)
    VALUES (v_provider, v_org, v_provider_name, 'geocoding', true, 100, 'healthy');

    INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version)
    VALUES (v_mapping_id, 'provider_response', 'pgtap-geocoding-dispatch-' || v_mapping_id::text, '{}'::jsonb, 1);

    INSERT INTO public.operation_templates (
        provider_id, operation_name, method, url_template, headers_template, mapping_config_id,
        handler_key, handler_version, metadata
    ) VALUES
        (v_provider, 'geocoding_fixture_forward', 'GET', 'https://geocoding.example.invalid/forward',
            '{}'::jsonb, v_mapping_id, 'outbound_http', 'v1', '{"operation_role":"geocoding_forward"}'::jsonb),
        (v_provider, 'geocoding_fixture_reverse', 'GET', 'https://geocoding.example.invalid/reverse',
            '{}'::jsonb, v_mapping_id, 'outbound_http', 'v1',
            '{"operation_role":"geocoding_reverse","url_query_mapping":[{"param":"at","value_path":"$.coordinates"}]}'::jsonb);

    SELECT s.cached_value, sv.schema_version
      INTO STRICT v_policy, v_policy_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'geocoding_policy' AND s.scope_type = 'global' AND s.scope_id IS NULL;

    v_policy := v_policy || jsonb_build_object(
        'provider_priority', jsonb_build_array(v_provider_name),
        'matching_plugins', '[{"name":"reverse","enabled":true,"params":{}}]'::jsonb
    );
    PERFORM public.upsert_settings_value_v1(
        'geocoding_policy', 'client', v_client, v_policy, v_policy_version, 'Synthetic dispatch fixture'
    );

    INSERT INTO public.workflow_templates (id, name, version, status, scope_type, scope_id)
    VALUES (v_template, 'pgtap_geo_dispatch_' || v_template::text, 1, 'active', 'tenant', v_org);

    INSERT INTO public.workflow_template_steps (
        id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version, enabled
    ) VALUES (v_template_step, v_template, 1, 'dispatch_provider', 'always', 'provider_dispatch', 'v1', true);

    FOREACH v_fallback IN ARRAY ARRAY[true, false] LOOP
        v_address := gen_random_uuid();
        v_run_id := gen_random_uuid();
        v_step_id := gen_random_uuid();
        INSERT INTO public.addresses (
            id, organization_id, client_id, raw_input, line1, validation_status
        ) VALUES (
            v_address, v_org, v_client, '{}',
            CASE WHEN v_fallback THEN 'Synthetic Dispatch Lane' END,
            'pending'
        );

        v_geocoding := '{"selected_geocode":{"coordinates":{"latitude":0.125,"longitude":-30.5}}}'::jsonb;
        IF v_fallback THEN
            v_geocoding := jsonb_set(v_geocoding, '{selected_geocode,confidence_score}', '0.2'::jsonb)
                || '{"require_fallback":true}'::jsonb;
        END IF;

        PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
        PERFORM set_config('app.workflow_run_step_id', v_step_id::text, true);
        INSERT INTO public.workflow_runs (
            id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context
        ) VALUES (
            v_run_id, v_template, 1, 'pgtap', 'pending',
            jsonb_build_object('organization_id', v_org, 'client_id', v_client,
                'address_id', v_address, 'geocoding', v_geocoding)
        ) RETURNING * INTO v_run;

        INSERT INTO public.workflow_run_steps (
            id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name,
            handler_key, handler_version, max_retries, metadata
        ) VALUES (
            v_step_id, v_run_id, v_template_step, 1, 'pending', 'dispatch_provider', 'provider_dispatch', 'v1', 1,
            jsonb_build_object('attempt_type', CASE WHEN v_fallback THEN 'fallback' ELSE 'primary' END)
        ) RETURNING * INTO v_step;

        PERFORM set_config('platform.workflow_engine', '1', true);
        PERFORM set_config('platform.workflow_run_step_id', v_step_id::text, true);
        v_response := workflow_handlers.execute_provider_dispatch_v1(v_step, v_run);
        SELECT * INTO v_job FROM public.outbound_calls
        WHERE id = (v_response.operation_result->>'outbound_call_id')::UUID;

        IF v_fallback THEN
            RETURN NEXT is(v_job.context->>'operation_name', 'geocoding_fixture_forward',
                'a low-confidence selected result keeps its forward fallback');
        ELSE
            RETURN NEXT is(v_job.context->>'operation_name', 'geocoding_fixture_reverse',
                'selected coordinates alone dispatch to the reverse provider operation');
            RETURN NEXT is(v_job.url,
                'https://geocoding.example.invalid/reverse?at=' || public.urlencode('0.125,-30.5'),
                'the queued reverse request contains the selected coordinate pair');
        END IF;
    END LOOP;
END;
$test$;

SELECT * FROM pg_temp.test_selected_coordinate_dispatch();
SELECT * FROM finish();
ROLLBACK;
