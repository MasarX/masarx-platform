-- Fixup: add organization_id to webhook_inbox to align with intake pipeline updates
BEGIN;
ALTER TABLE public.webhook_inbox
  ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_org ON public.webhook_inbox(organization_id);
COMMIT;