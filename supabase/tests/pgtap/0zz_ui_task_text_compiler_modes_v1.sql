-- Exercise the final strict/permissive compiler rather than an overwritten source definition.
BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT no_plan();

CREATE FUNCTION pg_temp.task_text_compiler_modes() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_defs JSONB := '[{"key":"query","column":"id","op":"eq","resolver":"task_text"}]';
  v_strict BOOLEAN;
  v_query TEXT := '  Alice''s parcel  ';
  v_expected TEXT := format('%I = ANY(((SELECT public.ui_search_task_ids_v1(%L))::uuid[]))','id',btrim(v_query));
BEGIN
  FOREACH v_strict IN ARRAY ARRAY[TRUE,FALSE] LOOP
    RETURN NEXT is(public.ui_filter_tree_sql_v1(jsonb_build_object('key','query','value',v_query),v_defs,v_strict),
      v_expected,'task text uses one finite scoped resolver in mode '||v_strict);
    RETURN NEXT is(public.ui_filter_tree_sql_v1(jsonb_build_object('key','query','op','ilike','value',v_query),v_defs,v_strict),
      v_expected,'task text ilike retains resolver semantics in mode '||v_strict);
    RETURN NEXT throws_ok(format('SELECT public.ui_filter_tree_sql_v1(%L::jsonb,%L::jsonb,%L::boolean)',
      '{"key":"query","op":"ne","value":"Alice"}',v_defs,v_strict),
      'P0001','ui_filter_tree_sql_v1 task text requires a string equality query','unsupported task text operator is rejected');
    RETURN NEXT throws_ok(format('SELECT public.ui_filter_tree_sql_v1(%L::jsonb,%L::jsonb,%L::boolean)',
      '{"key":"query","value":["Alice"]}',v_defs,v_strict),
      'P0001','ui_filter_tree_sql_v1 task text requires a string equality query','task text array cannot become UUID comparison');
    RETURN NEXT is(public.ui_filter_tree_sql_v1('{"key":"query","op":"is_null"}',v_defs,v_strict),
      'id IS NULL','unary filter remains value-free in mode '||v_strict);
  END LOOP;
  RETURN NEXT is(public.ui_filter_tree_sql_v1(jsonb_build_object('key','query','value',v_query),v_defs),
    v_expected,'canonical two-argument strict wrapper retains the current task resolver');
  RETURN NEXT throws_ok(format('SELECT public.ui_filter_tree_sql_v1(%L::jsonb,%L::jsonb)',
    '{"key":"query","value":"  "}',v_defs),'P0001','ui_filter_tree_sql_v1 invalid filter: empty task text value',
    'strict registry task query cannot silently drop an empty predicate');
  RETURN NEXT is(public.ui_filter_tree_sql_v1('{"key":"query","value":"  "}',v_defs,FALSE),NULL::TEXT,
    'permissive caller retains empty-query UX');
END;
$test$;
SELECT * FROM pg_temp.task_text_compiler_modes();
SELECT * FROM finish();
ROLLBACK;
