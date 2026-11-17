-- Migration: Domain events scope-aware RLS for request history
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071020_domain_events_scope_rls'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.domain_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS domain_events_authenticated_select ON public.domain_events;
CREATE POLICY domain_events_authenticated_select ON public.domain_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND (
        public.current_user_scope_type() = 'tenant'
        OR (
          public.current_user_scope_type() = 'client'
          AND (
            payload->>'client_id' = public.current_user_scope_id()::text
            OR (
              payload ? 'sender_id'
              AND (payload->>'sender_id') IN (
                SELECT s.id::text
                FROM public.senders s
                WHERE s.client_id = public.current_user_scope_id()
              )
            )
          )
        )
        OR (
          public.current_user_scope_type() = 'sender'
          AND payload->>'sender_id' = public.current_user_scope_id()::text
        )
      )
    )
  );

CREATE INDEX IF NOT EXISTS idx_domain_events_payload_client_id
  ON public.domain_events ((payload->>'client_id'))
  WHERE payload ? 'client_id';

CREATE INDEX IF NOT EXISTS idx_domain_events_payload_sender_id
  ON public.domain_events ((payload->>'sender_id'))
  WHERE payload ? 'sender_id';

SELECT pg_advisory_unlock(hashtext('202601071020_domain_events_scope_rls'));
COMMIT;