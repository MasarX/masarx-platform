-- Credential mutation and credential-backed dispatch are trusted service paths.
BEGIN;
REVOKE ALL ON FUNCTION
  public.persist_ingress_execution_url_v1(UUID,TEXT,UUID),
  public.enqueue_comms_whatsapp(UUID,TEXT,TEXT,UUID,UUID,JSONB),
  public.send_comms_reply(UUID,UUID,JSONB,UUID),
  public.send_comms_reply_core(UUID,UUID,JSONB,UUID),
  public.send_comms_reply_core_impl(UUID,UUID,JSONB,UUID),
  public.dispatch_alert_trigger(UUID),
  public.run_alert_dispatch_worker(),
  public.dispatch_outbound_call_inline(UUID,JSONB)
FROM PUBLIC, anon, authenticated;

-- SQL workflow/trigger/cron callers run as their definer owner; no browser grant
-- or additional worker role is needed.
GRANT EXECUTE ON FUNCTION
  public.persist_ingress_execution_url_v1(UUID,TEXT,UUID),
  public.enqueue_comms_whatsapp(UUID,TEXT,TEXT,UUID,UUID,JSONB),
  public.send_comms_reply(UUID,UUID,JSONB,UUID),
  public.send_comms_reply_core(UUID,UUID,JSONB,UUID),
  public.send_comms_reply_core_impl(UUID,UUID,JSONB,UUID),
  public.dispatch_alert_trigger(UUID),
  public.run_alert_dispatch_worker(),
  public.dispatch_outbound_call_inline(UUID,JSONB)
TO service_role;
COMMIT;
