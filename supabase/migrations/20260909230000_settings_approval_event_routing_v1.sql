BEGIN;
SET LOCAL lock_timeout = '10s';
DO $repair$
DECLARE
  v_row public.settings%ROWTYPE;
  v_current jsonb;
  v_events jsonb;
  v_event jsonb;
  v_next jsonb;
  v_path text[];
  v_template uuid;
  v_count integer;
  v_schema integer;
BEGIN
  -- Match upsert_settings_value_v1: approved open versions before settings.
  PERFORM 1 FROM public.settings_versions
  WHERE category='domain_event_policy' AND scope_type='global' AND scope_id IS NULL
    AND effective_until IS NULL AND approved_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'settings approval routing: approved baseline missing'; END IF;
  SELECT * INTO STRICT v_row FROM public.settings
  WHERE category='domain_event_policy' AND scope_type='global' AND scope_id IS NULL
  FOR UPDATE;
  v_current := v_row.cached_value;
  IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'settings approval routing: malformed policy';
  END IF;
  -- Match resolve_domain_event_policy: nested events if present, flat otherwise.
  IF v_current ? 'events' THEN
    v_events := v_current->'events';
    IF jsonb_typeof(v_events) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'settings approval routing: malformed events';
    END IF;
    v_path := ARRAY['events','settings_change.requested'];
  ELSE
    v_events := v_current;
    v_path := ARRAY['settings_change.requested'];
  END IF;
  IF v_events ? 'settings_change.requested' THEN
    v_event := v_events->'settings_change.requested';
    IF jsonb_typeof(v_event) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'settings approval routing: malformed event';
    END IF;
    -- Existing explicit routing/disable decisions are owned configuration.
    IF v_event ? 'enabled' AND jsonb_typeof(v_event->'enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'settings approval routing: malformed enabled flag';
    END IF;
    IF v_event ? 'workflow_template_id' THEN
      IF jsonb_typeof(v_event->'workflow_template_id') IS DISTINCT FROM 'string'
        OR NULLIF(btrim(v_event->>'workflow_template_id'),'') IS NULL THEN
        RAISE EXCEPTION 'settings approval routing: malformed template';
      END IF;
      PERFORM (v_event->>'workflow_template_id')::uuid;
      RETURN;
    END IF;
    IF v_event ? 'enabled' THEN
      IF jsonb_typeof(v_event->'enabled') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'settings approval routing: malformed enabled flag';
      END IF;
      IF v_event->'enabled' = 'false'::jsonb THEN RETURN; END IF;
    END IF;
  ELSE
    v_event := '{}'::jsonb;
  END IF;
  SELECT count(*), (array_agg(id))[1] INTO v_count,v_template
  FROM public.workflow_templates WHERE name='settings_change_approval_v1'
    AND status='active' AND scope_type='global' AND scope_id IS NULL;
  IF v_count <> 1 THEN RAISE EXCEPTION 'settings approval routing: ambiguous template'; END IF;
  SELECT schema_version INTO STRICT v_schema FROM public.settings_versions
  WHERE id=v_row.settings_version_id AND approved_at IS NOT NULL;
  v_next := jsonb_set(v_current,v_path,
    v_event || jsonb_build_object('workflow_template_id',v_template::text),true);
  PERFORM public.upsert_settings_value_v1('domain_event_policy','global',NULL,
    v_next,v_schema,'Repair missing settings approval event routing');
END;
$repair$;
COMMIT;
