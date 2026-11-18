SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_address UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_job UUID := gen_random_uuid();
  v_shipment_multi UUID := gen_random_uuid();
  v_job_multi UUID := gen_random_uuid();
  v_box_id UUID;
  v_payload JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (
    v_org,
    'pgTAP Plugin Label Box Readiness Org',
    'pgtap-plugin-label-box-readiness-' || replace(left(v_org::text, 8), '-', ''),
    'UTC',
    'en-US',
    'active'
  );

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (
    v_client,
    v_org,
    'pgTAP Plugin Label Box Readiness Client',
    'pgtap-plugin-label-box-client-' || replace(left(v_client::text, 8), '-', ''),
    'standard',
    'active'
  );

  INSERT INTO public.addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
  VALUES (v_address, v_org, v_client, 'pgTAP plugin label render box readiness address', 'Riyadh', 'Riyadh', 'SA', 'pending');

  INSERT INTO public.label_template_specs (
    id,
    organization_id,
    template_key,
    version,
    template_scope_type,
    template_scope_id,
    renderer_config,
    asset_refs
  )
  VALUES (
    v_template,
    v_org,
    'pgtap_plugin_label_render_box_readiness',
    1,
    'tenant',
    v_org,
    jsonb_build_object(
      'page', jsonb_build_object('width_mm', 100, 'height_mm', 150, 'dpi', 203),
      'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'barcode')
    ),
    '[]'::jsonb
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    service_type,
    tracking_number,
    status,
    box_count,
    origin_address_id,
    destination_address_id,
    created_at,
    updated_at
  )
  VALUES
    (
      v_shipment,
      v_org,
      v_client,
      'delivery',
      'PGPLUGINBOX001',
      'pending',
      1,
      v_address,
      v_address,
      now(),
      now()
    ),
    (
      v_shipment_multi,
      v_org,
      v_client,
      'delivery',
      'PGPLUGINBOXMUL001',
      'pending',
      2,
      v_address,
      v_address,
      now(),
      now()
    );

  INSERT INTO public.label_jobs (
    id,
    organization_id,
    client_id,
    shipment_id,
    label_type,
    template_id,
    template_version,
    template_snapshot,
    status,
    attempts,
    max_attempts,
    job_purpose,
    idempotency_key,
    requested_source,
    renderer_metadata
  )
  VALUES
    (
      v_job,
      v_org,
      v_client,
      v_shipment,
      'shipping',
      v_template,
      1,
      jsonb_build_object(
        'template_key', 'pgtap_plugin_label_render_box_readiness',
        'version', 1,
        'label_config', jsonb_build_object('barcode_format', 'CODE128'),
        'renderer_config', jsonb_build_object('barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'barcode'))
      ),
      'in_progress',
      1,
      3,
      'primary',
      'pgtap-plugin-label-render-box-readiness',
      'plugin_studio_api_gateway',
      '{}'::jsonb
    ),
    (
      v_job_multi,
      v_org,
      v_client,
      v_shipment_multi,
      'shipping',
      v_template,
      1,
      jsonb_build_object(
        'template_key', 'pgtap_plugin_label_render_box_readiness',
        'version', 1,
        'label_config', jsonb_build_object('barcode_format', 'CODE128'),
        'renderer_config', jsonb_build_object('barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'barcode'))
      ),
      'in_progress',
      1,
      3,
      'primary',
      'pgtap-plugin-label-render-box-readiness-multi',
      'plugin_studio_api_gateway',
      '{}'::jsonb
    );

  PERFORM is(
    (SELECT count(*)::int FROM public.shipment_boxes WHERE shipment_id = v_shipment),
    0,
    'plugin-style shipment starts without materialized shipment box rows'
  );

  v_payload := public.compose_label_payload(v_job);

  SELECT sb.id
    INTO v_box_id
    FROM public.shipment_boxes sb
   WHERE sb.shipment_id = v_shipment
   LIMIT 1;

  PERFORM is(
    (SELECT count(*)::int FROM public.shipment_boxes WHERE shipment_id = v_shipment),
    1,
    'compose_label_payload materializes the one-box shipment before rendering'
  );

  PERFORM is(
    v_payload #>> '{payload,barcode}',
    'PGPLUGINBOX001:1',
    'compose_label_payload resolves renderer barcode from canonical shipment box'
  );

  PERFORM is(
    NULLIF(v_payload #>> '{payload,shipment_box_id}', '')::uuid,
    v_box_id,
    'compose_label_payload includes the canonical shipment_box_id in renderer payload'
  );

  PERFORM lives_ok(
    format(
      'SELECT public.complete_label_job(%L::uuid, %L, %L, %s, %L::jsonb, NULL)',
      v_job,
      'succeeded',
      'labels/PGPLUGINBOX001-1.pdf',
      4096,
      jsonb_build_object('barcode', 'PGPLUGINBOX001:1', 'engine', 'pgtap')::text
    ),
    'complete_label_job succeeds for plugin-created one-box shipment after canonical box materialization'
  );

  PERFORM is(
    (SELECT status FROM public.label_jobs WHERE id = v_job),
    'succeeded',
    'label job is marked succeeded after completion'
  );

  PERFORM is(
    (SELECT barcode FROM public.labels WHERE shipment_id = v_shipment LIMIT 1),
    'PGPLUGINBOX001:1',
    'completed label persists the canonical shipment-box barcode identity'
  );

  BEGIN
    PERFORM public.compose_label_payload(v_job_multi);
    PERFORM ok(FALSE, 'compose_label_payload fails closed for multi-box shipment without explicit shipment_box_id');
  EXCEPTION WHEN OTHERS THEN
    PERFORM ok(
      SQLERRM LIKE '%requires shipment_box_id%',
      'compose_label_payload fails closed for multi-box shipment without explicit shipment_box_id'
    );
  END;

  PERFORM is(
    (SELECT count(*)::int FROM public.shipment_boxes WHERE shipment_id = v_shipment_multi),
    0,
    'multi-box compose guard fails without leaving partial shipment-box rows'
  );

  BEGIN
    PERFORM public.complete_label_job(
      v_job_multi,
      'succeeded',
      'labels/PGPLUGINBOXMUL001-1.pdf',
      4096,
      jsonb_build_object('barcode', 'PGPLUGINBOXMUL001:1', 'engine', 'pgtap'),
      NULL
    );
    PERFORM ok(FALSE, 'complete_label_job fails closed for multi-box shipment even when renderer supplies a box barcode');
  EXCEPTION WHEN OTHERS THEN
    PERFORM ok(
      SQLERRM LIKE '%requires shipment_box_id%',
      'complete_label_job fails closed for multi-box shipment even when renderer supplies a box barcode'
    );
  END;

  PERFORM is(
    (SELECT status FROM public.label_jobs WHERE id = v_job_multi),
    'in_progress',
    'multi-box failed completion does not mark job succeeded'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
