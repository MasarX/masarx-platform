-- Fixup: add updated_at to webhook_inbox for intake pipeline updates
BEGIN;
ALTER TABLE public.webhook_inbox
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE public.webhook_inbox SET updated_at = COALESCE(updated_at, now()) WHERE updated_at IS NULL;
COMMIT;