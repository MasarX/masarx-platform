BEGIN;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(6);
CREATE TEMP TABLE route_window_fixture(kind TEXT,scope_id UUID,settings_id UUID,old_version_id UUID,old_value JSONB,new_version_id UUID);
DO $fixture$
DECLARE base JSONB; version_id INT; kind TEXT; scope UUID; value JSONB; selected JSONB;
BEGIN
 SELECT sv.value,sv.schema_version INTO STRICT base,version_id
 FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
 WHERE s.category='ui_read_registry' AND s.scope_type='global' AND s.scope_id IS NULL;
 FOREACH kind IN ARRAY ARRAY['custom','restricted','collision'] LOOP
  scope:=gen_random_uuid();
  INSERT INTO public.organizations(id,name,slug,billing_status)
   VALUES(scope,'Route window fixture','route-window-'||scope,'active');
  selected:=CASE kind WHEN 'custom' THEN '["planned_start_at"]'::jsonb
   WHEN 'restricted' THEN '["planned_start_at"]'::jsonb
   ELSE '["planned_start_at","planned_window_start_at","id","id"]'::jsonb END;
  SELECT jsonb_set(base,'{resources}',jsonb_agg(
   CASE WHEN e->>'key'='route_stops' THEN
    (e-'read_relation') || jsonb_build_object('relation',CASE WHEN kind='custom' THEN 'public.addresses' ELSE 'api.route_stops' END,'select',selected)
   ELSE e END ORDER BY ord)) INTO value
  FROM jsonb_array_elements(base->'resources') WITH ORDINALITY x(e,ord);
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',scope,value,version_id,'Owned route-window repair fixture');
  INSERT INTO route_window_fixture
   SELECT kind,scope,s.id,s.settings_version_id,sv.value,NULL FROM public.settings s
   JOIN public.settings_versions sv ON sv.id=s.settings_version_id
   WHERE s.category='ui_read_registry' AND s.scope_type='tenant' AND s.scope_id=scope;
 END LOOP;
END;
$fixture$;
DO $repair$
DECLARE r RECORD; item JSONB; resources JSONB; selected JSONB; next_value JSONB;
BEGIN
 PERFORM 1 FROM public.settings_versions WHERE category='ui_read_registry'
  AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 FOR r IN SELECT s.id,s.scope_type,s.scope_id,s.cached_value,sv.value,sv.schema_version,
  sv.category AS version_category,sv.scope_type AS version_scope_type,
  sv.scope_id AS version_scope_id,sv.approved_at,sv.effective_until
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='ui_read_registry' ORDER BY s.id FOR UPDATE OF s LOOP
  IF jsonb_typeof(r.value->'resources') IS DISTINCT FROM 'array' THEN
   CONTINUE; -- No matching resource is established; preserve unrelated malformed state.
  END IF;
  resources := '[]'::jsonb;
  FOR item IN SELECT value FROM jsonb_array_elements(r.value->'resources') LOOP
   IF item->>'key'='route_stops'
    AND COALESCE(NULLIF(btrim(item->>'read_relation'),''),item->>'relation')
      IN ('api.route_stops','public.route_stops_visible_v1')
    AND jsonb_typeof(item->'select')='array'
    AND (item->'select' ?| ARRAY['planned_start_at','planned_end_at']) THEN
    -- Rewrite only known stale names on canonical relations; preserve overrides,
    -- omitted selections and every other field. If a canonical spelling already
    -- exists, remove its stale alias only; do not deduplicate unrelated entries.
    SELECT jsonb_agg(CASE value
      WHEN '"planned_start_at"'::jsonb THEN '"planned_window_start_at"'::jsonb
      WHEN '"planned_end_at"'::jsonb THEN '"planned_window_end_at"'::jsonb ELSE value END ORDER BY ord)
     INTO selected FROM jsonb_array_elements(item->'select') WITH ORDINALITY e(value,ord)
     WHERE NOT (value='"planned_start_at"'::jsonb AND item->'select' ? 'planned_window_start_at')
       AND NOT (value='"planned_end_at"'::jsonb AND item->'select' ? 'planned_window_end_at');
    item := jsonb_set(item,'{select}',selected);
   END IF;
   resources := resources || jsonb_build_array(item);
  END LOOP;
  next_value := jsonb_set(r.value,'{resources}',resources);
  IF next_value IS DISTINCT FROM r.value THEN
   IF r.cached_value IS DISTINCT FROM r.value
    OR r.version_category IS DISTINCT FROM 'ui_read_registry'
    OR r.version_scope_type IS DISTINCT FROM r.scope_type
    OR r.version_scope_id IS DISTINCT FROM r.scope_id
    OR r.approved_at IS NULL OR r.effective_until IS NOT NULL THEN
    RAISE EXCEPTION 'Route-stop repair requires matching current approved registry version';
   END IF;
   PERFORM public.upsert_settings_value_v1('ui_read_registry',r.scope_type,r.scope_id,next_value,
    r.schema_version,'Repair route-stop planned-window selection names on canonical projections');
  END IF;
 END LOOP;
END;
$repair$;
SELECT is((SELECT e->'select' FROM route_window_fixture f JOIN public.settings s ON s.id=f.settings_id,
 jsonb_array_elements(s.cached_value->'resources') e WHERE f.kind='custom' AND e->>'key'='route_stops'),
 '["planned_start_at"]'::jsonb,'custom relation selection remains untouched');
SELECT is((SELECT e->'select' FROM route_window_fixture f JOIN public.settings s ON s.id=f.settings_id,
 jsonb_array_elements(s.cached_value->'resources') e WHERE f.kind='restricted' AND e->>'key'='route_stops'),
 '["planned_window_start_at"]'::jsonb,'restricted selection changes only its stale spelling');
SELECT is((SELECT e->'select' FROM route_window_fixture f JOIN public.settings s ON s.id=f.settings_id,
 jsonb_array_elements(s.cached_value->'resources') e WHERE f.kind='collision' AND e->>'key'='route_stops'),
 '["planned_window_start_at","id","id"]'::jsonb,'induced alias collision removed without deduplicating unrelated entries');
SELECT ok((SELECT count(*)=2 AND bool_and(sv.value=f.old_value AND sv.effective_until IS NOT NULL)
 FROM route_window_fixture f JOIN public.settings_versions sv ON sv.id=f.old_version_id
 WHERE f.kind IN ('restricted','collision')),'changed scopes preserve historical values and close prior versions');
SELECT ok((SELECT count(*)=3 AND bool_and(s.cached_value=sv.value AND
 CASE WHEN f.kind='custom' THEN s.settings_version_id=f.old_version_id ELSE s.settings_version_id<>f.old_version_id END)
 FROM route_window_fixture f JOIN public.settings s ON s.id=f.settings_id
 JOIN public.settings_versions sv ON sv.id=s.settings_version_id),'cache and current version remain synchronized without rewriting custom scope');
UPDATE route_window_fixture f SET new_version_id=s.settings_version_id FROM public.settings s WHERE s.id=f.settings_id;
DO $repair$
DECLARE r RECORD; item JSONB; resources JSONB; selected JSONB; next_value JSONB;
BEGIN
 PERFORM 1 FROM public.settings_versions WHERE category='ui_read_registry'
  AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 FOR r IN SELECT s.id,s.scope_type,s.scope_id,s.cached_value,sv.value,sv.schema_version,
  sv.category AS version_category,sv.scope_type AS version_scope_type,
  sv.scope_id AS version_scope_id,sv.approved_at,sv.effective_until
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='ui_read_registry' ORDER BY s.id FOR UPDATE OF s LOOP
  IF jsonb_typeof(r.value->'resources') IS DISTINCT FROM 'array' THEN
   CONTINUE; -- No matching resource is established; preserve unrelated malformed state.
  END IF;
  resources := '[]'::jsonb;
  FOR item IN SELECT value FROM jsonb_array_elements(r.value->'resources') LOOP
   IF item->>'key'='route_stops'
    AND COALESCE(NULLIF(btrim(item->>'read_relation'),''),item->>'relation')
      IN ('api.route_stops','public.route_stops_visible_v1')
    AND jsonb_typeof(item->'select')='array'
    AND (item->'select' ?| ARRAY['planned_start_at','planned_end_at']) THEN
    -- Rewrite only known stale names on canonical relations; preserve overrides,
    -- omitted selections and every other field. If a canonical spelling already
    -- exists, remove its stale alias only; do not deduplicate unrelated entries.
    SELECT jsonb_agg(CASE value
      WHEN '"planned_start_at"'::jsonb THEN '"planned_window_start_at"'::jsonb
      WHEN '"planned_end_at"'::jsonb THEN '"planned_window_end_at"'::jsonb ELSE value END ORDER BY ord)
     INTO selected FROM jsonb_array_elements(item->'select') WITH ORDINALITY e(value,ord)
     WHERE NOT (value='"planned_start_at"'::jsonb AND item->'select' ? 'planned_window_start_at')
       AND NOT (value='"planned_end_at"'::jsonb AND item->'select' ? 'planned_window_end_at');
    item := jsonb_set(item,'{select}',selected);
   END IF;
   resources := resources || jsonb_build_array(item);
  END LOOP;
  next_value := jsonb_set(r.value,'{resources}',resources);
  IF next_value IS DISTINCT FROM r.value THEN
   IF r.cached_value IS DISTINCT FROM r.value
    OR r.version_category IS DISTINCT FROM 'ui_read_registry'
    OR r.version_scope_type IS DISTINCT FROM r.scope_type
    OR r.version_scope_id IS DISTINCT FROM r.scope_id
    OR r.approved_at IS NULL OR r.effective_until IS NOT NULL THEN
    RAISE EXCEPTION 'Route-stop repair requires matching current approved registry version';
   END IF;
   PERFORM public.upsert_settings_value_v1('ui_read_registry',r.scope_type,r.scope_id,next_value,
    r.schema_version,'Repair route-stop planned-window selection names on canonical projections');
  END IF;
 END LOOP;
END;
$repair$;
SELECT ok((SELECT count(*)=3 AND bool_and(s.settings_version_id=f.new_version_id)
 FROM route_window_fixture f JOIN public.settings s ON s.id=f.settings_id),'second repair creates no redundant versions');
SELECT * FROM finish();
ROLLBACK;
