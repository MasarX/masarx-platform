-- Migration: FieldOps Mobile V2 onboarding/readiness same-context readback
-- Date: 2026-05-28
--
-- Purpose:
--   Mobile V2 already has backend write RPCs for KYC documents, vehicle
--   registration, cleaning attestation, and the pre-shift gate. The runtime
--   shell needs a single backend-confirmed resolver after those writes so the
--   operator sees the canonical state without reopening or falling back to V1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605281100_fieldops_mobile_v2_onboarding_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH cleaning_items AS (
  SELECT jsonb_build_array(
    jsonb_build_object('id', 'cabin', 'label', 'Cabin wiped & vacuumed', 'sub', 'Dashboard, seats, floor mats'),
    jsonb_build_object('id', 'cargo', 'label', 'Cargo bay swept & sanitised', 'sub', 'Especially after cold-chain or food'),
    jsonb_build_object('id', 'glass', 'label', 'Windscreen + mirrors clear', 'sub', 'Inside and out'),
    jsonb_build_object('id', 'odour', 'label', 'No odour or food waste', 'sub', 'Critical for pharmacy & retail stops'),
    jsonb_build_object('id', 'plate', 'label', 'Plate visible - no mud', 'sub', 'ANPR at fulfilment gates fails on dirty plates')
  ) AS value,
  jsonb_build_array('front', 'rear', 'left', 'right') AS vehicle_photo_angles
)
UPDATE public.settings_versions sv
   SET value = jsonb_set(
                 jsonb_set(
                   COALESCE(sv.value, '{}'::jsonb),
                   '{cleaning_items}',
                   CASE
                     WHEN COALESCE(sv.value, '{}'::jsonb) ? 'cleaning_items'
                       THEN COALESCE(sv.value, '{}'::jsonb)->'cleaning_items'
                     ELSE cleaning_items.value
                   END,
                   TRUE
                 ),
                 '{vehicle_photo_angles}',
                 CASE
                   WHEN COALESCE(sv.value, '{}'::jsonb) ? 'vehicle_photo_angles'
                     THEN COALESCE(sv.value, '{}'::jsonb)->'vehicle_photo_angles'
                   ELSE cleaning_items.vehicle_photo_angles
                 END,
                 TRUE
               ),
       change_reason = COALESCE(sv.change_reason, 'Mobile V2 policy update') || '; add Mobile V2 cleaning checklist items'
  FROM cleaning_items
 WHERE sv.category = 'mobile_pre_shift_gate_policy'
   AND sv.effective_until IS NULL
   AND sv.approved_at IS NOT NULL
   AND (
     NOT (COALESCE(sv.value, '{}'::jsonb) ? 'cleaning_items')
     OR NOT (COALESCE(sv.value, '{}'::jsonb) ? 'vehicle_photo_angles')
   );

WITH cleaning_items AS (
  SELECT jsonb_build_array(
    jsonb_build_object('id', 'cabin', 'label', 'Cabin wiped & vacuumed', 'sub', 'Dashboard, seats, floor mats'),
    jsonb_build_object('id', 'cargo', 'label', 'Cargo bay swept & sanitised', 'sub', 'Especially after cold-chain or food'),
    jsonb_build_object('id', 'glass', 'label', 'Windscreen + mirrors clear', 'sub', 'Inside and out'),
    jsonb_build_object('id', 'odour', 'label', 'No odour or food waste', 'sub', 'Critical for pharmacy & retail stops'),
    jsonb_build_object('id', 'plate', 'label', 'Plate visible - no mud', 'sub', 'ANPR at fulfilment gates fails on dirty plates')
  ) AS value,
  jsonb_build_array('front', 'rear', 'left', 'right') AS vehicle_photo_angles
)
UPDATE public.settings s
   SET cached_value = jsonb_set(
                        jsonb_set(
                          COALESCE(s.cached_value, '{}'::jsonb),
                          '{cleaning_items}',
                          CASE
                            WHEN COALESCE(s.cached_value, '{}'::jsonb) ? 'cleaning_items'
                              THEN COALESCE(s.cached_value, '{}'::jsonb)->'cleaning_items'
                            ELSE cleaning_items.value
                          END,
                          TRUE
                        ),
                        '{vehicle_photo_angles}',
                        CASE
                          WHEN COALESCE(s.cached_value, '{}'::jsonb) ? 'vehicle_photo_angles'
                            THEN COALESCE(s.cached_value, '{}'::jsonb)->'vehicle_photo_angles'
                          ELSE cleaning_items.vehicle_photo_angles
                        END,
                        TRUE
                      ),
       last_updated = now()
  FROM cleaning_items
 WHERE s.category = 'mobile_pre_shift_gate_policy'
   AND (
     NOT (COALESCE(s.cached_value, '{}'::jsonb) ? 'cleaning_items')
     OR NOT (COALESCE(s.cached_value, '{}'::jsonb) ? 'vehicle_photo_angles')
   );

INSERT INTO public.lookup_values (
  id,
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  status,
  metadata,
  effective_from
)
SELECT
  public.uuid_from_hash('decision_category:fieldops_vehicle_photos'),
  ld.id,
  'fieldops_vehicle_photos',
  'FieldOps vehicle photos',
  'Mobile V2 vehicle photo angle evidence submission',
  9312,
  'active',
  jsonb_build_object('system', 'fieldops_mobile_v2'),
  now()
FROM public.lookup_definitions ld
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.fieldops_v2_vehicle_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  angle_paths JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_v2_vehicle_photos_angle_paths_ck CHECK (
    jsonb_typeof(angle_paths) = 'object'
    AND angle_paths <> '{}'::jsonb
  ),
  CONSTRAINT fieldops_v2_vehicle_photos_status_ck
    CHECK (status IN ('submitted', 'approved', 'rejected'))
);

ALTER TABLE public.fieldops_v2_vehicle_photos
  DROP CONSTRAINT IF EXISTS fieldops_v2_vehicle_photos_angle_paths_ck;

ALTER TABLE public.fieldops_v2_vehicle_photos
  ADD CONSTRAINT fieldops_v2_vehicle_photos_angle_paths_ck CHECK (
    jsonb_typeof(angle_paths) = 'object'
    AND angle_paths <> '{}'::jsonb
  );

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_vehicle_photos_user
  ON public.fieldops_v2_vehicle_photos (organization_id, user_id, created_at DESC);

COMMENT ON TABLE public.fieldops_v2_vehicle_photos IS
  'Mobile V2 vehicle photo angle submissions captured before pre-shift. One row stores canonical policy-driven angle evidence paths for a user inside an org.';

ALTER TABLE public.fieldops_v2_vehicle_photos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_v2_vehicle_photos FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.fieldops_v2_vehicle_photos FROM authenticated;
GRANT SELECT ON TABLE public.fieldops_v2_vehicle_photos TO authenticated;
GRANT ALL ON TABLE public.fieldops_v2_vehicle_photos TO service_role;

DROP POLICY IF EXISTS fieldops_v2_vehicle_photos_service_policy ON public.fieldops_v2_vehicle_photos;
CREATE POLICY fieldops_v2_vehicle_photos_service_policy ON public.fieldops_v2_vehicle_photos
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_v2_vehicle_photos_select_policy ON public.fieldops_v2_vehicle_photos;
CREATE POLICY fieldops_v2_vehicle_photos_select_policy ON public.fieldops_v2_vehicle_photos
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND (user_id = auth.uid() OR public.user_can_write())
    )
  );

DROP POLICY IF EXISTS fieldops_v2_vehicle_photos_insert_policy ON public.fieldops_v2_vehicle_photos;
CREATE POLICY fieldops_v2_vehicle_photos_insert_policy ON public.fieldops_v2_vehicle_photos
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND organization_id = public.current_user_org_id()
    AND user_id = auth.uid()
  );

CREATE OR REPLACE FUNCTION public.submit_fieldops_vehicle_photos_v1(
  p_angle_paths JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_paths JSONB := COALESCE(p_angle_paths, '{}'::jsonb);
  v_policy JSONB := '{}'::jsonb;
  v_required_angles TEXT[] := ARRAY[]::TEXT[];
  v_missing_angles TEXT[] := ARRAY[]::TEXT[];
  v_existing UUID;
  v_existing_photo_set_id UUID;
  v_existing_paths JSONB;
  v_decision_id UUID;
  v_photo_set_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_vehicle_photos_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_vehicle_photos_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_vehicle_photos_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT public.resolve_settings('mobile_pre_shift_gate_policy', 'tenant', v_org)
    INTO v_policy;
  IF v_policy IS NULL THEN
    SELECT public.resolve_settings('mobile_pre_shift_gate_policy', 'global', NULL)
      INTO v_policy;
  END IF;
  v_policy := COALESCE(v_policy, '{}'::jsonb);

  IF NOT (v_policy ? 'vehicle_photo_angles')
     OR jsonb_typeof(v_policy->'vehicle_photo_angles') <> 'array' THEN
    RAISE EXCEPTION 'submit_fieldops_vehicle_photos_v1 requires row-driven vehicle_photo_angles policy'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(angle_key), ARRAY[]::TEXT[])
    INTO v_required_angles
    FROM jsonb_array_elements_text(v_policy->'vehicle_photo_angles') AS angle_key
   WHERE btrim(angle_key) <> '';

  IF cardinality(v_required_angles) = 0 THEN
    RAISE EXCEPTION 'submit_fieldops_vehicle_photos_v1 requires at least one configured vehicle photo angle'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_paths) <> 'object' THEN
    RAISE EXCEPTION 'submit_fieldops_vehicle_photos_v1 requires angle_paths object'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(angle_key), ARRAY[]::TEXT[])
    INTO v_missing_angles
    FROM unnest(v_required_angles) AS angle_key
   WHERE btrim(COALESCE(v_paths->>angle_key, '')) = '';

  IF cardinality(v_missing_angles) > 0 THEN
    RAISE EXCEPTION 'submit_fieldops_vehicle_photos_v1 missing configured angle paths: %', array_to_string(v_missing_angles, ',')
      USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_vehicle_photos', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    SELECT p.id, p.angle_paths
      INTO v_existing_photo_set_id, v_existing_paths
      FROM public.fieldops_v2_vehicle_photos p
     WHERE p.organization_id = v_org
       AND p.user_id = v_user_id
       AND p.decision_log_id = v_existing
     LIMIT 1;

    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'photo_set_id', v_existing_photo_set_id,
      'angle_paths', COALESCE(v_existing_paths, v_paths),
      'required_angles', to_jsonb(v_required_angles),
      'photo_count', cardinality(v_required_angles)
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_vehicle_photos',
    p_resource_type       := 'fieldops_v2_vehicle_photos',
    p_resource_id         := v_photo_set_id,
    p_decision_point      := 'submit_vehicle_photos',
    p_decision_outcome    := 'submitted',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_build_object(
                               'angle_paths', v_paths,
                               'required_angles', to_jsonb(v_required_angles),
                               'actor_user_id', v_user_id
                             ),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_vehicle_photos (
    id, organization_id, user_id, angle_paths, status, decision_log_id, metadata
  ) VALUES (
    v_photo_set_id, v_org, v_user_id, v_paths, 'submitted', v_decision_id,
    jsonb_build_object(
      'correlation_id', p_idempotency_key,
      'required_angles', to_jsonb(v_required_angles)
    )
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'submitted',
    'photo_set_id', v_photo_set_id,
    'angle_paths', v_paths,
    'required_angles', to_jsonb(v_required_angles),
    'photo_count', cardinality(v_required_angles)
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_vehicle_photos_v1(JSONB, UUID) IS
  'Mobile V2 vehicle photo write. Requires evidence paths for row-driven vehicle_photo_angles and is idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_vehicle_photos_v1(JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_vehicle_photos_v1(JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_vehicle_photos_v1(
  p_angle_paths JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_vehicle_photos_v1(p_angle_paths, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_vehicle_photos_v1(JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_vehicle_photos_v1(JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_onboarding_readback_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_active_role TEXT := COALESCE(NULLIF(btrim(p_active_role), ''), 'driver');
  v_shift_id TEXT := NULLIF(btrim(COALESCE(p_context->>'shift_id', '')), '');
  v_docs JSONB := '[]'::jsonb;
  v_latest_doc JSONB := NULL;
  v_vehicle JSONB := NULL;
  v_vehicle_photos JSONB := NULL;
  v_cleaning JSONB := NULL;
  v_pre_shift JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_policy_has_required_documents BOOLEAN := FALSE;
  v_required_documents TEXT[] := ARRAY[]::TEXT[];
  v_vehicle_photo_angles TEXT[] := ARRAY[]::TEXT[];
  v_docs_uploaded_count INT := 0;
  v_required_documents_satisfied_count INT := 0;
  v_vehicle_submitted BOOLEAN := FALSE;
  v_vehicle_photos_submitted BOOLEAN := FALSE;
  v_cleaning_cadence_hours INT := 24;
  v_cleaning_item_ids TEXT[] := ARRAY[]::TEXT[];
  v_cleaning_attested BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_onboarding_readback_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_onboarding_readback_v1 requires organization context'
      USING ERRCODE = '42501';
  END IF;

  SELECT public.resolve_settings('mobile_pre_shift_gate_policy', 'tenant', v_org)
    INTO v_policy;
  IF v_policy IS NULL THEN
    SELECT public.resolve_settings('mobile_pre_shift_gate_policy', 'global', NULL)
      INTO v_policy;
  END IF;
  v_policy := COALESCE(v_policy, '{}'::jsonb);

  IF v_policy ? 'required_documents'
     AND jsonb_typeof(v_policy->'required_documents') = 'array' THEN
    v_policy_has_required_documents := TRUE;
    SELECT COALESCE(array_agg(doc_key), ARRAY[]::TEXT[])
      INTO v_required_documents
      FROM jsonb_array_elements_text(v_policy->'required_documents') AS doc_key;
  END IF;

  IF v_policy ? 'vehicle_photo_angles'
     AND jsonb_typeof(v_policy->'vehicle_photo_angles') = 'array' THEN
    SELECT COALESCE(array_agg(angle_key), ARRAY[]::TEXT[])
      INTO v_vehicle_photo_angles
      FROM jsonb_array_elements_text(v_policy->'vehicle_photo_angles') AS angle_key;
  END IF;

  IF COALESCE(v_policy->>'cleaning_cadence_hours', '') ~ '^[0-9]+$' THEN
    v_cleaning_cadence_hours := GREATEST(1, (v_policy->>'cleaning_cadence_hours')::INT);
  END IF;

  IF v_policy ? 'cleaning_items'
     AND jsonb_typeof(v_policy->'cleaning_items') = 'array' THEN
    SELECT COALESCE(array_agg(item_id), ARRAY[]::TEXT[])
      INTO v_cleaning_item_ids
      FROM (
        SELECT btrim(
                 CASE jsonb_typeof(item.value)
                   WHEN 'object' THEN COALESCE(item.value->>'id', '')
                   ELSE COALESCE(item.value #>> '{}', '')
                 END
               ) AS item_id
          FROM jsonb_array_elements(v_policy->'cleaning_items') AS item(value)
      ) normalized
     WHERE item_id <> '';
  END IF;

  WITH ranked_docs AS (
    SELECT
      d.*,
      dl.correlation_id,
      dl.decision_outcome,
      dl.decision_inputs,
      dl."timestamp" AS decided_at,
      row_number() OVER (
        PARTITION BY d.doc_key
        ORDER BY d.created_at DESC, d.id DESC
      ) AS rn
    FROM public.fieldops_v2_kyc_docs d
    JOIN public.decision_log dl
      ON dl.id = d.decision_log_id
     AND dl.organization_id = d.organization_id
     AND dl.decision_category = 'fieldops_kyc_doc'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
    WHERE d.organization_id = v_org
      AND d.user_id = v_user_id
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'doc_id', id,
               'doc_key', doc_key,
               'status', status,
               'decision_log_id', decision_log_id,
               'state', COALESCE(decision_outcome, status),
               'storage_path', storage_path,
               'correlation_id', correlation_id,
               'submitted_at', created_at,
               'decided_at', decided_at
             )
             ORDER BY created_at DESC, id DESC
           ),
           '[]'::jsonb
         )
    INTO v_docs
    FROM ranked_docs
   WHERE rn = 1;

  SELECT value
    INTO v_latest_doc
    FROM jsonb_array_elements(v_docs) value
   ORDER BY COALESCE(value->>'submitted_at', '') DESC, COALESCE(value->>'doc_id', '') DESC
   LIMIT 1;

  v_docs_uploaded_count := jsonb_array_length(v_docs);

  SELECT jsonb_build_object(
           'vehicle_id', v.id,
           'plate', v.plate,
           'vin', v.vin,
           'year', v.year,
           'model', v.model,
           'status', v.status,
           'state', COALESCE(dl.decision_outcome, v.status),
           'decision_log_id', v.decision_log_id,
           'istimara_path', v.istimara_storage_path,
           'correlation_id', dl.correlation_id,
           'submitted_at', v.created_at,
           'decided_at', dl."timestamp"
         )
    INTO v_vehicle
    FROM public.fieldops_v2_vehicles v
    JOIN public.decision_log dl
      ON dl.id = v.decision_log_id
     AND dl.organization_id = v.organization_id
     AND dl.decision_category = 'fieldops_kyc_vehicle'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
   WHERE v.organization_id = v_org
     AND v.user_id = v_user_id
   ORDER BY v.created_at DESC, v.id DESC
   LIMIT 1;

  v_vehicle_submitted := COALESCE(v_vehicle->>'state', v_vehicle->>'status', '') IN ('submitted', 'uploaded', 'approved', 'verified', 'cleared');

  SELECT jsonb_build_object(
           'photo_set_id', p.id,
           'angle_paths', p.angle_paths,
           'captured_angle_ids', COALESCE((
             SELECT jsonb_agg(angle_key ORDER BY angle_key)
               FROM jsonb_object_keys(p.angle_paths) AS angle_key
           ), '[]'::jsonb),
           'photo_count', COALESCE((
             SELECT COUNT(*)::INT
               FROM jsonb_object_keys(p.angle_paths)
           ), 0),
           'state', COALESCE(dl.decision_outcome, p.status),
           'decision_log_id', p.decision_log_id,
           'correlation_id', dl.correlation_id,
           'submitted_at', p.created_at,
           'decided_at', dl."timestamp"
         )
    INTO v_vehicle_photos
    FROM public.fieldops_v2_vehicle_photos p
    JOIN public.decision_log dl
      ON dl.id = p.decision_log_id
     AND dl.organization_id = p.organization_id
     AND dl.decision_category = 'fieldops_vehicle_photos'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
   WHERE p.organization_id = v_org
     AND p.user_id = v_user_id
   ORDER BY p.created_at DESC, p.id DESC
   LIMIT 1;

  IF cardinality(v_vehicle_photo_angles) > 0 THEN
    SELECT COALESCE(
             bool_and(
               COALESCE(v_vehicle_photos->'angle_paths'->>angle_key, '') <> ''
             ),
             FALSE
           )
      INTO v_vehicle_photos_submitted
      FROM unnest(v_vehicle_photo_angles) AS angle_key;
  END IF;

  v_vehicle_photos_submitted :=
    v_vehicle_photos_submitted
    AND COALESCE(v_vehicle_photos->>'state', '') IN ('submitted', 'uploaded', 'approved', 'verified', 'cleared');

  SELECT COUNT(*)::INT
    INTO v_required_documents_satisfied_count
    FROM unnest(v_required_documents) AS required_doc(doc_key)
   WHERE CASE required_doc.doc_key
           WHEN 'national_id' THEN EXISTS (
             SELECT 1
               FROM jsonb_array_elements(v_docs) doc
              WHERE doc->>'doc_key' IN ('idDoc', 'iqamaDoc', 'national_id')
                AND COALESCE(doc->>'state', doc->>'status', '') IN ('uploaded', 'submitted', 'approved', 'verified', 'cleared')
           )
           WHEN 'driving_licence' THEN EXISTS (
             SELECT 1
               FROM jsonb_array_elements(v_docs) doc
              WHERE doc->>'doc_key' IN ('licenseDoc', 'driving_licence')
                AND COALESCE(doc->>'state', doc->>'status', '') IN ('uploaded', 'submitted', 'approved', 'verified', 'cleared')
           )
           WHEN 'iqama' THEN EXISTS (
             SELECT 1
               FROM jsonb_array_elements(v_docs) doc
              WHERE doc->>'doc_key' IN ('iqamaDoc', 'iqama')
                AND COALESCE(doc->>'state', doc->>'status', '') IN ('uploaded', 'submitted', 'approved', 'verified', 'cleared')
           )
           WHEN 'vehicle_registration' THEN v_vehicle_submitted
           WHEN 'vehicle_photos' THEN v_vehicle_photos_submitted
           ELSE EXISTS (
             SELECT 1
               FROM jsonb_array_elements(v_docs) doc
              WHERE doc->>'doc_key' = required_doc.doc_key
                AND COALESCE(doc->>'state', doc->>'status', '') IN ('uploaded', 'submitted', 'approved', 'verified', 'cleared')
           )
         END;

  SELECT jsonb_build_object(
           'check_id', c.id,
           'checked_ids', to_jsonb(c.checked_item_ids),
           'item_count', cardinality(c.checked_item_ids),
           'photo_path', c.photo_storage_path,
           'state', COALESCE(dl.decision_outcome, 'attested'),
           'decision_log_id', c.decision_log_id,
           'correlation_id', dl.correlation_id,
           'submitted_at', c.created_at,
           'decided_at', dl."timestamp"
         )
    INTO v_cleaning
    FROM public.fieldops_v2_cleaning_checks c
    JOIN public.decision_log dl
      ON dl.id = c.decision_log_id
     AND dl.organization_id = c.organization_id
     AND dl.decision_category = 'fieldops_cleaning_check'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
   WHERE c.organization_id = v_org
     AND c.user_id = v_user_id
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT 1;

  v_cleaning_attested :=
    COALESCE(v_cleaning->>'state', '') IN ('attested', 'cleared')
    AND COALESCE(v_cleaning->>'photo_path', '') <> ''
    AND CASE
          WHEN cardinality(v_cleaning_item_ids) > 0 THEN (
            SELECT COALESCE(
                     bool_and(COALESCE(v_cleaning->'checked_ids', '[]'::jsonb) ? item_key),
                     FALSE
                   )
              FROM unnest(v_cleaning_item_ids) AS item_key
          )
          ELSE COALESCE((v_cleaning->>'item_count')::INT, 0) > 0
        END
    AND COALESCE((v_cleaning->>'submitted_at')::TIMESTAMPTZ, '-infinity'::TIMESTAMPTZ)
      >= now() - make_interval(hours => v_cleaning_cadence_hours);

  SELECT jsonb_build_object(
           'pass_id', p.id,
           'shift_id', p.shift_id,
           'health_ok', p.health_ok,
           'state', COALESCE(dl.decision_outcome, CASE WHEN p.health_ok THEN 'cleared' ELSE 'blocked_health' END),
           'decision_log_id', p.decision_log_id,
           'correlation_id', dl.correlation_id,
           'submitted_at', p.created_at,
           'decided_at', dl."timestamp"
         )
    INTO v_pre_shift
    FROM public.fieldops_v2_pre_shift_passes p
    JOIN public.decision_log dl
      ON dl.id = p.decision_log_id
     AND dl.organization_id = p.organization_id
     AND dl.decision_category = 'fieldops_pre_shift_gate'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
   WHERE p.organization_id = v_org
     AND p.user_id = v_user_id
     AND (v_shift_id IS NULL OR p.shift_id = v_shift_id)
   ORDER BY p.created_at DESC, p.id DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'active_role', v_active_role,
    'organization_id', v_org,
    'user_id', v_user_id,
    'shift_id', v_shift_id,
    'documents', v_docs,
    'latest_doc', v_latest_doc,
    'latest_vehicle', v_vehicle,
    'latest_vehicle_photos', v_vehicle_photos,
    'latest_cleaning', v_cleaning,
    'latest_pre_shift', v_pre_shift,
    'policy', COALESCE(v_policy, '{}'::jsonb),
    'requirements', jsonb_build_object(
      'docs_uploaded_count', v_docs_uploaded_count,
      'required_documents_count', cardinality(v_required_documents),
      'required_documents_satisfied_count', v_required_documents_satisfied_count,
      'docs_complete', v_policy_has_required_documents AND (
        cardinality(v_required_documents) = 0
        OR v_required_documents_satisfied_count = cardinality(v_required_documents)
      ),
      'vehicle_submitted', v_vehicle_submitted,
      'vehicle_photos_submitted', v_vehicle_photos_submitted,
      'required_vehicle_photo_count', cardinality(v_vehicle_photo_angles),
      'cleaning_attested', v_cleaning_attested,
      'required_cleaning_item_count', cardinality(v_cleaning_item_ids),
      'pre_shift_cleared', COALESCE(v_pre_shift->>'state', '') = 'cleared',
      'cleaning_required', NOT v_cleaning_attested
    )
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_onboarding_readback_v1(TEXT, JSONB) IS
  'Mobile V2 onboarding/readiness readback for KYC, vehicle, cleaning, and pre-shift writes. Returns latest current-user rows verified through decision_log for same-context mobile reconciliation.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_onboarding_readback_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_onboarding_readback_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_onboarding_readback_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_onboarding_readback_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_onboarding_readback_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_onboarding_readback_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_fieldops_cleaning_check_v1(
  p_checked_ids TEXT[],
  p_photo_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_path TEXT := NULLIF(btrim(COALESCE(p_photo_path, '')), '');
  v_existing UUID;
  v_decision_id UUID;
  v_check_id UUID := gen_random_uuid();
  v_count INT;
  v_policy JSONB := '{}'::jsonb;
  v_required_ids TEXT[] := ARRAY[]::TEXT[];
  v_missing_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_checked_ids IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires checked_ids' USING ERRCODE = '22023';
  END IF;
  v_count := COALESCE(array_length(p_checked_ids, 1), 0);
  IF v_count < 1 THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1: checked_ids must contain at least 1 item' USING ERRCODE = '22023';
  END IF;
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires photo_path' USING ERRCODE = '22023';
  END IF;

  SELECT public.resolve_settings('mobile_pre_shift_gate_policy', 'tenant', v_org)
    INTO v_policy;
  IF v_policy IS NULL THEN
    SELECT public.resolve_settings('mobile_pre_shift_gate_policy', 'global', NULL)
      INTO v_policy;
  END IF;
  v_policy := COALESCE(v_policy, '{}'::jsonb);

  IF v_policy ? 'cleaning_items'
     AND jsonb_typeof(v_policy->'cleaning_items') = 'array' THEN
    SELECT COALESCE(array_agg(item_id), ARRAY[]::TEXT[])
      INTO v_required_ids
      FROM (
        SELECT btrim(
                 CASE jsonb_typeof(item.value)
                   WHEN 'object' THEN COALESCE(item.value->>'id', '')
                   ELSE COALESCE(item.value #>> '{}', '')
                 END
               ) AS item_id
          FROM jsonb_array_elements(v_policy->'cleaning_items') AS item(value)
      ) normalized
     WHERE item_id <> '';
  END IF;

  IF cardinality(v_required_ids) = 0 THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires row-driven cleaning_items policy' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(item_id), ARRAY[]::TEXT[])
    INTO v_missing_ids
    FROM unnest(v_required_ids) AS item_id
   WHERE NOT (item_id = ANY(p_checked_ids));

  IF cardinality(v_missing_ids) > 0 THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 missing configured cleaning items: %', array_to_string(v_missing_ids, ',')
      USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_cleaning_check', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'item_count', v_count
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'fieldops_cleaning_check',
    p_resource_type := 'fieldops_v2_cleaning_check',
    p_resource_id := v_check_id,
    p_decision_point := 'record_cleaning',
    p_decision_outcome := 'attested',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id := p_idempotency_key,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'checked_ids', to_jsonb(p_checked_ids),
      'item_count', v_count,
      'photo_path', v_path,
      'actor_user_id', v_user_id,
      'required_cleaning_items', to_jsonb(v_required_ids)
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_cleaning_checks (
    id, organization_id, user_id, checked_item_ids, photo_storage_path,
    decision_log_id, metadata
  ) VALUES (
    v_check_id, v_org, v_user_id, p_checked_ids, v_path, v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key, 'required_cleaning_items', to_jsonb(v_required_ids))
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'attested',
    'check_id', v_check_id,
    'item_count', v_count
  );
END;
$$;

COMMENT ON FUNCTION public.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) IS
  'Mobile V2 daily cleaning attestation write. Requires all row-driven cleaning_items and a non-empty photo_path. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pass_fieldops_pre_shift_gate_v1(
  p_shift_id TEXT,
  p_health_ok BOOLEAN,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_shift TEXT := NULLIF(btrim(COALESCE(p_shift_id, '')), '');
  v_existing UUID;
  v_decision_id UUID;
  v_pass_id UUID := gen_random_uuid();
  v_readback JSONB;
  v_requirements JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires shift_id' USING ERRCODE = '22023';
  END IF;
  IF p_health_ok IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires health_ok' USING ERRCODE = '22023';
  END IF;

  IF p_health_ok THEN
    v_readback := public.resolve_fieldops_onboarding_readback_v1(
      'driver',
      jsonb_build_object('shift_id', v_shift)
    );
    v_requirements := COALESCE(v_readback->'requirements', '{}'::jsonb);
    IF COALESCE((v_requirements->>'docs_complete')::BOOLEAN, FALSE) IS NOT TRUE
       OR COALESCE((v_requirements->>'vehicle_submitted')::BOOLEAN, FALSE) IS NOT TRUE
       OR COALESCE((v_requirements->>'vehicle_photos_submitted')::BOOLEAN, FALSE) IS NOT TRUE
       OR COALESCE((v_requirements->>'cleaning_attested')::BOOLEAN, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires completed Mobile V2 onboarding and cleaning readiness before clearance'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_pre_shift_gate', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'shift_id', v_shift
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'fieldops_pre_shift_gate',
    p_resource_type := 'fieldops_v2_pre_shift_pass',
    p_resource_id := v_pass_id,
    p_decision_point := 'pass_pre_shift',
    p_decision_outcome := CASE WHEN p_health_ok THEN 'cleared' ELSE 'blocked_health' END,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id := p_idempotency_key,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'shift_id', v_shift,
      'health_ok', p_health_ok,
      'actor_user_id', v_user_id,
      'readiness_requirements', v_requirements
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_pre_shift_passes (
    id, organization_id, user_id, shift_id, health_ok, decision_log_id, metadata
  ) VALUES (
    v_pass_id, v_org, v_user_id, v_shift, p_health_ok, v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', CASE WHEN p_health_ok THEN 'cleared' ELSE 'blocked' END,
    'pass_id', v_pass_id,
    'shift_id', v_shift,
    'health_ok', p_health_ok
  );
END;
$$;

COMMENT ON FUNCTION public.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) IS
  'Mobile V2 pre-shift gate write. Health failures remain auditable as blocked_health, and health-ok clearance is fail-closed until onboarding, vehicle photos, and cleaning readiness are backend-confirmed.';

REVOKE ALL ON FUNCTION public.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605281100_fieldops_mobile_v2_onboarding_readback_v1'));
COMMIT;
