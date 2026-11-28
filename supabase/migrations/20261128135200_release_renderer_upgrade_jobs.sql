-- The transport gate is in the migration history by this point. Unlock only jobs
-- held by the pre-apply trigger, while keeping the original requests and attempts.
DO $release$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '10s', true);
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.outbound_calls'::pg_catalog.regclass AND tgname = 'hold_renderer_upgrade_job_v1'
  ) THEN
    DROP TRIGGER hold_renderer_upgrade_job_v1 ON public.outbound_calls;
    UPDATE public.outbound_calls
       SET scheduled_at = now()
     WHERE renderer_request_id IS NOT NULL
       AND status = 'pending_edge' AND scheduled_at = 'infinity';
    DROP FUNCTION public.hold_renderer_upgrade_job_v1();
  END IF;
END;
$release$;
