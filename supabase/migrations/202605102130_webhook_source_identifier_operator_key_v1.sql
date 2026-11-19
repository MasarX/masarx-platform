-- Console V2 webhook source references are operator-facing keys used in
-- receiver URLs, tester payloads, and idempotency checks. Numeric-only values
-- are too easy to confuse with rate limits or row counts, so both existing
-- rows and new writes must carry an explicit stable key.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.webhook_sources'::regclass
       AND conname = 'webhook_sources_source_identifier_operator_key'
  ) THEN
    ALTER TABLE public.webhook_sources
      ADD CONSTRAINT webhook_sources_source_identifier_operator_key
      CHECK (
        source_identifier ~ '[[:alpha:]]'
        AND source_identifier ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      ) NOT VALID;
  END IF;
END $$;

UPDATE public.webhook_sources
   SET source_identifier = concat(
         'source-',
         COALESCE(
           NULLIF(regexp_replace(source_identifier, '[^A-Za-z0-9._:-]+', '-', 'g'), ''),
           'webhook'
         ),
         '-',
         id::text
       ),
       updated_at = now()
 WHERE source_identifier !~ '[[:alpha:]]'
    OR source_identifier !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$';

COMMENT ON CONSTRAINT webhook_sources_source_identifier_operator_key ON public.webhook_sources
  IS 'Requires webhook source references to be stable operator keys, not numeric-only UI input; existing invalid rows are normalized before validation.';
