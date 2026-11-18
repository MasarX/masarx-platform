-- Ensure manual shipment intake queues label jobs against a concrete shipment box.
--
-- Manual Console intake creates the shipment, amends the destination address,
-- and then queues a label job. The renderer completion path requires the
-- canonical shipment_boxes barcode identity, so the intake wrapper must create
-- or resolve the first box before request_label_generation.

DO $$
DECLARE
  v_def text;
  v_next text;
BEGIN
  SELECT pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.ui_create_manual_shipment_intake_v1(jsonb) is missing';
  END IF;

  v_def := replace(
    v_def,
    '  -- manual_intake_label_box_readiness: label rendering requires the canonical
  -- shipment_boxes barcode identity. Manual intake creates/resolves box #1
  -- before queueing the first label job so renderer completion can persist an
  -- active label artifact without a separate operator workaround.
  IF v_shipment_box_id IS NULL THEN
    SELECT eb.shipment_box_id
      INTO v_shipment_box_id
      FROM public.ensure_shipment_boxes(v_shipment_id, 1) AS eb
     ORDER BY eb.box_number
     LIMIT 1;
  END IF;

  IF v_shipment_box_id IS NULL THEN
    RAISE EXCEPTION ''ui_create_manual_shipment_intake_v1 could not resolve shipment_box_id for label generation'';
  END IF;

',
    ''
  );

  v_def := replace(
    v_def,
    '  -- manual_intake_label_box_readiness_v2: label rendering requires the canonical
  -- shipment_boxes barcode identity. Manual intake creates/resolves box #1
  -- before queueing the first label job so renderer completion can persist an
  -- active label artifact without a separate operator workaround.
  IF v_shipment_box_id IS NULL THEN
    PERFORM 1
      FROM public.ensure_shipment_boxes(v_shipment_id, 1) AS eb;

    SELECT sb.id
      INTO v_shipment_box_id
      FROM public.shipment_boxes AS sb
     WHERE sb.shipment_id = v_shipment_id
     ORDER BY sb.box_number, sb.id
     LIMIT 1;
  END IF;

  IF v_shipment_box_id IS NULL THEN
    RAISE EXCEPTION ''ui_create_manual_shipment_intake_v1 could not resolve shipment_box_id for label generation'';
  END IF;

',
    ''
  );

  v_def := replace(
    v_def,
    '  -- manual_intake_label_box_readiness_v2: label rendering requires the canonical
  -- shipment_boxes barcode identity. Manual intake creates/resolves the canonical
  -- shipment box set before selecting the first available box for the label job
  -- before queueing the first label job so renderer completion can persist an
  -- active label artifact without a separate operator workaround.
  IF v_shipment_box_id IS NULL THEN
    PERFORM 1
      FROM public.ensure_shipment_boxes(v_shipment_id) AS eb;

    SELECT sb.id
      INTO v_shipment_box_id
      FROM public.shipment_boxes AS sb
     WHERE sb.shipment_id = v_shipment_id
     ORDER BY sb.box_number, sb.id
     LIMIT 1;
  END IF;

  IF v_shipment_box_id IS NULL THEN
    RAISE EXCEPTION ''ui_create_manual_shipment_intake_v1 could not resolve shipment_box_id for label generation'';
  END IF;

',
    ''
  );

  v_def := replace(
    v_def,
    '  -- manual_intake_label_box_readiness_v2: label rendering requires the canonical
  -- shipment_boxes barcode identity. Manual intake creates/resolves enough
  -- shipment boxes to cover the canonical first label target, then selects it
  -- before queueing the first label job so renderer completion can persist an
  -- active label artifact without a separate operator workaround.
  IF v_shipment_box_id IS NULL THEN
    PERFORM 1
      FROM public.ensure_shipment_boxes(
        v_shipment_id,
        GREATEST(1, COALESCE((SELECT max(existing_box.box_number) FROM public.shipment_boxes AS existing_box WHERE existing_box.shipment_id = v_shipment_id), 0))
      ) AS eb;

    SELECT sb.id
      INTO v_shipment_box_id
      FROM public.shipment_boxes AS sb
     WHERE sb.shipment_id = v_shipment_id
     ORDER BY sb.box_number, sb.id
     LIMIT 1;
  END IF;

  IF v_shipment_box_id IS NULL THEN
    RAISE EXCEPTION ''ui_create_manual_shipment_intake_v1 could not resolve shipment_box_id for label generation'';
  END IF;

',
    ''
  );

  IF v_def NOT LIKE '%v_label_job_id := public.request_label_generation(%' THEN
    RAISE EXCEPTION 'manual intake label queue anchor not found';
  END IF;

  v_next := replace(
    v_def,
    '  v_label_job_id := public.request_label_generation(',
    '  -- manual_intake_label_box_readiness_v2: label rendering requires the canonical
  -- shipment_boxes barcode identity. Manual intake creates/resolves enough
  -- shipment boxes to cover the canonical first label target, then selects it
  -- before queueing the first label job so renderer completion can persist an
  -- active label artifact without a separate operator workaround.
  IF v_shipment_box_id IS NULL THEN
    PERFORM 1
      FROM public.ensure_shipment_boxes(
        v_shipment_id,
        GREATEST(1, COALESCE((SELECT max(existing_box.box_number) FROM public.shipment_boxes AS existing_box WHERE existing_box.shipment_id = v_shipment_id), 0))
      ) AS eb;

    SELECT sb.id
      INTO v_shipment_box_id
      FROM public.shipment_boxes AS sb
     WHERE sb.shipment_id = v_shipment_id
     ORDER BY sb.box_number, sb.id
     LIMIT 1;
  END IF;

  IF v_shipment_box_id IS NULL THEN
    RAISE EXCEPTION ''ui_create_manual_shipment_intake_v1 could not resolve shipment_box_id for label generation'';
  END IF;

  v_label_job_id := public.request_label_generation('
  );

  EXECUTE v_next;
END $$;

COMMENT ON FUNCTION public.ui_create_manual_shipment_intake_v1(jsonb)
  IS 'Console V2 backend lifecycle RPC for manual shipment intake: validates recipient mode, optionally creates inline recipient through recipient_create_v1, creates shipment through ui_create_shipment_v1, applies destination address through shipment_amend_cancel_v1, ensures the first shipment box before label queueing, queues label generation through request_label_generation, and returns existing shipment context without side effects when tracking/client reference resolves to a duplicate.';
