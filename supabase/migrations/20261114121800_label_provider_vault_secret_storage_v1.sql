-- Keep renderer bearer credentials out of every readable settings version/cache.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION public.label_provider_seal_value_v1(
  p_value JSONB, p_scope_type TEXT, p_scope_id UUID, p_existing JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $seal$
DECLARE
  providers JSONB := '[]'::jsonb;
  entry RECORD;
  provider JSONB;
  previous JSONB;
  secret TEXT;
  reference UUID;
  prefix TEXT := 'label_provider/' || public.normalize_scope_type_v1(p_scope_type, FALSE) || '/' || COALESCE(p_scope_id::text, 'global') || '/';
BEGIN
  IF p_value IS NULL THEN RETURN p_value; END IF;
  IF NOT p_value ? 'providers' THEN
    PERFORM public.plugin_studio_redact_json_v1(p_value, 'config', TRUE);
    RETURN p_value;
  END IF;
  IF jsonb_typeof(p_value->'providers') <> 'array' THEN
    RAISE EXCEPTION 'Label providers must be an array' USING ERRCODE = '23514';
  END IF;
  FOR entry IN SELECT value, n FROM jsonb_array_elements(p_value->'providers') WITH ORDINALITY a(value,n) LOOP
    provider := entry.value;
    previous := p_existing->'providers'->(entry.n::int - 1);
    IF jsonb_typeof(provider) <> 'object' THEN
      RAISE EXCEPTION 'Label provider must be an object' USING ERRCODE = '23514';
    END IF;
    IF provider ? 'invoke_secret' AND jsonb_typeof(provider->'invoke_secret') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Label provider credential must be text' USING ERRCODE = '23514';
    END IF;
    secret := NULLIF(provider->>'invoke_secret', '');
    reference := NULL;
    IF secret = 'REDACTED' OR provider->'invoke_secret_ref' = '"REDACTED"'::jsonb THEN
      RAISE EXCEPTION 'Label provider preview markers require an authorized settings request' USING ERRCODE = '23514';
    END IF;
    IF secret IS NOT NULL THEN
      -- Reuse the corresponding version reference when a cache repeats its value.
      SELECT s.id INTO reference FROM vault.decrypted_secrets s
      WHERE s.id = NULLIF(previous#>>'{invoke_secret_ref,id}', '')::uuid
        AND starts_with(s.name, prefix) AND s.decrypted_secret = secret;
      IF reference IS NULL THEN
        reference := vault.create_secret(secret, prefix || gen_random_uuid(), 'Label renderer invoke credential', NULL);
      END IF;
      provider := (provider - 'invoke_secret') || jsonb_build_object('invoke_secret_ref',
        jsonb_build_object('type','SecretRef','id',reference));
    ELSIF provider ? 'invoke_secret_ref' THEN
      IF jsonb_typeof(provider->'invoke_secret_ref') <> 'object'
         OR provider#>>'{invoke_secret_ref,type}' IS DISTINCT FROM 'SecretRef' THEN
        RAISE EXCEPTION 'Invalid label provider credential reference' USING ERRCODE = '42501';
      END IF;
      reference := NULLIF(provider#>>'{invoke_secret_ref,id}', '')::uuid;
      IF NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = reference AND starts_with(s.name, prefix)) THEN
        RAISE EXCEPTION 'Label provider credential reference outside settings scope' USING ERRCODE = '42501';
      END IF;
      provider := provider - 'invoke_secret';
    ELSE
      provider := provider - 'invoke_secret';
    END IF;
    providers := providers || jsonb_build_array(provider);
  END LOOP;
  p_value := jsonb_set(p_value, '{providers}', providers);
  PERFORM public.plugin_studio_redact_json_v1(p_value, 'config', TRUE);
  RETURN p_value;
END;
$seal$;

CREATE FUNCTION public.label_provider_seal_settings_write_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $write$
DECLARE previous JSONB;
BEGIN
  IF NEW.category <> 'label_provider' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'settings_versions' THEN
    IF TG_OP = 'UPDATE' THEN previous := OLD.value; END IF;
    NEW.value := public.label_provider_seal_value_v1(NEW.value, NEW.scope_type, NEW.scope_id, previous);
  ELSE
    SELECT v.value INTO previous FROM public.settings_versions v WHERE v.id = NEW.settings_version_id;
    NEW.cached_value := public.label_provider_seal_value_v1(NEW.cached_value, NEW.scope_type, NEW.scope_id, previous);
  END IF;
  RETURN NEW;
END;
$write$;
CREATE TRIGGER a00_label_provider_seal_value
BEFORE INSERT OR UPDATE OF value ON public.settings_versions
FOR EACH ROW EXECUTE FUNCTION public.label_provider_seal_settings_write_v1();
CREATE TRIGGER a00_label_provider_seal_cache
BEFORE INSERT OR UPDATE OF cached_value ON public.settings
FOR EACH ROW EXECUTE FUNCTION public.label_provider_seal_settings_write_v1();

CREATE FUNCTION public.label_provider_redact_legacy_cache_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $cache$
DECLARE category TEXT;
BEGIN
  SELECT v.category INTO category FROM public.settings_versions v WHERE v.id = NEW.settings_version_id;
  IF category = 'label_provider' OR starts_with(NEW.cache_key, 'label_provider:') THEN
    NEW.resolved_value := public.settings_preview_redact_v1(NEW.resolved_value);
  END IF;
  RETURN NEW;
END;
$cache$;
CREATE TRIGGER a00_label_provider_redact_legacy_cache
BEFORE INSERT OR UPDATE OF resolved_value ON public.settings_cache
FOR EACH ROW EXECUTE FUNCTION public.label_provider_redact_legacy_cache_v1();

CREATE FUNCTION public.resolve_label_provider_invoke_secret_v1(p_provider JSONB)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $resolve$
  SELECT s.decrypted_secret FROM vault.decrypted_secrets s
  WHERE s.id = NULLIF(p_provider#>>'{invoke_secret_ref,id}', '')::uuid
    AND p_provider#>>'{invoke_secret_ref,type}' = 'SecretRef'
    AND starts_with(s.name, 'label_provider/');
$resolve$;

CREATE FUNCTION public.label_provider_request_value_v1(p_value JSONB, p_scope_type TEXT, p_scope_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $request$
DECLARE
  baseline JSONB;
  providers JSONB := '[]'::jsonb;
  entry RECORD;
  provider JSONB;
  previous JSONB;
  explicit_secret BOOLEAN;
BEGIN
  SELECT cached_value INTO baseline FROM public.settings
  WHERE category = 'label_provider' AND scope_type = p_scope_type AND scope_id IS NOT DISTINCT FROM p_scope_id;
  IF jsonb_typeof(p_value->'providers') IS DISTINCT FROM 'array' THEN RETURN p_value; END IF;
  FOR entry IN SELECT value,n FROM jsonb_array_elements(p_value->'providers') WITH ORDINALITY a(value,n) LOOP
    provider := entry.value;
    previous := baseline->'providers'->(entry.n::int - 1);
    explicit_secret := NULLIF(provider->>'invoke_secret', '') IS NOT NULL AND provider->>'invoke_secret' <> 'REDACTED';
    IF explicit_secret THEN
      provider := provider - 'invoke_secret_ref';
    ELSIF provider->>'invoke_secret' = 'REDACTED' OR provider ? 'invoke_secret_ref' THEN
      -- Never copy a global or foreign credential into a tenant-controlled URL.
      IF previous->'invoke_secret_ref' IS NULL OR provider->>'name' IS DISTINCT FROM previous->>'name' THEN
        RAISE EXCEPTION 'Label provider credential must be set for this scope' USING ERRCODE = '23514';
      END IF;
      IF provider->'invoke_secret_ref' IS NOT NULL
         AND provider->'invoke_secret_ref' <> '"REDACTED"'::jsonb
         AND provider->'invoke_secret_ref' IS DISTINCT FROM previous->'invoke_secret_ref' THEN
        RAISE EXCEPTION 'Label provider credential reference outside settings scope' USING ERRCODE = '42501';
      END IF;
      provider := (provider - 'invoke_secret') || jsonb_build_object('invoke_secret_ref', previous->'invoke_secret_ref');
    END IF;
    providers := providers || jsonb_build_array(provider);
  END LOOP;
  RETURN jsonb_set(p_value, '{providers}', providers);
END;
$request$;

CREATE FUNCTION public.upsert_label_provider_settings_v1(p_scope_type TEXT, p_scope_id UUID, p_value JSONB, p_reason TEXT DEFAULT NULL)
RETURNS TABLE(settings_id UUID, settings_version_id UUID, settings_version_number INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp
AS $upsert$
DECLARE schema_version INT;
BEGIN
  SELECT max(version) INTO schema_version FROM public.schema_registry WHERE category = 'label_provider' AND is_active;
  RETURN QUERY SELECT * FROM public.upsert_settings_value_v1('label_provider', p_scope_type, p_scope_id, p_value, schema_version, p_reason);
END;
$upsert$;

REVOKE ALL ON FUNCTION public.label_provider_seal_value_v1(JSONB,TEXT,UUID,JSONB),
  public.label_provider_seal_settings_write_v1(), public.label_provider_redact_legacy_cache_v1(), public.resolve_label_provider_invoke_secret_v1(JSONB),
  public.label_provider_request_value_v1(JSONB,TEXT,UUID), public.upsert_label_provider_settings_v1(TEXT,UUID,JSONB,TEXT)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_label_provider_settings_v1(TEXT,UUID,JSONB,TEXT) TO service_role;

DO $contracts$
DECLARE definition TEXT; signature REGPROCEDURE; prior TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.resolve_label_renderer_invoke_config_v1(uuid)'::regprocedure,
    'public.resolve_label_renderer_invoke_request_v1(integer,jsonb)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(signature);
    prior := 'v_secret := NULLIF(v_provider->>''invoke_secret'', '''');';
    IF (length(definition)-length(replace(definition,prior,'')))/length(prior) <> 1 THEN
      RAISE EXCEPTION 'Expected one renderer credential read in %', signature;
    END IF;
    EXECUTE replace(definition, prior, 'v_secret := public.resolve_label_provider_invoke_secret_v1(v_provider);');
  END LOOP;
  definition := pg_get_functiondef('public.ops_sweeper_label_renderer_cron_guard(jsonb)'::regprocedure);
  prior := '(v_provider->>''invoke_secret'' IS NULL OR v_provider->>''invoke_secret'' = ''EXAMPLE_PASSWORD'')';
  IF position(prior IN definition) = 0 THEN RAISE EXCEPTION 'Expected renderer cron credential guard'; END IF;
  definition := replace(definition, prior, '(public.resolve_label_provider_invoke_secret_v1(v_provider) IS NULL OR public.resolve_label_provider_invoke_secret_v1(v_provider) = ''EXAMPLE_PASSWORD'')');
  definition := replace(definition, 'public.invoke_label_renderer(integer)', 'public.invoke_label_renderer(integer,jsonb)');
  EXECUTE replace(definition, 'SELECT public.invoke_label_renderer(%s);', 'SELECT public.invoke_label_renderer(%s,NULL::jsonb);');

  definition := pg_get_functiondef('public.request_settings_change_v1(text,text,uuid,jsonb,text,timestamptz)'::regprocedure);
  prior := '  IF jsonb_path_exists(p_value, ''$.** ? (@ == "REDACTED")'') THEN';
  IF position(prior IN definition) = 0 THEN RAISE EXCEPTION 'Expected settings preview-marker guard'; END IF;
  EXECUTE replace(definition, prior, $prepare$  IF p_category = 'label_provider' THEN
    p_value := public.label_provider_request_value_v1(p_value, v_scope_type, v_scope_id);
  END IF;

$prepare$ || prior);

  -- Audit snapshots must not reintroduce the plaintext removed from settings.
  definition := pg_get_functiondef('public.audit_redact_row(text,text,jsonb)'::regprocedure);
  prior := '  v_cols := COALESCE(v_cols, ''{}''::text[]);';
  IF position(prior IN definition) = 0 THEN RAISE EXCEPTION 'Expected audit redaction rule seam'; END IF;
  -- Run before the early return for tables without a row-driven audit rule.
  prior := '  IF NOT FOUND THEN';
  IF position(prior IN definition) = 0 THEN RAISE EXCEPTION 'Expected audit rule lookup'; END IF;
  EXECUTE replace(definition, prior, $audit$  IF p_table_schema = 'public' AND
     ((p_table_name IN ('settings','settings_versions') AND p_row->>'category' = 'label_provider')
       OR (p_table_name = 'settings_cache' AND starts_with(p_row->>'cache_key', 'label_provider:'))) THEN
    p_row := public.settings_preview_redact_v1(p_row);
  END IF;

$audit$ || prior);
END;
$contracts$;

-- Each row moves once; a reference-only replay creates no new Vault entry.
UPDATE public.settings_versions SET value = value WHERE category = 'label_provider';
UPDATE public.settings s SET cached_value = v.value
FROM public.settings_versions v WHERE s.category = 'label_provider' AND v.id = s.settings_version_id;
UPDATE public.settings_cache SET resolved_value = public.settings_preview_redact_v1(resolved_value)
WHERE starts_with(cache_key, 'label_provider:') OR settings_version_id IN
  (SELECT id FROM public.settings_versions WHERE category = 'label_provider');
UPDATE public.audit_table_changes SET
  row_old = public.settings_preview_redact_v1(row_old), row_new = public.settings_preview_redact_v1(row_new)
WHERE schema_name = 'public' AND table_name IN ('settings','settings_versions','settings_cache')
  AND (row_old->>'category' = 'label_provider' OR row_new->>'category' = 'label_provider'
    OR starts_with(row_old->>'cache_key', 'label_provider:') OR starts_with(row_new->>'cache_key', 'label_provider:')
    OR (table_name = 'settings_cache' AND COALESCE(row_old->>'settings_version_id',row_new->>'settings_version_id') IN
      (SELECT id::text FROM public.settings_versions WHERE category = 'label_provider')));
COMMIT;
