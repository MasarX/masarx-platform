BEGIN;
SELECT pg_advisory_lock(hashtext('20260914006000_final_db_qualification_repairs_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_user_devices__active_role_id__fk
  ON public.user_devices(active_role_id);

INSERT INTO public.rbac_role_template_permissions(role_template_id, permission_id, metadata)
SELECT rt.id, lv.id, '{"seed":true,"source":"final_db_qualification_repairs_v1"}'::jsonb
FROM public.rbac_role_templates rt
JOIN public.lookup_definitions ld ON ld.category = 'rbac_permission'
JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
WHERE rt.key = 'super_admin'
  AND lv.status = 'active'
ON CONFLICT(role_template_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ui_list_shipment_pod_assets_v1(
  p_shipment_id UUID
)
RETURNS TABLE (
  shipment_id UUID,
  shipment_action_id UUID,
  artifact_id UUID,
  asset_kind TEXT,
  label TEXT,
  file_name TEXT,
  mime_type TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_shipment JSONB := NULL;
  v_shipment_org UUID := NULL;
BEGIN
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'ui_list_shipment_pod_assets_v1 requires shipment_id';
  END IF;

  v_shipment := public.ui_get_resource_v1('shipments', p_shipment_id);
  IF v_shipment IS NULL THEN
    RETURN;
  END IF;
  v_shipment_org := (v_shipment->>'organization_id')::uuid;

  RETURN QUERY
  WITH pod_actions AS (
    SELECT
      sa.id,
      sa.timestamp,
      sa.created_at,
      COALESCE(
        sa.action_data #>> ARRAY['delivery_completion', 'signature_artifact_id'],
        sa.action_data #>> ARRAY['task_event_payload', 'pod', 'signature_artifact_id'],
        sa.action_data #>> ARRAY['task_event_payload', 'signature_artifact_id'],
        sa.action_data #>> ARRAY['pod', 'signature_artifact_id'],
        sa.action_data ->> 'signature_artifact_id'
      ) AS signature_artifact_id
    FROM public.shipment_actions sa
    WHERE sa.shipment_id = p_shipment_id
      AND sa.organization_id = v_shipment_org
      AND (
        sa.delivery_completion_kind IS NOT NULL
        OR sa.handover_mode IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM public.artifact_links al
          WHERE al.organization_id = sa.organization_id
            AND al.resource_type = 'shipment_action'
            AND al.resource_id = sa.id
            AND al.relation_type = 'pod'
        )
      )
  ),
  asset_rows AS (
    SELECT DISTINCT ON (al.artifact_id)
      p_shipment_id AS shipment_id,
      pa.id AS shipment_action_id,
      al.artifact_id,
      CASE
        WHEN al.artifact_id::text = pa.signature_artifact_id THEN 'signature'
        WHEN COALESCE(a.mime_type, '') ILIKE 'image/%' THEN 'photo'
        ELSE 'file'
      END AS asset_kind,
      CASE
        WHEN al.artifact_id::text = pa.signature_artifact_id THEN 'Recipient signature'
        WHEN COALESCE(a.mime_type, '') ILIKE 'image/%' THEN 'Proof photo'
        ELSE 'Proof attachment'
      END AS label,
      COALESCE(
        NULLIF(btrim(COALESCE(a.metadata->>'file_name', '')), ''),
        NULLIF(btrim(COALESCE(a.metadata->>'original_file_name', '')), ''),
        regexp_replace(a.storage_key, '^.*/', '')
      ) AS file_name,
      a.mime_type,
      al.created_at
    FROM pod_actions pa
    JOIN public.artifact_links al
      ON al.organization_id = v_shipment_org
     AND al.resource_type = 'shipment_action'
     AND al.resource_id = pa.id
     AND al.relation_type = 'pod'
    JOIN public.artifacts a
      ON a.id = al.artifact_id
     AND a.organization_id = al.organization_id
    ORDER BY al.artifact_id, pa.timestamp DESC, pa.created_at DESC, al.created_at DESC
  )
  SELECT
    asset_rows.shipment_id,
    asset_rows.shipment_action_id,
    asset_rows.artifact_id,
    asset_rows.asset_kind,
    asset_rows.label,
    asset_rows.file_name,
    asset_rows.mime_type,
    asset_rows.created_at
  FROM asset_rows
  ORDER BY
    CASE asset_rows.asset_kind
      WHEN 'signature' THEN 0
      WHEN 'photo' THEN 1
      ELSE 2
    END,
    asset_rows.created_at DESC,
    asset_rows.artifact_id;
END;
$function$;

COMMENT ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID)
  IS 'List proof-of-delivery artifacts for a caller-visible shipment via canonical shipment_action artifact_links.';

REVOKE ALL ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_get_shipment_pod_asset_download_v1(
  p_shipment_id UUID,
  p_artifact_id UUID
)
RETURNS TABLE (
  storage_bucket TEXT,
  storage_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  asset_kind TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_shipment JSONB := NULL;
  v_shipment_org UUID := NULL;
BEGIN
  IF p_shipment_id IS NULL OR p_artifact_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_shipment_pod_asset_download_v1 requires shipment_id and artifact_id';
  END IF;

  v_shipment := public.ui_get_resource_v1('shipments', p_shipment_id);
  IF v_shipment IS NULL THEN
    RAISE EXCEPTION 'ui_get_shipment_pod_asset_download_v1 artifact % is not available for shipment %', p_artifact_id, p_shipment_id
      USING ERRCODE = 'P0002';
  END IF;
  v_shipment_org := (v_shipment->>'organization_id')::uuid;

  RETURN QUERY
  SELECT
    a.storage_bucket,
    a.storage_key,
    assets.file_name,
    assets.mime_type,
    assets.asset_kind
  FROM public.ui_list_shipment_pod_assets_v1(p_shipment_id) AS assets
  JOIN public.artifacts a
    ON a.id = assets.artifact_id
   AND a.organization_id = v_shipment_org
  WHERE assets.artifact_id = p_artifact_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_get_shipment_pod_asset_download_v1 artifact % is not available for shipment %', p_artifact_id, p_shipment_id
      USING ERRCODE = 'P0002';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID)
  IS 'Resolve the canonical storage bucket/key for a caller-visible proof-of-delivery artifact linked to a shipment.';

REVOKE ALL ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('20260914006000_final_db_qualification_repairs_v1'));
COMMIT;
