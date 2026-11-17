BEGIN;

CREATE OR REPLACE FUNCTION count_webhook_sources()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT COUNT(*) FROM webhook_sources;
$$;

COMMENT ON FUNCTION count_webhook_sources()
    IS 'Admin helper: returns total number of webhook_sources rows.';

COMMIT;
