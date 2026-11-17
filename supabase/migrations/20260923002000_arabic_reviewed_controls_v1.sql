-- Optional, source-verified Arabic labels for reviewed Console and Portal controls.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260923002000_arabic_reviewed_controls_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
DO $seed$
DECLARE
 r record; v jsonb; e jsonb; a jsonb; b jsonb; path text[];
 i int; j int; k int; n int; p int; changed boolean; parent_id text; collection text;
 nav jsonb := '[
 {"app":"portal","kind":"section","id":"home","en":"Home","ar":"الرئيسية"},
 {"app":"portal","kind":"section","id":"shipments","en":"Shipments","ar":"الشحنات"},
 {"app":"portal","kind":"item","section":"shipments","id":"portal-shipments","en":"Shipments","ar":"الشحنات"},
 {"app":"portal","kind":"item","section":"shipments","id":"portal-tracking","en":"Tracking","ar":"التتبع"},
 {"app":"console","kind":"item","section":"workflows","id":"console-commands","en":"Commands","ar":"الأوامر"}]'::jsonb;
 reads jsonb := '[
 {"resource":"shipments","collection":"filters","id":"identifier","en":"Identifier","ar":"المعرّف","column":"id","resolver":"shipment_identifier","op":"eq"},
 {"resource":"dispatch_exception_review","collection":"filters","id":"resource_id","en":null,"ar":"معرّف المورد","column":"resource_id","op":"eq"},
 {"resource":"shipments","collection":"columns","id":"id","en":"Id","ar":"المعرّف"},
 {"resource":"shipments","collection":"columns","id":"organization_id","en":"Organization Id","ar":"معرّف المؤسسة"},
 {"resource":"shipments","collection":"columns","id":"client_id","en":"Client Id","ar":"معرّف العميل"},
 {"resource":"shipments","collection":"columns","id":"sender_id","en":"Sender Id","ar":"معرّف المرسل"},
 {"resource":"shipments","collection":"related","id":"labels","en":"Labels","ar":"الملصقات","filter_key":"shipment_id","from":"id"},
 {"resource":"shipments","collection":"related","id":"label_jobs","en":"Label jobs","ar":"مهام الملصقات","filter_key":"shipment_id","from":"id"},
 {"resource":"shipments","collection":"related","id":"shipment_boxes","en":"Boxes","ar":"الطرود","filter_key":"shipment_id","from":"id"},
 {"resource":"shipments","collection":"related","id":"shipment_actions","en":"Actions","ar":"الإجراءات","filter_key":"shipment_id","from":"id"}]'::jsonb;
 operators jsonb := '[
 {"id":"eq","en":"equals","ar":"يساوي"},
 {"id":"ne","en":"not equal","ar":"لا يساوي"},
 {"id":"ilike","en":"contains","ar":"يحتوي على"}]'::jsonb;
 commands jsonb := '[
 {"id":"shipments.delete","en":"Delete shipments","ar":"حذف الشحنات"},
 {"id":"shipments.print_labels","en":"Print labels","ar":"طباعة الملصقات"},
 {"id":"shipments.resort","en":"Re-sort shipment","ar":"إعادة فرز الشحنة"},
 {"id":"shipments.update_geocode","en":"Requeue geocode","ar":"إعادة جدولة الترميز الجغرافي"},
 {"id":"dispatch_exception_review.complete","en":"Resolve exception","ar":"حل الاستثناء"}]'::jsonb;
BEGIN
 PERFORM 1 FROM public.settings_versions
 WHERE category IN ('ui_navigation','ui_read_registry','ui_filter_operators','ui_command_registry')
 AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 FOR r IN SELECT s.id,s.category,s.scope_type,s.scope_id,s.cached_value,
  sv.value,sv.schema_version,sv.category AS version_category,
  sv.scope_type AS version_scope_type,sv.scope_id AS version_scope_id,
  sv.approved_at,sv.effective_until
 FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
 WHERE s.category IN ('ui_navigation','ui_read_registry','ui_filter_operators','ui_command_registry')
 ORDER BY s.id FOR UPDATE OF s LOOP
  IF r.cached_value IS DISTINCT FROM r.value OR r.approved_at IS NULL
   OR r.effective_until IS NOT NULL OR r.category IS DISTINCT FROM r.version_category
   OR r.scope_type IS DISTINCT FROM r.version_scope_type OR r.scope_id IS DISTINCT FROM r.version_scope_id
   OR jsonb_typeof(r.value) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'Arabic reviewed-control baseline invalid: % %',r.category,r.id;
  END IF;
  v:=r.value; changed:=false;
  IF r.category='ui_navigation' THEN
   FOR e IN SELECT value FROM jsonb_array_elements(nav) LOOP
    a:=v#>ARRAY['apps',e->>'app','sections'];
    IF a IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(a)<>'array' THEN RAISE EXCEPTION 'Malformed navigation sections'; END IF;
    n:=0;
    FOR i IN 0..jsonb_array_length(a)-1 LOOP
     b:=a->i;
     IF b->>'id'=COALESCE(e->>'section',e->>'id') THEN
      IF e->>'kind'='section' THEN
       n:=n+1; path:=ARRAY['apps',e->>'app','sections',i::text];
      ELSE
       IF b ? 'items' AND jsonb_typeof(b->'items')<>'array' THEN RAISE EXCEPTION 'Malformed navigation items'; END IF;
       FOR j IN 0..COALESCE(jsonb_array_length(b->'items'),0)-1 LOOP
        IF b#>>ARRAY['items',j::text,'id']=e->>'id' THEN
         n:=n+1; path:=ARRAY['apps',e->>'app','sections',i::text,'items',j::text];
        END IF;
       END LOOP;
      END IF;
     END IF;
    END LOOP;
    IF n>1 THEN RAISE EXCEPTION 'Duplicate navigation id % in %/%',e->>'id',e->>'app',e->>'section'; END IF;
    IF n=1 AND v#>>(array_append(path,'label'))=e->>'en'
     AND NOT (v#>path ? 'label_ar') THEN
     v:=jsonb_set(v,array_append(path,'label_ar'),e->'ar',true); changed:=true;
    END IF;
   END LOOP;
  ELSIF r.category='ui_read_registry' THEN
   a:=v->'resources';
   IF jsonb_typeof(a)<>'array' THEN RAISE EXCEPTION 'Malformed read resources'; END IF;
   FOR e IN SELECT value FROM jsonb_array_elements(reads) LOOP
    n:=0; p:=0; collection:=e->>'collection';
    FOR i IN 0..jsonb_array_length(a)-1 LOOP
     IF a->i->>'key'=e->>'resource' THEN
      p:=p+1;
      b:=(a->i)->(collection);
      IF b IS NOT NULL AND jsonb_typeof(b)<>'array' THEN RAISE EXCEPTION 'Malformed read collection %',collection; END IF;
      FOR j IN 0..COALESCE(jsonb_array_length(b),0)-1 LOOP
       IF (b->j)->>(CASE WHEN collection='related' THEN 'resource' ELSE 'key' END)=e->>'id' THEN
        n:=n+1; path:=ARRAY['resources',i::text,collection,j::text];
       END IF;
      END LOOP;
     END IF;
    END LOOP;
    IF p>1 OR n>1 THEN RAISE EXCEPTION 'Duplicate read target %/%',e->>'resource',e->>'id'; END IF;
    IF n=1 AND NOT (v#>path ? 'label_ar') THEN
     IF (e->'en'='null'::jsonb AND NOT (v#>path ? 'label'))
      OR (e->'en'<>'null'::jsonb AND v#>>(array_append(path,'label'))=e->>'en') THEN
      IF (NOT (e ? 'column') OR v#>>(array_append(path,'column'))=e->>'column')
       AND (NOT (e ? 'resolver') OR v#>>(array_append(path,'resolver'))=e->>'resolver')
       AND (NOT (e ? 'op') OR v#>>(array_append(path,'op'))=e->>'op')
       AND (NOT (e ? 'filter_key') OR v#>>(array_append(path,'filter_key'))=e->>'filter_key')
       AND (NOT (e ? 'from') OR v#>>(array_append(path,'from'))=e->>'from') THEN
       v:=jsonb_set(v,array_append(path,'label_ar'),e->'ar',true); changed:=true;
      END IF;
     END IF;
    END IF;
   END LOOP;
   IF changed AND public.normalize_settings_value_v1('ui_read_registry',v) IS DISTINCT FROM v THEN
    RAISE EXCEPTION 'Read registry normalization would change unrelated fields';
   END IF;
  ELSE
   collection:=CASE WHEN r.category='ui_filter_operators' THEN 'operators' ELSE 'commands' END;
   a:=v->(collection);
   IF a IS NULL THEN CONTINUE; END IF;
   IF jsonb_typeof(a)<>'array' THEN RAISE EXCEPTION 'Malformed registry array %',collection; END IF;
   FOR e IN SELECT value FROM jsonb_array_elements(
    CASE WHEN r.category='ui_filter_operators' THEN operators ELSE commands END) LOOP
    n:=0;
    FOR i IN 0..jsonb_array_length(a)-1 LOOP
     IF a->i->>'key'=e->>'id' THEN n:=n+1; path:=ARRAY[collection,i::text]; END IF;
    END LOOP;
    IF n>1 THEN RAISE EXCEPTION 'Duplicate registry key %',e->>'id'; END IF;
    IF n=1 AND v#>>(array_append(path,'label'))=e->>'en'
     AND NOT (v#>path ? 'label_ar') THEN
     v:=jsonb_set(v,array_append(path,'label_ar'),e->'ar',true); changed:=true;
    END IF;
   END LOOP;
  END IF;
  IF changed THEN
   PERFORM public.upsert_settings_value_v1(r.category,r.scope_type,r.scope_id,v,r.schema_version,
    'Source-verified optional Arabic labels for reviewed controls; English, IDs and permissions unchanged');
  END IF;
 END LOOP;
END;
$seed$;
SELECT pg_advisory_unlock(hashtext('20260923002000_arabic_reviewed_controls_v1'));
COMMIT;
