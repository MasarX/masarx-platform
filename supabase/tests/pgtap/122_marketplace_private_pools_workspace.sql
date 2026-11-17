-- Plan: PLAN-202603-marketplace-network-local-signoff-hardening / Step: S04
-- Marketplace private pools workspace contracts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT has_function(
  'public',
  'marketplace_private_pools_workspace_v1',
  ARRAY['uuid'],
  'marketplace_private_pools_workspace_v1 exists'
);

SELECT has_function(
  'api',
  'marketplace_private_pools_workspace_v1',
  ARRAY['uuid'],
  'api marketplace_private_pools_workspace_v1 wrapper exists'
);

SELECT ok(
  public.resolve_settings_merged('ui_navigation', 'global', NULL::uuid) #> '{apps,portal,sections}' @> jsonb_build_array(
    jsonb_build_object('id', 'marketplace')
  ),
  'portal navigation keeps marketplace section after private pool workspace hardening'
);

SELECT ok(
  public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid) @> jsonb_build_object(
    'resources',
    jsonb_build_array(jsonb_build_object('key', 'marketplace_private_pools'))
  ),
  'ui_read_registry still advertises marketplace_private_pools resource key'
);

SELECT * FROM finish();

ROLLBACK;
