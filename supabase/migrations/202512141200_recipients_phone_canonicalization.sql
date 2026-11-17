-- Migration: Recipient phone canonicalization (digits-only)
-- Purpose:
--   - Add normalize_phone_number() helper
--   - Store digits-only phone_number_normalized on recipients
--   - Deduplicate recipients by (client_id, phone_number_normalized) safely
--   - Add uniqueness + trigger to keep normalized column in sync
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_phone_number(p_phone TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), '');
$$;

COMMENT ON FUNCTION public.normalize_phone_number(TEXT)
  IS 'Return digits-only phone number (strip +, spaces, punctuation). Returns NULL for empty.';

ALTER TABLE public.recipients
  ADD COLUMN IF NOT EXISTS phone_number_normalized TEXT;

-- Backfill normalized column.
UPDATE public.recipients
SET phone_number_normalized = public.normalize_phone_number(phone_number),
    updated_at = now()
WHERE phone_number_normalized IS NULL
   OR phone_number_normalized <> public.normalize_phone_number(phone_number);

-- De-duplicate recipients by (client_id, phone_number_normalized):
-- - Keep the most recently created recipient for the group.
-- - Re-point shipments/recipient_preferences to the kept recipient.
WITH ranked AS (
  SELECT
    id,
    client_id,
    phone_number_normalized,
    row_number() OVER (
      PARTITION BY client_id, phone_number_normalized
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY client_id, phone_number_normalized
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS keep_id
  FROM public.recipients
  WHERE phone_number_normalized IS NOT NULL
), dups AS (
  SELECT id, keep_id
  FROM ranked
  WHERE rn > 1
)
UPDATE public.shipments s
SET recipient_id = d.keep_id,
    updated_at = now()
FROM dups d
WHERE s.recipient_id = d.id;

WITH ranked AS (
  SELECT
    id,
    client_id,
    phone_number_normalized,
    row_number() OVER (
      PARTITION BY client_id, phone_number_normalized
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY client_id, phone_number_normalized
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS keep_id
  FROM public.recipients
  WHERE phone_number_normalized IS NOT NULL
), dups AS (
  SELECT id, keep_id
  FROM ranked
  WHERE rn > 1
)
UPDATE public.recipient_preferences rp
SET recipient_id = d.keep_id,
    updated_at = now()
FROM dups d
WHERE rp.recipient_id = d.id;

WITH ranked AS (
  SELECT
    id,
    client_id,
    phone_number_normalized,
    row_number() OVER (
      PARTITION BY client_id, phone_number_normalized
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.recipients
  WHERE phone_number_normalized IS NOT NULL
), dups AS (
  SELECT id
  FROM ranked
  WHERE rn > 1
)
DELETE FROM public.recipients r
USING dups d
WHERE r.id = d.id;

-- Ensure normalized column stays updated.
CREATE OR REPLACE FUNCTION public.recipients_set_phone_normalized_trg()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.phone_number_normalized := public.normalize_phone_number(NEW.phone_number);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recipients_set_phone_normalized ON public.recipients;
CREATE TRIGGER trg_recipients_set_phone_normalized
BEFORE INSERT OR UPDATE OF phone_number
ON public.recipients
FOR EACH ROW
EXECUTE FUNCTION public.recipients_set_phone_normalized_trg();

CREATE INDEX IF NOT EXISTS idx_recipients_phone_number_normalized
  ON public.recipients(phone_number_normalized)
  WHERE phone_number_normalized IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_recipients_client_phone_number_normalized
  ON public.recipients(client_id, phone_number_normalized)
  WHERE phone_number_normalized IS NOT NULL;

COMMIT;

