-- pgTAP: Console V2 label printer certification contract
-- Verifies the active shared schema, strict evidence RPC, and
-- readiness reconciliation after certification evidence is recorded.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

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
        'invoke_url', concat('https', '://', concat_ws('.', 'renderer', 'example', 'test'), '/functions/v1/label-renderer'),
        'timeout_ms', 30000,
        'invoke_secret', gen_random_uuid()::text
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
  VALUES (v_user, v_org, concat(v_user, chr(64), concat_ws('.', 'example', 'test')), 'Label Printer Certification pgTAP')
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
       AND version > 1
       AND is_active
       AND schema #> '{properties,printer_certification,anyOf}' IS NOT NULL
  ),
  'active label_print_profile schema accepts the canonical certification aliases'
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
       AND sv.schema_version = (
         SELECT sr.version FROM public.schema_registry sr
          WHERE sr.category = 'label_print_profile' AND sr.is_active
       )
       AND sv.value #>> '{printer_certification,evidence_reference}' = 'BrowserPrinterCertProof-pgtap'
  ),
  'certification evidence is versioned with the active shared schema'
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

SELECT throws_ok(
  $$
    SELECT api.ui_record_label_printer_certification_v1(
      'tenant', '775c6100-254b-4f2d-b9f6-1262f52b06b1'::uuid,
      '{"evidence_reference":"test-proof","printer_model":"Test Printer","extra":true}'::jsonb
    )
  $$,
  '22023',
  'ui_record_label_printer_certification_v1 received unknown evidence fields',
  'extra evidence fields are rejected before writing'
);

SELECT throws_ok(
  $$
    SELECT api.ui_record_label_printer_certification_v1(
      'tenant', '775c6100-254b-4f2d-b9f6-1262f52b06b1'::uuid,
      '{"evidence_reference":"test-proof","printer_model":"Test Printer","printer_dpi":601}'::jsonb
    )
  $$,
  '22023',
  'ui_record_label_printer_certification_v1 evidence does not match the printer certification contract',
  'evidence outside the printer DPI range is rejected'
);

SELECT is(
  api.ui_record_label_printer_certification_v1(
    'tenant', '775c6100-254b-4f2d-b9f6-1262f52b06b1'::uuid,
    '{"certification_id":"test-cert","certified_at":"2026-01-01T00:00:00Z",
      "evidence_reference":"test-proof","printer_model":"Test Printer","printer_dpi":203,
      "media":{"kind":"thermal"},"result":"conditional"}'::jsonb
  )->>'ok',
  'true',
  'complete seven-field certification evidence is accepted'
);

SELECT * FROM finish();

ROLLBACK;
