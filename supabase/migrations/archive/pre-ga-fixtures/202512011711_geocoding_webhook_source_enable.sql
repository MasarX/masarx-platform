-- Migration: Normalize geocoding-intake-test webhook source (enable + token hash + sender alignment)

BEGIN;

UPDATE public.webhook_sources
SET
  enabled = TRUE,
  organization_id = /* objectives:allow TENANT_LITERAL Justification: Align deterministic test source with Test Org Alpha */ 'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  sender_id = /* objectives:allow TENANT_LITERAL Justification: Reuse canonical test sender for webhook geocoding fixtures */ 'd1a90236-2ed4-4b55-9bc3-16a7500eea93'::uuid,
  mapping_config_id = '99990000-0000-0000-0000-000000770099'::uuid,
  rate_limit_per_hour = 5000,
  auth_token_hash = crypt('EXAMPLE_PASSWORD', gen_salt('bf'))
WHERE source_identifier = 'geocoding-intake-test';

COMMIT;
