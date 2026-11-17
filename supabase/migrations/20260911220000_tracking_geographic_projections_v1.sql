BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL search_path TO public,extensions,pg_temp;
SELECT pg_advisory_xact_lock(hashtext('20260911220000_tracking_geographic_projections_v1'));

-- These views also enforce JWT-derived actor scope because the canonical registry
-- reader is SECURITY DEFINER. security_invoker alone would not enforce caller RLS
-- when invoked by that reader. No SQL-role-based service bypass is introduced.
CREATE VIEW public.tracking_geocode_pins_v1 WITH (security_invoker=true) AS
SELECT g.id::text || ':' || g.address_id::text AS id,
 g.address_id,a.organization_id,a.client_id,
 public.current_user_sender_id() AS scope_sender_id,
 ST_Y(g.coordinates::geometry) AS latitude,
 ST_X(g.coordinates::geometry) AS longitude,
 NULL::text AS label,NULL::text AS source
FROM public.geocodes g
JOIN public.addresses a ON a.id=g.address_id AND a.client_id=g.client_id
 AND a.organization_id=g.organization_id
WHERE g.organization_id=public.current_user_org_id()
 AND public.user_has_resource_capability_v1('addresses','read')
 AND (public.is_platform_user()
  OR (public.current_user_scope_type()='tenant' AND a.organization_id=public.current_user_org_id())
  OR (public.current_user_scope_type()='client' AND a.client_id=public.current_user_client_id())
  OR (public.current_user_scope_type()='sender'
   AND public.user_has_resource_capability_v1('shipments','read') AND EXISTS (
   SELECT 1 FROM public.shipments s WHERE s.sender_id=public.current_user_sender_id()
    AND s.client_id=a.client_id AND s.organization_id=a.organization_id
    AND (s.origin_address_id=a.id OR s.destination_address_id=a.id))))
 AND g.coordinates IS NOT NULL;

CREATE VIEW public.tracking_address_pins_v1 WITH (security_invoker=true) AS
SELECT a.id::text || ':' || a.client_id::text AS id,
 a.id AS address_id,a.organization_id,a.client_id,
 public.current_user_sender_id() AS scope_sender_id,
 ST_Y(a.coordinates::geometry) AS latitude,
 ST_X(a.coordinates::geometry) AS longitude,
 concat_ws(', ',NULLIF(a.district,''),NULLIF(a.city,'')) AS label,
 'neutral'::text AS tone
FROM public.addresses a
WHERE public.user_has_resource_capability_v1('addresses','read')
 AND (public.is_platform_user()
  OR (public.current_user_scope_type()='tenant' AND a.organization_id=public.current_user_org_id())
  OR (public.current_user_scope_type()='client' AND a.client_id=public.current_user_client_id())
  OR (public.current_user_scope_type()='sender'
   AND public.user_has_resource_capability_v1('shipments','read') AND EXISTS (
   SELECT 1 FROM public.shipments s WHERE s.sender_id=public.current_user_sender_id()
    AND s.client_id=a.client_id AND s.organization_id=a.organization_id
    AND (s.origin_address_id=a.id OR s.destination_address_id=a.id))))
 AND a.coordinates IS NOT NULL;

CREATE VIEW public.tracking_shipments_v1 WITH (security_invoker=true) AS
SELECT s.id::text || ':' || s.client_id::text AS id,
 s.organization_id,s.client_id,s.sender_id,
 s.tracking_number,s.status,origin.city AS origin_city,destination.city AS destination_city,
 s.service_type,s.updated_at
FROM public.shipments s
-- An authorized shipment's addresses are visible to its tenant/client/sender only
-- with addresses.read; otherwise city columns remain null, not a capability bypass.
LEFT JOIN public.addresses origin ON origin.id=s.origin_address_id
 AND origin.client_id=s.client_id AND origin.organization_id=s.organization_id
 AND public.user_has_resource_capability_v1('addresses','read')
LEFT JOIN public.addresses destination ON destination.id=s.destination_address_id
 AND destination.client_id=s.client_id AND destination.organization_id=s.organization_id
 AND public.user_has_resource_capability_v1('addresses','read')
WHERE public.user_has_resource_capability_v1('shipments','read')
 AND (public.is_platform_user()
  OR (public.current_user_scope_type()='tenant' AND s.organization_id=public.current_user_org_id())
  OR (public.current_user_scope_type()='client' AND s.client_id=public.current_user_client_id())
  OR (public.current_user_scope_type()='sender' AND s.sender_id=public.current_user_sender_id()));

REVOKE ALL ON public.tracking_geocode_pins_v1,public.tracking_address_pins_v1,
 public.tracking_shipments_v1 FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON VIEW public.tracking_geocode_pins_v1 IS
 'Registry-only actor-scoped per-geocode tracking pins; optional donor label/source have no proven canonical equivalence.';
COMMENT ON VIEW public.tracking_address_pins_v1 IS
 'Independent visible coordinate-address dataset; consumers use it only after a successful empty geocode dataset.';
COMMENT ON VIEW public.tracking_shipments_v1 IS
 'Registry-only six-field tracking fallback, preserving shipment and address capability boundaries.';

DO $registry$
DECLARE r RECORD; v_schema INT; v_resources JSONB; v_next JSONB; item JSONB; v_count INT;
 v_new JSONB := '[
 {"key":"tracking_geocode_pins","label":"Tracking geocode pins","relation":"public.tracking_geocode_pins_v1","id_column":"id","capability_read":"addresses.read","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"scope_sender_id"},"read_scope_types":["tenant","client","sender","platform","global"],"select":["id","address_id","latitude","longitude","label","source"],"default_sort":{"column":"id","direction":"asc"}},
 {"key":"tracking_address_pins","label":"Tracking address pins","relation":"public.tracking_address_pins_v1","id_column":"id","capability_read":"addresses.read","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"scope_sender_id"},"read_scope_types":["tenant","client","sender","platform","global"],"select":["id","address_id","latitude","longitude","label","tone"],"default_sort":{"column":"id","direction":"asc"}},
 {"key":"tracking_shipments","label":"Tracking shipments","relation":"public.tracking_shipments_v1","id_column":"id","capability_read":"shipments.read","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"sender_id"},"read_scope_types":["tenant","client","sender","platform","global"],"select":["id","tracking_number","status","origin_city","destination_city","service_type","updated_at"],"default_sort":{"column":"id","direction":"asc"}}
 ]'::jsonb;
BEGIN
 SELECT version INTO STRICT v_schema FROM public.schema_registry
 WHERE category='ui_read_registry' AND is_active;
 -- Same version-before-settings lock order as the canonical upsert helper.
 PERFORM 1 FROM public.settings_versions WHERE category='ui_read_registry'
  AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Approved UI registry baseline missing'; END IF;
 FOR r IN SELECT s.id,s.scope_type,s.scope_id,s.cached_value,sv.value AS version_value,
   sv.approved_at,sv.effective_until,sv.category AS version_category,
   sv.scope_type AS version_scope_type,sv.scope_id AS version_scope_id
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='ui_read_registry' ORDER BY s.id FOR UPDATE OF s LOOP
  IF r.cached_value IS DISTINCT FROM r.version_value THEN
   RAISE EXCEPTION 'UI registry cache/version mismatch';
  END IF;
  IF r.approved_at IS NULL OR r.effective_until IS NOT NULL
   OR r.version_category IS DISTINCT FROM 'ui_read_registry'
   OR r.version_scope_type IS DISTINCT FROM r.scope_type
   OR r.version_scope_id IS DISTINCT FROM r.scope_id THEN
   RAISE EXCEPTION 'UI registry pointed version is not current approved matching scope';
  END IF;
  IF jsonb_typeof(r.cached_value) IS DISTINCT FROM 'object'
   OR jsonb_typeof(r.cached_value->'resources') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Malformed UI registry resources';
  END IF;
  v_resources := r.cached_value->'resources';
  FOR item IN SELECT value FROM jsonb_array_elements(v_new) LOOP
   SELECT count(*) INTO v_count FROM jsonb_array_elements(v_resources) e
    WHERE e->>'key'=item->>'key';
   IF v_count>1 THEN RAISE EXCEPTION 'Duplicate tracking resource %',item->>'key'; END IF;
   -- A pre-existing resource owns all of its configuration, including suppression.
   IF v_count=0 THEN v_resources := v_resources || jsonb_build_array(item); END IF;
  END LOOP;
  v_next := jsonb_set(r.cached_value,'{resources}',v_resources);
  IF v_next IS DISTINCT FROM r.cached_value THEN
   PERFORM public.upsert_settings_value_v1('ui_read_registry',r.scope_type,r.scope_id,
    v_next,v_schema,'Add independent authorized tracking projections without replacing existing resources');
  END IF;
 END LOOP;
END;
$registry$;
COMMIT;
