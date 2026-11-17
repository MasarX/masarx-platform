-- Migration: Set doc_url for address_intake handler (pgTAP doc_url coverage)

BEGIN;

UPDATE public.operation_handlers
SET doc_url = 'docs/ops/runbooks/geocoding_worker.md'
WHERE handler_key = 'address_intake';

COMMIT;
