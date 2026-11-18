BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('f148_vehicle_create_registry_v1'));
INSERT INTO public.settings_category_registry(category,description,requires_schema,requires_global_default,allowed_scopes)
VALUES('vehicle_create_form_v1','Vehicle creation form schema',true,false,'["global"]'::jsonb)
ON CONFLICT(category) DO NOTHING;
INSERT INTO public.schema_registry(category,version,schema,description,is_active)
SELECT 'vehicle_create_form_v1',1,$schema${
 "type":"object","additionalProperties":false,"required":["plate_number"],
 "properties":{
  "plate_number":{"type":"string","minLength":1,"title":"Plate number"},
  "vehicle_type_id":{"type":"string","title":"Vehicle type","x-ui":{"widget":"resource_select","resource":"vehicle_create_type_directory","label_column":"name","filters":{"is_active":true}}},
  "branch_id":{"type":"string","title":"Branch","x-ui":{"widget":"resource_select","resource":"vehicle_create_branch_directory","label_column":"name"}},
  "vin":{"type":"string","title":"VIN"},"make":{"type":"string","title":"Make"},
  "model":{"type":"string","title":"Model"},"model_year":{"type":"integer","title":"Model year"},
  "color":{"type":"string","title":"Color"},"acquired_at":{"type":"string","format":"date-time","title":"Acquired at"},
  "metadata":{"type":"object","title":"Metadata","additionalProperties":true}
 }
}$schema$::jsonb,'Canonical create vehicle inputs; status remains the canonical lookup default',true
WHERE NOT EXISTS(SELECT 1 FROM public.schema_registry WHERE category='vehicle_create_form_v1');

CREATE OR REPLACE VIEW public.vehicle_create_form_schema_v1
WITH (security_invoker=true) AS
SELECT id,category,version,schema,is_active FROM public.schema_registry
WHERE category='vehicle_create_form_v1';
REVOKE ALL ON public.vehicle_create_form_schema_v1 FROM PUBLIC,anon;
GRANT SELECT ON public.vehicle_create_form_schema_v1 TO authenticated,service_role;

DO $registry$
DECLARE r RECORD; cat TEXT; list_key TEXT; additions JSONB; items JSONB; item JSONB; next_value JSONB; n INT;
BEGIN
 -- Follow canonical settings version-before-cache lock order; preserve every existing own-key override.
 FOREACH cat IN ARRAY ARRAY['ui_read_registry','ui_command_registry'] LOOP
  list_key:=CASE cat WHEN 'ui_read_registry' THEN 'resources' ELSE 'commands' END;
  additions:=CASE cat WHEN 'ui_read_registry' THEN $resources$[
   {"key":"vehicle_create_form_schema","label":"Vehicle create form","relation":"public.vehicle_create_form_schema_v1","allow_view_relation":true,"id_column":"id","capability_read":"fleet.read","select":["id","category","version","schema","is_active"],"filters":[{"key":"category","column":"category","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}],"default_sort":{"column":"version","direction":"desc"}},
   {"key":"vehicle_create_type_directory","label":"Vehicle types","relation":"public.vehicle_types","id_column":"id","capability_read":"fleet.read","read_scope_types":["tenant","platform"],"scope_columns":{"tenant":"organization_id"},"select":["id","name","organization_id","is_active"],"filters":[{"key":"organization_id","column":"organization_id","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}],"default_sort":{"column":"name","direction":"asc"}},
   {"key":"vehicle_create_branch_directory","label":"Branches","relation":"public.branches","id_column":"id","capability_read":"fleet.read","read_scope_types":["tenant","platform"],"scope_columns":{"tenant":"organization_id"},"select":["id","name","organization_id"],"filters":[{"key":"organization_id","column":"organization_id","op":"eq"}],"default_sort":{"column":"name","direction":"asc"}}
  ]$resources$::jsonb ELSE $commands$[
   {"key":"vehicles.create","label":"New vehicle","description":"Create a vehicle in the selected tenant.","capability":"fleet.write","schema_category":"vehicle_create_form_v1","selection":{"mode":"none","max_count":0},"execution":{"type":"navigate"},"route_targets":{"console":{"path":"/fleet/vehicles/new"}}}
  ]$commands$::jsonb END;
  PERFORM 1 FROM public.settings_versions WHERE category=cat AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Approved registry baseline missing: %',cat; END IF;
  FOR r IN SELECT s.scope_type,s.scope_id,s.cached_value,sv.value,sv.schema_version,sv.approved_at,sv.effective_until,
    sv.category AS version_category,sv.scope_type AS version_scope_type,sv.scope_id AS version_scope_id
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category=cat ORDER BY s.id FOR UPDATE OF s LOOP
   IF r.cached_value IS DISTINCT FROM r.value OR r.approved_at IS NULL OR r.effective_until IS NOT NULL
     OR r.version_category IS DISTINCT FROM cat OR r.version_scope_type IS DISTINCT FROM r.scope_type
     OR r.version_scope_id IS DISTINCT FROM r.scope_id THEN RAISE EXCEPTION 'Registry authority mismatch: %',cat; END IF;
   IF jsonb_typeof(r.value->list_key) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Malformed registry: %',cat; END IF;
   items:=r.value->list_key;
   FOR item IN SELECT value FROM jsonb_array_elements(additions) LOOP
    SELECT count(*) INTO n FROM jsonb_array_elements(items) e WHERE e->>'key'=item->>'key';
    IF n>1 THEN RAISE EXCEPTION 'Duplicate registry key: %',item->>'key'; END IF;
    IF n=0 THEN items:=items||jsonb_build_array(item); END IF;
   END LOOP;
   next_value:=jsonb_set(r.value,ARRAY[list_key],items);
   IF next_value IS DISTINCT FROM r.value THEN
    PERFORM public.upsert_settings_value_v1(cat,r.scope_type,r.scope_id,next_value,r.schema_version,'Restore selected-tenant vehicle creation pickers');
   END IF;
  END LOOP;
 END LOOP;
END;
$registry$;
COMMIT;
