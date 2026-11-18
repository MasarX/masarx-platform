-- pgTAP: Console V2 finance_viewer can read closeout surfaces without write
-- authority. This protects first-tenant COD and settlement evidence from using
-- an over-privileged account.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Finance Viewer Closeout Org', 'finance-viewer-closeout-' || left(v_org::text, 8));

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    'finance-viewer-closeout-' || left(v_user::text, 8) || '@example.com',
    'Finance Viewer Closeout',
    'finance_viewer',
    'active',
    'tenant',
    NULL
  );

  PERFORM set_config('test.finance_viewer_closeout_user', v_user::text, true);
  PERFORM set_config('test.finance_viewer_closeout_org', v_org::text, true);
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'user_type'
      AND lv.value = 'finance_viewer'
      AND lv.status = 'active'
  ),
  'finance_viewer user_type lookup is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'roles', '[]'::jsonb)) AS role_item
    WHERE s.category = 'access_control_policy'
      AND role_item->>'key' = 'finance_viewer'
      AND role_item->'capability_keys' @> '["finance.read","cod.read","settlements.read","console_metadata.read"]'::jsonb
  ),
  'finance_viewer role carries read-only finance closeout capabilities'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'roles', '[]'::jsonb)) AS role_item
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(role_item->'capability_keys', '[]'::jsonb)) AS cap_key
    WHERE s.category = 'access_control_policy'
      AND role_item->>'key' = 'finance_viewer'
      AND cap_key IN ('finance.write', 'settlements.write', 'workflow_runs.write')
  ),
  'finance_viewer role does not carry finance, settlement, or workflow write capabilities'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.finance_viewer_closeout_user'), true);
SET LOCAL ROLE authenticated;

SELECT is(
  (public.user_capability_eval_v1('console_metadata.read', 'tenant', current_setting('test.finance_viewer_closeout_org')::uuid)->>'allowed')::boolean,
  TRUE,
  'finance_viewer can read Console metadata'
);
SELECT is(
  (public.user_capability_eval_v1('finance.read', 'tenant', current_setting('test.finance_viewer_closeout_org')::uuid)->>'allowed')::boolean,
  TRUE,
  'finance_viewer can read finance ledger surfaces'
);
SELECT is(
  (public.user_capability_eval_v1('cod.read', 'tenant', current_setting('test.finance_viewer_closeout_org')::uuid)->>'allowed')::boolean,
  TRUE,
  'finance_viewer can read COD closeout'
);
SELECT is(
  (public.user_capability_eval_v1('settlements.read', 'tenant', current_setting('test.finance_viewer_closeout_org')::uuid)->>'allowed')::boolean,
  TRUE,
  'finance_viewer can read settlements'
);
SELECT is(
  (public.user_capability_eval_v1('finance.write', 'tenant', current_setting('test.finance_viewer_closeout_org')::uuid)->>'allowed')::boolean,
  FALSE,
  'finance_viewer cannot write finance mutations'
);
SELECT is(
  (public.user_capability_eval_v1('settlements.write', 'tenant', current_setting('test.finance_viewer_closeout_org')::uuid)->>'allowed')::boolean,
  FALSE,
  'finance_viewer cannot write settlement lifecycle mutations'
);
SELECT is(
  (public.user_capability_eval_v1('workflow_runs.write', 'tenant', current_setting('test.finance_viewer_closeout_org')::uuid)->>'allowed')::boolean,
  FALSE,
  'finance_viewer cannot start workflow-run mutations'
);

SELECT throws_ok(
  $$ SELECT public.assert_capability_v1('finance.write') $$,
  '42501',
  NULL,
  'finance_viewer assert_capability denies finance.write'
);
SELECT throws_ok(
  $$ SELECT public.assert_capability_v1('settlements.write') $$,
  '42501',
  NULL,
  'finance_viewer assert_capability denies settlements.write'
);
SELECT throws_ok(
  $$ SELECT public.assert_capability_v1('workflow_runs.write') $$,
  '42501',
  NULL,
  'finance_viewer assert_capability denies workflow_runs.write'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
