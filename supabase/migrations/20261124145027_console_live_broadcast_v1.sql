BEGIN;

CREATE FUNCTION public.console_live_topic_allowed_v1(p_topic text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
AS $function$
  SELECT COALESCE(
    public.current_user_scope_type() = 'tenant'
    AND CASE $1
      WHEN 'console-live:' || public.current_user_org_id()::text || ':routes'
        THEN public.user_has_capability_v1('routes.read')
          AND public.route_run_actor_can_read_v1(public.current_user_org_id(), NULL, NULL)
      WHEN 'console-live:' || public.current_user_org_id()::text || ':shipments'
        THEN public.user_has_capability_v1('shipments.read')
      ELSE false
    END,
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.console_live_topic_allowed_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.console_live_topic_allowed_v1(text) TO authenticated;

CREATE POLICY console_live_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension = 'broadcast' AND topic = (SELECT realtime.topic())
    AND public.console_live_topic_allowed_v1((SELECT realtime.topic()))
  );

-- Keep the namespace private even when another feature has a wider permissive policy.
CREATE POLICY console_live_read_boundary ON realtime.messages
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    (topic NOT LIKE 'console-live:%' AND COALESCE((SELECT realtime.topic()), '') NOT LIKE 'console-live:%')
    OR (extension = 'broadcast' AND topic = (SELECT realtime.topic())
        AND public.console_live_topic_allowed_v1((SELECT realtime.topic())))
  );

CREATE POLICY console_live_anon_boundary ON realtime.messages
  AS RESTRICTIVE FOR SELECT TO anon
  USING (topic NOT LIKE 'console-live:%' AND COALESCE((SELECT realtime.topic()), '') NOT LIKE 'console-live:%');

CREATE POLICY console_live_client_write_boundary ON realtime.messages
  AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (topic NOT LIKE 'console-live:%' AND COALESCE((SELECT realtime.topic()), '') NOT LIKE 'console-live:%');

CREATE FUNCTION public.console_live_publish_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_scope text := TG_ARGV[0];
  v_old_org uuid;
  v_new_org uuid;
  v_org uuid;
  v_dedupe text;
  v_previous_topic text := COALESCE(current_setting('realtime.topic', true), '');
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_org := OLD.organization_id;
    IF TG_TABLE_NAME = 'tasks' THEN
      IF OLD.resource_type IS DISTINCT FROM 'route_stop' THEN v_old_org := NULL; END IF;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_org := NEW.organization_id;
    IF TG_TABLE_NAME = 'tasks' THEN
      IF NEW.resource_type IS DISTINCT FROM 'route_stop' THEN v_new_org := NULL; END IF;
    END IF;
  END IF;

  FOREACH v_org IN ARRAY ARRAY[v_old_org, v_new_org] LOOP
    IF v_org IS NULL THEN
      CONTINUE;
    END IF;
    v_dedupe := 'app.console_live_' || v_scope || '_' || replace(v_org::text, '-', '_');
    IF current_setting(v_dedupe, true) IS DISTINCT FROM 'sent' THEN
      PERFORM realtime.send('{}'::jsonb, 'invalidate', 'console-live:' || v_org::text || ':' || v_scope, true);
      PERFORM set_config(v_dedupe, 'sent', true);
    END IF;
  END LOOP;
  PERFORM set_config('realtime.topic', v_previous_topic, true);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.console_live_publish_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.console_live_publish_v1() TO service_role;

CREATE TRIGGER trg_console_live_shipments
AFTER INSERT OR UPDATE OR DELETE ON public.shipments
FOR EACH ROW EXECUTE FUNCTION public.console_live_publish_v1('shipments');

CREATE TRIGGER trg_console_live_route_runs
AFTER INSERT OR UPDATE OR DELETE ON public.route_runs
FOR EACH ROW EXECUTE FUNCTION public.console_live_publish_v1('routes');

CREATE TRIGGER trg_console_live_route_stops
AFTER INSERT OR UPDATE OR DELETE ON public.route_stops
FOR EACH ROW EXECUTE FUNCTION public.console_live_publish_v1('routes');

CREATE TRIGGER trg_console_live_route_assignments
AFTER INSERT OR UPDATE OR DELETE ON public.route_run_assignments
FOR EACH ROW EXECUTE FUNCTION public.console_live_publish_v1('routes');

CREATE TRIGGER trg_console_live_route_tasks
AFTER INSERT OR UPDATE OR DELETE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.console_live_publish_v1('routes');

CREATE TRIGGER trg_console_live_location_pings
AFTER INSERT ON public.location_pings
FOR EACH ROW EXECUTE FUNCTION public.console_live_publish_v1('routes');

COMMIT;
