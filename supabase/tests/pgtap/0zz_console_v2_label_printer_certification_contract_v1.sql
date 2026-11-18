-- pgTAP: Console V2 label printer certification contract
-- Verifies label_print_profile v2 evidence schema, browser-safe RPC, and
-- readiness reconciliation after certification evidence is recorded.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

CREATE TEMP TABLE _label_printer_certification_result (
  result JSONB NOT NULL
) ON COMMIT DROP;

DO $setup$
DECLARE
  v_org UUID := '775c6100-254b-4f2d-b9f6-1262f52b06b1'::uuid;
  v_user UUID := '775c6100-254b-4f2d-b9f6-1262f52b06b2'::uuid;
  v_provider JSONB := jsonb_build_object(
    'version', 1,
    'providers', jsonb_build_array(
      jsonb_build_object(
        'mode', 'internal',
        'name', 'pg_tap_label_renderer_certified',
        'invoke_url', 'http://127.0.0.1:57429/functions/v1/label-renderer?token=must-not-leak',
        'timeout_ms', 30000,
        'invoke_secret', 'super-secret-provider-token'
      )
    )
  );
  v_profile JSONB := jsonb_build_object(
    'version', 1,
    'profile_key', 'pg_tap_203dpi',
    'dpi', 203,
    'media', jsonb_build_object('kind', 'thermal', 'darkness', 18, 'width_inch', 4, 'height_inch', 6),
    'barcode', jsonb_build_object('quiet_zone_modules', 10, 'min_quiet_zone_modules', 4, 'target_module_width_dots', 2, 'hard_min_module_width_dots', 1)
  );
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Label Printer Certification Org', 'console-v2-label-printer-certification-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name)
  VALUES (v_user, v_org, 'label.printer.certification@pgtap.local', 'Label Printer Certification pgTAP')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name;

  PERFORM public.upsert_settings_value_v1(
    'label_provider',
    'tenant',
    v_org,
    v_provider,
    1,
    'pgTAP active label renderer provider for printer certification'
  );

  PERFORM public.upsert_settings_value_v1(
    'label_print_profile',
    'tenant',
    v_org,
    v_profile,
    1,
    'pgTAP uncertified label print profile fixture'
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'service_role', 'aud', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  INSERT INTO _label_printer_certification_result(result)
  SELECT public.ui_record_label_printer_certification_v1(
    'tenant',
    v_org,
    jsonb_build_object(
      'evidence_reference', 'BrowserPrinterCertProof-pgtap',
      'printer_model', 'Zebra ZD421',
      'printer_serial', 'PGTAP-203-001',
      'test_artifact_ref', 'label-certification/pg-tap-203dpi.pdf'
    ),
    'pgTAP printer certification evidence proof'
  );
END
$setup$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'label_print_profile'
       AND version = 2
       AND is_active
       AND schema ? 'properties'
       AND schema #> '{properties,printer_certification,required}' ? 'evidence_reference'
  ),
  'label_print_profile v2 schema includes active printer_certification evidence contract'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'api'
       AND p.proname = 'ui_record_label_printer_certification_v1'
  ),
  'api wrapper exists for browser-safe printer certification recording'
);

SELECT is(result->>'ok', 'true', 'record certification RPC returns ok')
FROM _label_printer_certification_result;

SELECT is(result#>>'{certification,evidence_reference}', 'BrowserPrinterCertProof-pgtap', 'certification evidence reference is returned')
FROM _label_printer_certification_result;

SELECT is(result#>>'{certification,printer_model}', 'Zebra ZD421', 'certification printer model is returned')
FROM _label_printer_certification_result;

SELECT is(result#>>'{certification,printer_dpi}', '203', 'certification inherits printer dpi from print profile')
FROM _label_printer_certification_result;

SELECT is(result#>>'{certification,result}', 'passed', 'certification defaults to passed result')
FROM _label_printer_certification_result;

SELECT is(result#>>'{readiness,printer_certification,status}', 'ready', 'readiness is ready after certification evidence is recorded')
FROM _label_printer_certification_result;

SELECT is(result#>>'{readiness,printer_certification,missing}', '[]', 'readiness has no missing certification fields after recording')
FROM _label_printer_certification_result;

SELECT is(result#>>'{readiness,printer_certification,evidence,evidence_reference}', 'BrowserPrinterCertProof-pgtap', 'readiness returns same certification evidence')
FROM _label_printer_certification_result;

SELECT isnt(result#>>'{settings_version_id}', '', 'settings version id returned for no-reload readback correlation')
FROM _label_printer_certification_result;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'label_print_profile'
       AND s.scope_type = 'tenant'
       AND s.scope_id = '775c6100-254b-4f2d-b9f6-1262f52b06b1'::uuid
       AND s.cached_value #>> '{printer_certification,evidence_reference}' = 'BrowserPrinterCertProof-pgtap'
  ),
  'certification evidence persists in active label_print_profile settings row'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     WHERE sv.category = 'label_print_profile'
       AND sv.scope_type = 'tenant'
       AND sv.scope_id = '775c6100-254b-4f2d-b9f6-1262f52b06b1'::uuid
       AND sv.schema_version = 2
       AND sv.value #>> '{printer_certification,evidence_reference}' = 'BrowserPrinterCertProof-pgtap'
  ),
  'certification evidence is versioned with schema v2'
);

SELECT throws_ok(
  $$
    SELECT public.ui_record_label_printer_certification_v1(
      'tenant',
      '775c6100-254b-4f2d-b9f6-1262f52b06b1'::uuid,
      jsonb_build_object('printer_model', 'Missing evidence ref'),
      'missing ref should fail'
    )
  $$,
  '22023',
  'ui_record_label_printer_certification_v1 requires evidence_reference',
  'missing evidence reference fails closed'
);

SELECT * FROM finish();

ROLLBACK;
