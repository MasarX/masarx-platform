-- Fixup: ensure tracking_global_seq exists for label workflows that call nextval(''tracking_global_seq'')
BEGIN;
CREATE SEQUENCE IF NOT EXISTS public.tracking_global_seq CACHE 1000;
COMMENT ON SEQUENCE public.tracking_global_seq IS 'Global tracking number generator sequence used by label workflows';
COMMIT;