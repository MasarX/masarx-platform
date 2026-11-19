-- Validate after legacy webhook source identifiers have been normalized by
-- 202605102130. This is intentionally separate from the UPDATE migration so
-- Postgres does not reject validation due to pending trigger events.

ALTER TABLE public.webhook_sources
  VALIDATE CONSTRAINT webhook_sources_source_identifier_operator_key;

COMMENT ON CONSTRAINT webhook_sources_source_identifier_operator_key ON public.webhook_sources
  IS 'Requires webhook source references to be stable operator keys, not numeric-only UI input.';
