-- Test Suite: API gateway public docs visibility (OpenAPI generation control)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT has_column(
  'public',
  'api_route_packs',
  'public_docs_enabled',
  'api_route_packs.public_docs_enabled exists'
);

WITH inserted AS (
  INSERT INTO public.api_route_packs (name, description, enabled)
  VALUES ('pgtap-public-docs-pack-053', 'pgTAP pack for docs visibility', TRUE)
  RETURNING public_docs_enabled
)
SELECT is(
  (SELECT public_docs_enabled FROM inserted),
  FALSE,
  'api_route_packs.public_docs_enabled defaults to FALSE'
);

SELECT finish();

ROLLBACK;

