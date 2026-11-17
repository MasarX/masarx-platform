-- Test Suite: jsonb_extract_fields supports array-valued JSONPath mappings

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SET search_path TO public, pgtap, extensions;

-- 1) Picks first match when present
SELECT is(
  (public.jsonb_extract_fields('{"a":{"b":1},"x":2}'::jsonb, '{"v":["$.a.b","$.x"]}'::jsonb)->>'v')::text,
  '1',
  'jsonb_extract_fields prefers first matching JSONPath in array'
);

-- 2) Falls back when the first candidate is missing
SELECT is(
  (public.jsonb_extract_fields('{"a":{"b":1},"x":2}'::jsonb, '{"v":["$.missing","$.x"]}'::jsonb)->>'v')::text,
  '2',
  'jsonb_extract_fields falls back to next JSONPath when prior is null'
);

-- 3) Falls back when the first candidate JSONPath is invalid
SELECT is(
  (public.jsonb_extract_fields('{"a":{"b":1},"x":2}'::jsonb, '{"v":["$.a[","$.x"]}'::jsonb)->>'v')::text,
  '2',
  'jsonb_extract_fields tolerates invalid JSONPath and uses later candidates'
);

SELECT finish();

ROLLBACK;

