-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- pgTAP: Canonical API route-pack public docs visibility

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

SELECT ok(
  EXISTS(
    SELECT 1
    FROM public.api_route_packs
    WHERE name = 'logestechs_v2_mirror'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'canonical logestechs_v2_mirror route pack exists'
);

SELECT is(
  (
    SELECT public_docs_enabled
    FROM public.api_route_packs
    WHERE name = 'logestechs_v2_mirror'
      AND scope_type = 'global'
      AND scope_id IS NULL
    LIMIT 1
  ),
  FALSE,
  'canonical logestechs_v2_mirror route pack is not published in public OpenAPI docs'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.api_route_packs p
    JOIN public.api_routes r ON r.pack_id = p.id
    WHERE p.public_docs_enabled = TRUE
      AND p.enabled = TRUE
      AND r.enabled = TRUE
      AND r.scope_type = 'global'
      AND r.scope_id IS NULL
      AND r.path_template LIKE '/api/%'
  ),
  0,
  'canonical public OpenAPI compat-route source is empty by default'
);

SELECT finish();
ROLLBACK;
