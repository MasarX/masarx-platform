-- Recipient phone intake must stay E.164 across Console, API, webhook, and import paths.
-- Existing historical rows are left in place; the NOT VALID constraint applies to
-- all new inserts/updates without blocking environments that still carry legacy data.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605111920_recipient_e164_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.is_e164_phone_number(p_phone TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_phone ~ '^\+[1-9][0-9]{7,14}$', FALSE);
$$;

COMMENT ON FUNCTION public.is_e164_phone_number(TEXT)
  IS 'Strict E.164 phone guard for recipient intake: leading +, non-zero country code, and 8-15 digits total.';

ALTER TABLE public.recipients
  DROP CONSTRAINT IF EXISTS recipients_phone_number_e164_chk;

ALTER TABLE public.recipients
  ADD CONSTRAINT recipients_phone_number_e164_chk
  CHECK (public.is_e164_phone_number(phone_number)) NOT VALID;

COMMENT ON CONSTRAINT recipients_phone_number_e164_chk ON public.recipients
  IS 'Enforces E.164 phone numbers for new/updated recipient rows while allowing legacy rows until cleaned.';

SELECT pg_advisory_unlock(hashtext('202605111920_recipient_e164_guard_v1'));
COMMIT;
