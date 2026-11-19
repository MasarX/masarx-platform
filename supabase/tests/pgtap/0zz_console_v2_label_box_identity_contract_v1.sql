SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

SELECT has_function(
  'public',
  'merge_shipment_box_label_identity_v1',
  ARRAY['uuid', 'uuid', 'text', 'uuid'],
  'canonical shipment-box label merge helper exists'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_address UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_shipment_one UUID := gen_random_uuid();
  v_box_one UUID := gen_random_uuid();
  v_legacy_label UUID := gen_random_uuid();
  v_job_one UUID := gen_random_uuid();
  v_shipment_two UUID := gen_random_uuid();
  v_box_two UUID := gen_random_uuid();
  v_canonical_label UUID := gen_random_uuid();
  v_legacy_duplicate_label UUID := gen_random_uuid();
  v_job_two UUID := gen_random_uuid();
  v_shipment_direct UUID := gen_random_uuid();
  v_box_direct UUID := gen_random_uuid();
  v_canonical_direct_label UUID := gen_random_uuid();
  v_job_direct UUID := gen_random_uuid();
  v_shipment_multi UUID := gen_random_uuid();
  v_box_multi_a UUID := gen_random_uuid();
  v_box_multi_b UUID := gen_random_uuid();
  v_job_multi UUID := gen_random_uuid();
BEGIN
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (v_org, 'pgTAP Label Box Identity Org', 'pgtap-label-box-identity-' || replace(left(v_org::text, 8), '-', ''), 'UTC', 'en-US', 'active');

  INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'pgTAP Label Box Identity Client', 'pgtap-label-box-client-' || replace(left(v_client::text, 8), '-', ''), 'standard', 'active');

  INSERT INTO addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
  VALUES (v_address, v_org, v_client, 'pgTAP label box identity address', 'Riyadh', 'Riyadh', 'SA', 'pending');

  INSERT INTO label_template_specs (
    id, organization_id, template_key, version, template_scope_type, template_scope_id, renderer_config, asset_refs
  )
  VALUES (
    v_template,
    v_org,
    'pgtap_label_box_identity',
    1,
    'tenant',
    v_org,
    jsonb_build_object(
      'page', jsonb_build_object('width_mm', 100, 'height_mm', 150, 'dpi', 203),
      'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'box.barcode')
    ),
    '[]'::jsonb
  );

  INSERT INTO shipments (
    id, organization_id, client_id, service_type, tracking_number, status, box_count,
    origin_address_id, destination_address_id, created_at, updated_at
  )
  VALUES
    (v_shipment_one, v_org, v_client, 'delivery', 'PGBXONE001', 'pending', 1, v_address, v_address, now(), now()),
    (v_shipment_two, v_org, v_client, 'delivery', 'PGBXTWO001', 'pending', 1, v_address, v_address, now(), now()),
    (v_shipment_direct, v_org, v_client, 'delivery', 'PGBXDIR001', 'pending', 1, v_address, v_address, now(), now()),
    (v_shipment_multi, v_org, v_client, 'delivery', 'PGBXMUL001', 'pending', 2, v_address, v_address, now(), now());

  INSERT INTO shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode, created_at)
  VALUES
    (v_box_one, v_shipment_one, v_org, v_client, 1, 'PGBXONE001:1', now()),
    (v_box_two, v_shipment_two, v_org, v_client, 1, 'PGBXTWO001:1', now()),
    (v_box_direct, v_shipment_direct, v_org, v_client, 1, 'PGBXDIR001:1', now()),
    (v_box_multi_a, v_shipment_multi, v_org, v_client, 1, 'PGBXMUL001:1', now()),
    (v_box_multi_b, v_shipment_multi, v_org, v_client, 2, 'PGBXMUL001:2', now());

  INSERT INTO labels (
    id, shipment_id, organization_id, client_id, label_type, barcode, barcode_format,
    layout_template_id, file_url, file_size_bytes, generated_at, print_count,
    last_printed_at, metadata, renderer_metadata
  )
  VALUES (
    v_legacy_label, v_shipment_one, v_org, v_client, 'shipping', 'PGBXONE001', 'CODE128',
    v_template, 'labels/legacy-one.pdf', 100, now() - interval '2 hours', 1,
    now() - interval '2 hours', '{}'::jsonb, '{}'::jsonb
  );
  PERFORM label_version_id FROM public.ensure_label_active_version_v1(v_legacy_label, v_shipment_one);

  INSERT INTO label_jobs (
    id, organization_id, client_id, shipment_id, label_type, template_id, template_version,
    template_snapshot, status, attempts, max_attempts, job_purpose, idempotency_key,
    requested_source, renderer_metadata
  )
  VALUES (
    v_job_one, v_org, v_client, v_shipment_one, 'shipping', v_template, 1,
    jsonb_build_object('label_config', jsonb_build_object('barcode_format', 'CODE128'), 'renderer_config', jsonb_build_object('barcode', jsonb_build_object('type', 'CODE128'))),
    'in_progress', 1, 3, 'primary', 'pgtap-box-identity-one', 'pgtap', '{}'::jsonb
  );

  PERFORM public.complete_label_job(
    v_job_one,
    'succeeded',
    'labels/PGBXONE001-1.pdf',
    200,
    jsonb_build_object('barcode', 'PGBXONE001', 'engine', 'pgtap'),
    NULL
  );

  PERFORM is((SELECT count(*)::int FROM public.labels WHERE shipment_id = v_shipment_one), 1, 'legacy tracking-only label is repaired in place for one-box shipment');
  PERFORM is((SELECT barcode FROM public.labels WHERE id = v_legacy_label AND shipment_id = v_shipment_one), 'PGBXONE001:1', 'legacy label row is moved to canonical box barcode');
  PERFORM is((SELECT label_id::text FROM public.label_jobs WHERE id = v_job_one), v_legacy_label::text, 'completed job points at repaired stable label identity');
  PERFORM is((SELECT count(*)::int FROM public.label_versions WHERE shipment_id = v_shipment_one AND barcode <> 'PGBXONE001:1'), 0, 'label versions are normalized to box barcode');

  INSERT INTO labels (
    id, shipment_id, organization_id, client_id, label_type, barcode, barcode_format,
    layout_template_id, file_url, file_size_bytes, generated_at, print_count,
    last_printed_at, metadata, renderer_metadata
  )
  VALUES
    (v_canonical_label, v_shipment_two, v_org, v_client, 'shipping', 'PGBXTWO001:1', 'CODE128', v_template, 'labels/canonical-two.pdf', 100, now() - interval '3 hours', 1, now() - interval '3 hours', '{}'::jsonb, '{}'::jsonb),
    (v_legacy_duplicate_label, v_shipment_two, v_org, v_client, 'shipping', 'PGBXTWO001', 'CODE128', v_template, 'labels/legacy-two.pdf', 100, now() - interval '2 hours', 1, now() - interval '2 hours', '{}'::jsonb, '{}'::jsonb);
  PERFORM label_version_id FROM public.ensure_label_active_version_v1(v_canonical_label, v_shipment_two);
  PERFORM label_version_id FROM public.ensure_label_active_version_v1(v_legacy_duplicate_label, v_shipment_two);

  INSERT INTO label_jobs (
    id, organization_id, client_id, shipment_id, shipment_box_id, label_type, template_id,
    template_version, template_snapshot, status, attempts, max_attempts, job_purpose,
    idempotency_key, requested_source, renderer_metadata
  )
  VALUES (
    v_job_two, v_org, v_client, v_shipment_two, v_box_two, 'shipping', v_template,
    1,
    jsonb_build_object('label_config', jsonb_build_object('barcode_format', 'CODE128'), 'renderer_config', jsonb_build_object('barcode', jsonb_build_object('type', 'CODE128'))),
    'in_progress', 1, 3, 'reprint', 'pgtap-box-identity-two', 'pgtap', '{}'::jsonb
  );

  PERFORM public.complete_label_job(
    v_job_two,
    'succeeded',
    'labels/PGBXTWO001-1.pdf',
    300,
    jsonb_build_object('barcode', 'PGBXTWO001', 'engine', 'pgtap'),
    NULL
  );

  PERFORM is((SELECT count(*)::int FROM public.labels WHERE shipment_id = v_shipment_two), 1, 'duplicate tracking-only label is merged into canonical box label');
  PERFORM is((SELECT id::text FROM public.labels WHERE shipment_id = v_shipment_two), v_canonical_label::text, 'canonical box label row is retained');
  PERFORM is((SELECT count(*)::int FROM public.label_versions WHERE label_id = v_canonical_label AND version_status = 'active'), 1, 'merged label lineage keeps exactly one active version');
  PERFORM is((SELECT label_id::text FROM public.label_jobs WHERE id = v_job_two), v_canonical_label::text, 'reprint job points at canonical box label after merge');
  PERFORM is((SELECT count(*)::int FROM public.label_versions WHERE shipment_id = v_shipment_two AND barcode <> 'PGBXTWO001:1'), 0, 'merged versions are normalized to canonical box barcode');
  PERFORM ok(NOT EXISTS (SELECT 1 FROM public.labels WHERE shipment_id = v_shipment_two AND barcode = 'PGBXTWO001'), 'base tracking label identity is removed after merge');

  INSERT INTO labels (
    id, shipment_id, organization_id, client_id, label_type, barcode, barcode_format,
    layout_template_id, file_url, file_size_bytes, generated_at, print_count,
    last_printed_at, metadata, renderer_metadata
  )
  VALUES (
    v_canonical_direct_label, v_shipment_direct, v_org, v_client, 'shipping', 'PGBXDIR001:1', 'CODE128',
    v_template, 'labels/canonical-direct.pdf', 100, now() - interval '1 hour', 1,
    now() - interval '1 hour', '{}'::jsonb, '{}'::jsonb
  );
  PERFORM label_version_id FROM public.ensure_label_active_version_v1(v_canonical_direct_label, v_shipment_direct);

  INSERT INTO label_jobs (
    id, organization_id, client_id, shipment_id, label_type, template_id, template_version,
    template_snapshot, status, attempts, max_attempts, job_purpose, idempotency_key,
    requested_source, renderer_metadata
  )
  VALUES (
    v_job_direct, v_org, v_client, v_shipment_direct, 'shipping', v_template, 1,
    jsonb_build_object('label_config', jsonb_build_object('barcode_format', 'CODE128'), 'renderer_config', jsonb_build_object('barcode', jsonb_build_object('type', 'CODE128'))),
    'in_progress', 1, 3, 'primary', 'pgtap-box-identity-direct', 'pgtap', '{}'::jsonb
  );

  PERFORM public.complete_label_job_shipment_v1(
    v_job_direct,
    'succeeded',
    'labels/PGBXDIR001-1.pdf',
    350,
    jsonb_build_object('barcode', 'PGBXDIR001', 'engine', 'pgtap-direct'),
    NULL
  );

  PERFORM is((SELECT count(*)::int FROM public.labels WHERE shipment_id = v_shipment_direct), 1, 'direct shipment completion keeps one stable label identity for one-box shipment');
  PERFORM is((SELECT id::text FROM public.labels WHERE shipment_id = v_shipment_direct), v_canonical_direct_label::text, 'direct shipment completion reuses canonical box label row');
  PERFORM is((SELECT barcode FROM public.labels WHERE shipment_id = v_shipment_direct), 'PGBXDIR001:1', 'direct shipment completion resolves renderer base barcode to box barcode');
  PERFORM ok(NOT EXISTS (SELECT 1 FROM public.labels WHERE shipment_id = v_shipment_direct AND barcode = 'PGBXDIR001'), 'direct shipment completion does not create base tracking label identity');

  INSERT INTO label_jobs (
    id, organization_id, client_id, shipment_id, label_type, template_id, template_version,
    template_snapshot, status, attempts, max_attempts, job_purpose, idempotency_key,
    requested_source, renderer_metadata
  )
  VALUES (
    v_job_multi, v_org, v_client, v_shipment_multi, 'shipping', v_template, 1,
    jsonb_build_object('label_config', jsonb_build_object('barcode_format', 'CODE128'), 'renderer_config', jsonb_build_object('barcode', jsonb_build_object('type', 'CODE128'))),
    'in_progress', 1, 3, 'primary', 'pgtap-box-identity-multi', 'pgtap', '{}'::jsonb
  );

  BEGIN
    PERFORM public.complete_label_job(
      v_job_multi,
      'succeeded',
      'labels/PGBXMUL001.pdf',
      400,
      jsonb_build_object('barcode', 'PGBXMUL001', 'engine', 'pgtap'),
      NULL
    );
    PERFORM ok(FALSE, 'multi-box completion without shipment_box_id fails closed');
  EXCEPTION WHEN OTHERS THEN
    PERFORM ok(SQLERRM LIKE '%requires shipment_box_id%', 'multi-box completion without shipment_box_id fails closed');
  END;

  PERFORM is((SELECT status FROM public.label_jobs WHERE id = v_job_multi), 'in_progress', 'multi-box failed completion does not mark job succeeded');
END $$;

SELECT * FROM finish();
ROLLBACK;
