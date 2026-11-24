BEGIN;

SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE FUNCTION public.label_renderer_url_allowed_v1(p_url text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(p_url !~ '[[:cntrl:][:space:]\\?#]' AND (
    public.outbound_url_allowed_v1(p_url, NULL)
    OR (
      p_url COLLATE "C" ~ '^http://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[0-9]{1,5})?(/[^?#]*)?/functions/v1/label-renderer$'
      -- Only a database-level deployment setting can authorize this exact local URL.
      AND EXISTS (
        SELECT 1
        FROM pg_db_role_setting s
        JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = current_database() AND s.setrole = 0
          AND ('app.local_label_renderer_url=' || p_url) = ANY (s.setconfig)
      )
    )
  ), false);
$function$;

REVOKE ALL ON FUNCTION public.label_renderer_url_allowed_v1(text)
  FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;

-- Use the replayed definitions so existing Vault, scope and queue handling stays in place.
DO $migration$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef('public.label_provider_seal_value_v1(jsonb,text,uuid,jsonb)'::regprocedure);
  anchor := $anchor$    v_invoke_secret := NULLIF(provider->>'invoke_secret', '');$anchor$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'label provider seal validation anchor missing';
  END IF;
  EXECUTE replace(definition, anchor, $validation$    IF NULLIF(provider->>'invoke_url', '') IS NOT NULL
       AND NOT public.label_renderer_url_allowed_v1(provider->>'invoke_url') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
    END IF;
$validation$ || anchor);

  definition := pg_get_functiondef('public.resolve_label_renderer_edge_config_v1(uuid)'::regprocedure);
  anchor := 'IF v_url IS NULL OR NOT public.outbound_url_allowed_v1(v_url, NULL) THEN';
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'label renderer dispatch validation anchor missing';
  END IF;
  EXECUTE replace(definition, anchor, 'IF NOT public.label_renderer_url_allowed_v1(v_url) THEN');

  definition := pg_get_functiondef('public.validate_outbound_integration_write_v1()'::regprocedure);
  anchor := '    v_url := NEW.url;';
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'outbound queue renderer validation anchor missing';
  END IF;
  EXECUTE replace(definition, anchor, $validation$    IF NEW.renderer_request_id IS NOT NULL AND NEW.renderer_credential_ref IS NOT NULL THEN
      IF NOT public.label_renderer_url_allowed_v1(NEW.url) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
      END IF;
      RETURN NEW;
    END IF;
    v_url := NEW.url;$validation$);
END;
$migration$;

COMMIT;
