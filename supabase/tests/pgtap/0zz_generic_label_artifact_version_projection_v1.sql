-- F774 native SQL regression; all fixtures and mutations roll back.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path = extensions, public, pg_temp;
SELECT plan(23);
CREATE TEMP TABLE f774_results(name text, passed boolean) ON COMMIT DROP;
DO $test$
DECLARE
  o uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  t uuid := gen_random_uuid();
  j uuid;
  a public.label_artifacts%ROWTYPE;
  v public.label_versions%ROWTYPE;
  target uuid;
  kind text;
  before_count bigint;
  rejected boolean;
  constraint_name text;
  saved_artifact public.label_artifacts%ROWTYPE;
  duplicate_version public.label_versions%ROWTYPE;
  box uuid := gen_random_uuid();
  own_user uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  visible_count bigint;
BEGIN
  INSERT INTO public.organizations(id,name,slug,timezone,locale,billing_status)
    VALUES(o,'F774 fixture','f774-'||o,'UTC','en-US','active');
  INSERT INTO public.clients(id,organization_id,name,slug,sla_tier,status)
    VALUES(c,o,'F774 client','f774-'||c,'standard','active');
  INSERT INTO public.label_template_specs(
    id,organization_id,template_key,version,template_scope_type,template_scope_id,
    renderer_config,asset_refs
  ) VALUES(t,o,'f774-fixture',1,'client',c,
    '{"page":{"width_inch":4,"height_inch":6,"dpi":203},"blocks":[],"barcode":{"type":"CODE128","value_path":"target.barcode"}}',
    '[]');
  FOREACH kind IN ARRAY ARRAY['route_run','handling_unit','warehouse_transfer'] LOOP
    j := gen_random_uuid(); target := gen_random_uuid();
    INSERT INTO public.label_jobs(
      id,organization_id,client_id,shipment_id,label_type,template_id,template_version,
      template_snapshot,idempotency_key,target_type,target_id,job_purpose,reprint_reason
    ) VALUES(j,o,NULL,NULL,public.default_label_type_for_target_type(kind),t,1,
      '{"label_config":{"fallback_barcode":"F774","barcode_format":"CODE128"}}',
      'f774-'||j,kind,target,'primary','preserved reason');
    PERFORM public.complete_label_job(j,'succeeded','labels/f774-'||j||'.pdf',123,
      '{"barcode":"F774","fixture":"native"}',NULL);
    SELECT * INTO STRICT a FROM public.label_artifacts
      WHERE source_label_job_id=j AND organization_id=o;
    SELECT * INTO STRICT v FROM public.label_versions WHERE label_job_id=j;
    INSERT INTO f774_results VALUES(kind||' canonical completion projects generic version',
      v.label_id IS NULL AND v.shipment_id IS NULL AND v.client_id IS NULL
      AND v.label_artifact_id=a.id AND v.organization_id=o
      AND v.target_type=kind AND v.target_id=target AND v.version_number=1
      AND v.version_status='active' AND v.file_url=a.file_url
      AND v.reprint_reason='preserved reason'
      AND v.renderer_metadata=a.renderer_metadata);
  END LOOP;

  SELECT count(*) INTO before_count FROM public.label_versions WHERE organization_id=o;
  PERFORM public.complete_label_job(j,'succeeded','ignored-retry.pdf',999,'{}',NULL);
  INSERT INTO f774_results VALUES('successful retry does not rewrite or duplicate',
    (SELECT count(*)=before_count FROM public.label_versions WHERE organization_id=o)
    AND (SELECT file_url=a.file_url FROM public.label_artifacts WHERE id=a.id AND organization_id=o));
  PERFORM public.project_label_artifact_version_v1(a);
  INSERT INTO f774_results VALUES('projection and backfill seam is idempotent',
    (SELECT count(*)=before_count FROM public.label_versions WHERE organization_id=o));

  UPDATE public.label_artifacts SET print_count=print_count+1,last_printed_at=clock_timestamp()
    WHERE id=a.id AND organization_id=o;
  INSERT INTO f774_results VALUES('print telemetry does not rewrite render snapshot',
    (SELECT print_count=v.print_count AND file_url=v.file_url FROM public.label_versions WHERE id=v.id));
  rejected:=false;
  BEGIN
    UPDATE public.label_artifacts SET file_url='forbidden-rewrite.pdf'
      WHERE id=a.id AND organization_id=o;
  EXCEPTION WHEN check_violation THEN
    rejected := SQLERRM='label_artifact_render_is_immutable';
  END;
  INSERT INTO f774_results VALUES('changed render is rejected atomically',rejected
    AND (SELECT file_url=a.file_url FROM public.label_artifacts WHERE id=a.id AND organization_id=o));

  a.target_id:=gen_random_uuid(); rejected:=false;
  BEGIN PERFORM public.project_label_artifact_version_v1(a);
  EXCEPTION WHEN check_violation THEN rejected:=SQLERRM='label_artifact_version_job_mismatch'; END;
  INSERT INTO f774_results VALUES('job target mismatch rejects',rejected);
  SELECT * INTO STRICT a FROM public.label_artifacts WHERE source_label_job_id=j AND organization_id=o;
  a.organization_id:=gen_random_uuid(); rejected:=false;
  BEGIN PERFORM public.project_label_artifact_version_v1(a);
  EXCEPTION WHEN check_violation THEN rejected:=SQLERRM='label_artifact_version_job_mismatch'; END;
  INSERT INTO f774_results VALUES('job organization mismatch rejects',rejected);
  SELECT * INTO STRICT a FROM public.label_artifacts WHERE source_label_job_id=j AND organization_id=o;
  DELETE FROM public.label_artifacts WHERE id=a.id AND organization_id=o;
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO f774_results VALUES('artifact cleanup retains target and render history',
    (SELECT label_artifact_id IS NULL AND target_type=kind
      AND target_id=target AND organization_id=o AND file_url=a.file_url
      FROM public.label_versions WHERE id=v.id));

  -- Non-null client and target-box are copied from the actual job, not inferred.
  j := gen_random_uuid(); target := gen_random_uuid(); kind := 'handling_unit';
  INSERT INTO public.label_jobs(
    id,organization_id,client_id,shipment_id,label_type,template_id,template_version,
    template_snapshot,idempotency_key,target_type,target_id,target_box_id
  ) VALUES(j,o,c,NULL,'container',t,1,
    '{"label_config":{"fallback_barcode":"F774-BOX","barcode_format":"CODE128"}}',
    'f774-'||j,kind,target,box);
  PERFORM public.complete_label_job(j,'succeeded','labels/f774-box.pdf',123,
    '{"barcode":"F774-BOX"}',NULL);
  SELECT * INTO STRICT a FROM public.label_artifacts WHERE source_label_job_id=j AND organization_id=o;
  SELECT * INTO STRICT v FROM public.label_versions WHERE label_job_id=j;
  saved_artifact:=a;
  INSERT INTO f774_results VALUES('nonnull client and box preserved',v.client_id=c AND v.target_box_id=box);

  a.client_id:=NULL; rejected:=false;
  BEGIN PERFORM public.project_label_artifact_version_v1(a);
  EXCEPTION WHEN check_violation THEN rejected:=SQLERRM='label_artifact_version_job_mismatch'; END;
  INSERT INTO f774_results VALUES('client mismatch rejects',rejected);
  a:=saved_artifact; a.layout_template_id:=gen_random_uuid(); rejected:=false;
  BEGIN PERFORM public.project_label_artifact_version_v1(a);
  EXCEPTION WHEN check_violation THEN rejected:=SQLERRM='label_artifact_version_job_mismatch'; END;
  INSERT INTO f774_results VALUES('template mismatch rejects',rejected);
  a:=saved_artifact; a.target_box_id:=NULL; rejected:=false;
  BEGIN PERFORM public.project_label_artifact_version_v1(a);
  EXCEPTION WHEN check_violation THEN rejected:=SQLERRM='label_artifact_version_job_mismatch'; END;
  INSERT INTO f774_results VALUES('box mismatch rejects',rejected);
  a:=saved_artifact; a.id:=gen_random_uuid(); rejected:=false;
  BEGIN PERFORM public.project_label_artifact_version_v1(a);
  EXCEPTION WHEN check_violation THEN rejected:=SQLERRM='label_artifact_version_conflict'; END;
  INSERT INTO f774_results VALUES('existing job version rejects different artifact',rejected);

  duplicate_version:=v; duplicate_version.id:=gen_random_uuid();
  duplicate_version.label_job_id:=NULL; duplicate_version.version_number:=2;
  rejected:=false;
  BEGIN INSERT INTO public.label_versions SELECT (duplicate_version).*;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
    rejected:=constraint_name='label_versions_artifact_active_unique';
  END;
  INSERT INTO f774_results VALUES('second active artifact version rejects',rejected);
  duplicate_version.version_number:=1; duplicate_version.version_status:='superseded';
  rejected:=false;
  BEGIN INSERT INTO public.label_versions SELECT (duplicate_version).*;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
    rejected:=constraint_name='label_versions_artifact_number_unique';
  END;
  INSERT INTO f774_results VALUES('duplicate artifact version number rejects',rejected);

  -- Exercise the real table trigger, not just its private helper.
  j:=gen_random_uuid();
  INSERT INTO public.label_jobs(
    id,organization_id,client_id,shipment_id,label_type,template_id,template_version,
    template_snapshot,idempotency_key,target_type,target_id,target_box_id
  ) VALUES(j,o,c,NULL,'container',t,1,'{}','f774-'||j,kind,target,box);
  a:=saved_artifact; a.id:=gen_random_uuid(); a.source_label_job_id:=j;
  a.target_box_id:=gen_random_uuid(); rejected:=false;
  BEGIN INSERT INTO public.label_artifacts SELECT (a).*;
  EXCEPTION WHEN check_violation THEN rejected:=SQLERRM='label_artifact_version_job_mismatch'; END;
  INSERT INTO f774_results VALUES('actual invalid artifact insert rolls back atomically',rejected
    AND NOT EXISTS(SELECT 1 FROM public.label_artifacts WHERE source_label_job_id=j)
    AND NOT EXISTS(SELECT 1 FROM public.label_versions WHERE label_job_id=j)
    AND (SELECT status='pending' FROM public.label_jobs WHERE id=j AND organization_id=o));

  -- Transaction-local SELECT grant isolates real RLS behavior from existing ACL denial.
  -- It is rolled back; no production privilege change is part of this migration.
  INSERT INTO public.organizations(id,name,slug,billing_status)
    VALUES(other_org,'F774 other tenant','f774-'||other_org,'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
    VALUES(own_user,o,'f774-'||own_user||'@example.test','F774 own','ops_admin','active','tenant'),
      (other_user,other_org,'f774-'||other_user||'@example.test','F774 other','ops_admin','active','tenant');
  GRANT SELECT ON public.label_versions TO authenticated;
  PERFORM set_config('request.jwt.claim.sub',own_user::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',own_user,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO visible_count FROM public.label_versions WHERE id=v.id;
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO f774_results VALUES('actual own tenant RLS read succeeds',visible_count=1);
  PERFORM set_config('request.jwt.claim.sub',other_user::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',other_user,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO visible_count FROM public.label_versions WHERE id=v.id;
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO f774_results VALUES('actual cross tenant RLS read returns no rows',visible_count=0);

END;
$test$;
SELECT ok(passed,name) FROM f774_results ORDER BY name;
SELECT ok(NOT has_function_privilege('anon',
  'public.project_label_artifact_version_v1(public.label_artifacts)','EXECUTE'),
  'anon cannot invoke projection');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.project_label_artifact_version_v1(public.label_artifacts)','EXECUTE'),
  'authenticated cannot invoke projection');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.sync_label_artifact_version_v1()','EXECUTE'),
  'authenticated cannot invoke trigger function');
SELECT * FROM finish();
ROLLBACK;
