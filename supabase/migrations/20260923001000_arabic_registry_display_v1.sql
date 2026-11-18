-- Source-verified Arabic presentation overlays for the reviewed Console/Portal screens.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260923001000_arabic_registry_display_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
DO $seed$
DECLARE
 r record; v jsonb; e jsonb; app text; a jsonb; b jsonb; path text[];
 i int; j int; n int; changed boolean;
 nav jsonb := '[
 {"app":"console","kind":"section","id":"home","en":"Home","ar":"الرئيسية"},
 {"app":"console","kind":"section","id":"workflows","en":"Workflows","ar":"سير العمل"},
 {"app":"console","kind":"section","id":"operations","en":"Operations","ar":"العمليات"},
 {"app":"console","kind":"item","section":"home","id":"console-home","en":"Overview","ar":"نظرة عامة"},
 {"app":"console","kind":"item","section":"workflows","id":"manual-review","en":"Manual review queue","ar":"قائمة المراجعة اليدوية"},
 {"app":"console","kind":"item","section":"workflows","id":"workflow-runs","en":"Workflow runs","ar":"عمليات سير العمل"},
 {"app":"console","kind":"item","section":"workflows","id":"workflow-templates","en":"Workflow templates","ar":"قوالب سير العمل"},
 {"app":"console","kind":"item","section":"workflows","id":"workflow-template-steps","en":"Workflow template steps","ar":"خطوات قوالب سير العمل"},
 {"app":"console","kind":"item","section":"workflows","id":"workflow-run-steps","en":"Workflow run steps","ar":"خطوات عمليات سير العمل"},
 {"app":"console","kind":"item","section":"workflows","id":"manual-review-tasks","en":"My tasks","ar":"مهامي"},
 {"app":"console","kind":"item","section":"workflows","id":"request-history","en":"Request history","ar":"سجل الطلبات"},
 {"app":"console","kind":"item","section":"operations","id":"shipments","en":"Shipments","ar":"الشحنات"},
 {"app":"console","kind":"item","section":"operations","id":"labels","en":"Labels","ar":"الملصقات"},
 {"app":"portal","kind":"item","section":"home","id":"portal-home","en":"Overview","ar":"نظرة عامة"},
 {"app":"portal","kind":"section","id":"operations","en":"Operations","ar":"العمليات"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-customer-shipment-changes","en":"Customer shipment changes","ar":"تغييرات شحنات العملاء"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-public-tracking-requests","en":"Public tracking requests","ar":"طلبات التتبع العامة"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-warehouse-transfers","en":"Warehouse Transfers","ar":"التحويلات بين المستودعات"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-handling-units","en":"Handling Units","ar":"وحدات المناولة"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-scan-events","en":"Scan Events","ar":"أحداث المسح"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-dispatch-exception-review","en":"Dispatch Exception Review","ar":"مراجعة استثناءات التوزيع"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-dispatch-exception-review-mine","en":"My Exception Reviews","ar":"مراجعات الاستثناءات الخاصة بي"},
 {"app":"portal","kind":"item","section":"operations","id":"portal-unassigned-exceptions","en":"Unassigned Exceptions","ar":"الاستثناءات غير المسندة"}]'::jsonb;
 read_labels jsonb := '[{"id":"shipments","en":"Shipments","ar":"الشحنات"},{"id":"dispatch_exception_review","en":"Dispatch Exception Review","ar":"مراجعة استثناءات التوزيع"}]'::jsonb;
 command_labels jsonb := '[
 {"id":"marketplace.accept_award","en":"Accept award","ar":"قبول الترسية","description":"Accept the selected marketplace award and materialize work if policy allows.","description_ar":"قبول الترسية المحددة وإنشاء العمل إذا سمحت السياسة."},
 {"id":"route_runs.accept_assignment","en":"Accept assignment","ar":"قبول الإسناد","description":"Accept the selected route assignment after acknowledgement.","description_ar":"قبول إسناد المسار المحدد بعد الإقرار به."}]'::jsonb;
 tracking_labels jsonb := '[
 {"key":"title","en":"Tracking","ar":"التتبع"},{"key":"description","en":"Search shipments by tracking number.","ar":"ابحث عن الشحنات باستخدام رقم التتبع."},
 {"key":"results_description","en":"Tracking results filtered by tracking_number.","ar":"نتائج التتبع المصفاة حسب رقم التتبع."},
 {"key":"empty","en":"Enter a tracking number to load shipment results.","ar":"أدخل رقم التتبع لعرض نتائج الشحنة."},
 {"key":"form.label","en":"Tracking number","ar":"رقم التتبع"},
 {"key":"form.placeholder","en":"Scan or enter tracking number","ar":"امسح رقم التتبع أو أدخله"},
 {"key":"form.search_label","en":"Search","ar":"بحث"},{"key":"form.clear_label","en":"Clear","ar":"مسح"}]'::jsonb;
BEGIN
 PERFORM 1 FROM public.settings_versions WHERE category IN
 ('ui_navigation','ui_read_registry','ui_command_registry','ui_tracking_registry')
 AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 FOR r IN SELECT s.id,s.category,s.scope_type,s.scope_id,s.cached_value,
  sv.value,sv.schema_version,sv.category AS version_category,
  sv.scope_type AS version_scope_type,sv.scope_id AS version_scope_id,
  sv.approved_at,sv.effective_until
 FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
 WHERE s.category IN ('ui_navigation','ui_read_registry','ui_command_registry','ui_tracking_registry')
 ORDER BY s.id FOR UPDATE OF s LOOP
  IF r.cached_value IS DISTINCT FROM r.value OR r.approved_at IS NULL
   OR r.effective_until IS NOT NULL OR r.category IS DISTINCT FROM r.version_category
   OR r.scope_type IS DISTINCT FROM r.version_scope_type OR r.scope_id IS DISTINCT FROM r.version_scope_id
   OR jsonb_typeof(r.value) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'Arabic registry baseline invalid: % %',r.category,r.id;
  END IF;
  v:=r.value; changed:=false;
  IF r.category='ui_navigation' THEN
   FOR e IN SELECT value FROM jsonb_array_elements(nav) LOOP
    app:=e->>'app'; a:=v#>ARRAY['apps',app,'sections'];
    IF a IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(a)<>'array' THEN RAISE EXCEPTION 'Malformed navigation sections'; END IF;
    n:=0;
    FOR i IN 0..jsonb_array_length(a)-1 LOOP
     b:=a->i;
     IF e->>'kind'='section' AND b->>'id'=e->>'id' THEN
      n:=n+1; path:=ARRAY['apps',app,'sections',i::text];
     ELSIF e->>'kind'='item' AND b->>'id'=e->>'section' THEN
      IF b ? 'items' AND jsonb_typeof(b->'items')<>'array' THEN RAISE EXCEPTION 'Malformed navigation items'; END IF;
      FOR j IN 0..COALESCE(jsonb_array_length(b->'items'),0)-1 LOOP
       IF b#>>ARRAY['items',j::text,'id']=e->>'id' THEN
        n:=n+1; path:=ARRAY['apps',app,'sections',i::text,'items',j::text];
       END IF;
      END LOOP;
     END IF;
    END LOOP;
    IF n>1 THEN RAISE EXCEPTION 'Duplicate navigation id %',e->>'id'; END IF;
    IF n=1 AND v#>>(array_append(path,'label'))=e->>'en' AND NOT (v#>path ? 'label_ar') THEN
     v:=jsonb_set(v,array_append(path,'label_ar'),e->'ar',true); changed:=true;
    END IF;
   END LOOP;
  ELSIF r.category IN ('ui_read_registry','ui_command_registry') THEN
   a:=v->CASE WHEN r.category='ui_read_registry' THEN 'resources' ELSE 'commands' END;
   IF jsonb_typeof(a)<>'array' THEN RAISE EXCEPTION 'Malformed registry array: %',r.category; END IF;
   FOR e IN SELECT value FROM jsonb_array_elements(
    CASE WHEN r.category='ui_read_registry' THEN read_labels ELSE command_labels END) LOOP
    n:=0;
    FOR i IN 0..jsonb_array_length(a)-1 LOOP
     b:=a->i;
     IF b->>'key'=e->>'id' THEN
      n:=n+1; path:=ARRAY[CASE WHEN r.category='ui_read_registry' THEN 'resources' ELSE 'commands' END,i::text];
     END IF;
    END LOOP;
    IF n>1 THEN RAISE EXCEPTION 'Duplicate registry key %',e->>'id'; END IF;
    IF n=1 THEN
     IF v#>>(array_append(path,'label'))=e->>'en' AND NOT (v#>path ? 'label_ar') THEN
      v:=jsonb_set(v,array_append(path,'label_ar'),e->'ar',true); changed:=true;
     END IF;
     IF r.category='ui_command_registry' AND v#>>(array_append(path,'description'))=e->>'description'
      AND NOT (v#>path ? 'description_ar') THEN
      v:=jsonb_set(v,array_append(path,'description_ar'),e->'description_ar',true); changed:=true;
     END IF;
    END IF;
   END LOOP;
   IF r.category='ui_read_registry' AND changed
    AND public.normalize_settings_value_v1('ui_read_registry',v) IS DISTINCT FROM v THEN
    RAISE EXCEPTION 'Read registry normalization would change unrelated fields';
   END IF;
  ELSE
   IF v->>'resource_key'='shipments' AND v->>'filter_key'='tracking_number'
    AND v->>'param_key'='tracking_number' THEN
    FOR e IN SELECT value FROM jsonb_array_elements(tracking_labels) LOOP
     IF e->>'key' LIKE 'form.%' THEN
      path:=ARRAY['form',substring(e->>'key' from 6)];
     ELSE path:=ARRAY[e->>'key']; END IF;
     IF v#>>path=e->>'en' THEN
      IF array_length(path,1)=1 THEN path:=ARRAY[(e->>'key')||'_ar'];
      ELSE path:=ARRAY['form',substring(e->>'key' from 6)||'_ar']; END IF;
      IF v#>path IS NULL THEN v:=jsonb_set(v,path,e->'ar',true); changed:=true; END IF;
     END IF;
    END LOOP;
   END IF;
  END IF;
  IF changed THEN
   PERFORM public.upsert_settings_value_v1(r.category,r.scope_type,r.scope_id,v,r.schema_version,
    'Source-verified Arabic display labels; identifiers, permissions and English fallback unchanged');
  END IF;
 END LOOP;
END;
$seed$;
CREATE OR REPLACE FUNCTION public.public_tracking_config_v1()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp SET row_security=on
AS $function$
 WITH source AS (SELECT cached_value AS value FROM public.settings
  WHERE category='ui_tracking_registry' AND scope_type='global' AND scope_id IS NULL LIMIT 1)
 SELECT jsonb_strip_nulls(jsonb_build_object(
  'resource_key',value->>'resource_key','filter_key',value->>'filter_key','param_key',value->>'param_key',
  'title',value->>'title','title_ar',value->>'title_ar',
  'description',value->>'description','description_ar',value->>'description_ar',
  'results_description',value->>'results_description','results_description_ar',value->>'results_description_ar',
  'empty',value->>'empty','empty_ar',value->>'empty_ar',
  'form',jsonb_strip_nulls(jsonb_build_object(
   'label',value#>>'{form,label}','label_ar',value#>>'{form,label_ar}',
   'placeholder',value#>>'{form,placeholder}','placeholder_ar',value#>>'{form,placeholder_ar}',
   'search_label',value#>>'{form,search_label}','search_label_ar',value#>>'{form,search_label_ar}',
   'clear_label',value#>>'{form,clear_label}','clear_label_ar',value#>>'{form,clear_label_ar}'
  )))) FROM source;
$function$;
REVOKE ALL ON FUNCTION public.public_tracking_config_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.public_tracking_config_v1() TO authenticated, service_role;
SELECT pg_advisory_unlock(hashtext('20260923001000_arabic_registry_display_v1'));
COMMIT;
