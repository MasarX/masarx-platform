BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_active_expires_created_v1
  ON public.tracking_sessions (expires_at DESC NULLS LAST, created_at DESC)
  INCLUDE (id, organization_id, client_id, sender_id, shipment_id, recipient_id, token_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_active_null_expiry_created_v1
  ON public.tracking_sessions (created_at DESC)
  INCLUDE (id, organization_id, client_id, sender_id, shipment_id, recipient_id, token_hash)
  WHERE status = 'active' AND expires_at IS NULL;

COMMIT;
