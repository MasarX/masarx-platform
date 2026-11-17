-- Plan: PLAN-202511-testing-hardening-e2e-provenance / Step: S14
-- pgTAP: deep_merge_jsonb semantics (objects + array strategies), resolve_settings_merged basics
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

-- 1) Deep object merge preserves and extends keys
SELECT cmp_ok(
  public.deep_merge_jsonb('{"a": {"b": 1}}'::jsonb, '{"a": {"c": 2}}'::jsonb),
  '=',
  '{"a": {"b": 1, "c": 2}}'::jsonb,
  'deep object merge combines nested keys'
);

-- 2) Child overrides scalar
SELECT cmp_ok(
  public.deep_merge_jsonb('{"k": 1}'::jsonb, '{"k": 2}'::jsonb),
  '=',
  '{"k": 2}'::jsonb,
  'child scalar overrides parent'
);

-- 3) Arrays default to replace
SELECT cmp_ok(
  public.deep_merge_jsonb('{"arr": [1,2]}'::jsonb, '{"arr": [3]}'::jsonb),
  '=',
  '{"arr": [3]}'::jsonb,
  'arrays default to replace'
);

-- 4) Arrays append strategy
SELECT cmp_ok(
  public.deep_merge_jsonb('{"arr": [1,2]}'::jsonb, '{"arr": [3], "arr__merge_strategy": "append"}'::jsonb),
  '=',
  '{"arr": [1,2,3]}'::jsonb,
  'arrays append when arr__merge_strategy=append'
);

-- 5) Arrays prepend strategy
SELECT cmp_ok(
  public.deep_merge_jsonb('{"arr": [1,2]}'::jsonb, '{"arr": [3], "arr__merge_strategy": "prepend"}'::jsonb),
  '=',
  '{"arr": [3,1,2]}'::jsonb,
  'arrays prepend when arr__merge_strategy=prepend'
);

-- 6) resolve_settings_merged returns a JSON object or NULL safely
SELECT ok(
  (SELECT jsonb_typeof(public.resolve_settings_merged('nonexistent_category','global', NULL)) IS NULL
   OR jsonb_typeof(public.resolve_settings_merged('nonexistent_category','global', NULL)) = 'object'),
  'resolve_settings_merged returns NULL or object for missing category'
);

-- 7) __merge_strategy keys are not retained in output
SELECT ok(
  NOT (
    public.deep_merge_jsonb('{"arr": [1]}', '{"arr": [2], "arr__merge_strategy": "append"}') ? 'arr__merge_strategy'
  ),
  '__merge_strategy is not present in merged output'
);

-- 8) Unknown merge strategy defaults to replace
SELECT cmp_ok(
  public.deep_merge_jsonb('{"arr": [1,2]}'::jsonb, '{"arr": [3], "arr__merge_strategy": "unknown"}'::jsonb),
  '=',
  '{"arr": [3]}'::jsonb,
  'unknown array strategy falls back to replace'
);

-- 9) Nested object + array merge across multiple keys
SELECT cmp_ok(
  public.deep_merge_jsonb('{"a": {"x": 1, "items": [1]}, "b": 1}', '{"a": {"y": 2, "items": [2], "items__merge_strategy": "append"}, "b": 2}'),
  '=',
  '{"a": {"x": 1, "y": 2, "items": [1,2]}, "b": 2}'::jsonb,
  'nested object + array append merge combines fields'
);

-- 10) Scalar parent replaced by array child
SELECT cmp_ok(
  public.deep_merge_jsonb('{"k": 1}', '{"k": [1,2]}'),
  '=',
  '{"k": [1,2]}'::jsonb,
  'child array replaces parent scalar'
);

-- 11) Array parent replaced by object child
SELECT cmp_ok(
  public.deep_merge_jsonb('{"k": [1,2]}', '{"k": {"x": true}}'),
  '=',
  '{"k": {"x": true}}'::jsonb,
  'child object replaces parent array'
);

SELECT finish();

ROLLBACK;
