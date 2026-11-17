-- pgTAP: geocoding_normalize_candidate_code helper

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT has_function(
  'public',
  'geocoding_normalize_candidate_code',
  ARRAY['text','text'],
  'geocoding_normalize_candidate_code(text,text) exists'
);

SELECT is(
  public.geocoding_normalize_candidate_code(' abcd-1234 ', '^[A-Z]{4}[0-9]{4}$'),
  'ABCD1234',
  'Normalizes candidate and validates against regex'
);

SELECT is(
  public.geocoding_normalize_candidate_code('ABCD1234', '^[A-Z]{3}[0-9]{4}$'),
  NULL::text,
  'Returns NULL when value does not match regex'
);

SELECT is(
  public.geocoding_normalize_candidate_code('ABCD1234', '['),
  NULL::text,
  'Returns NULL on invalid regex (safe)'
);

SELECT finish();

ROLLBACK;

