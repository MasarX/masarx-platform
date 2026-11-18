-- Redact evidence; executable credentials belong in the existing auth binding.
-- New inline executable credentials fail validation instead of becoming broken
-- REDACTED runtime configuration. Existing unchanged columns are not backfilled.
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261025003000_plugin_studio_redaction_boundary_v1'));

CREATE FUNCTION public.plugin_studio_sensitive_key_v1(p_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $$
 SELECT COALESCE(lower(p_key) NOT IN ('public_token','plugin_key','mapping_key','handler_key',
 'sort_key','idempotency_key','public_key','publishable_key','max_tokens','token_type',
 'credential_type','next_page_token','page_token') AND (
 regexp_replace(lower(p_key),'[^a-z0-9]','','g') ~ '(token|secret|password|passwd|passphrase|pwd|credential|apikey|privatekey|cookie|signature|hmac)'
 OR lower(p_key) ~ '^(key|(api|access|master|license|secret|private|client|auth)key)$'
 OR lower(p_key) ~ '[_. -]key$' OR p_key ~ '[a-z0-9]Key$'
 OR regexp_replace(lower(p_key),'[^a-z0-9]','','g') IN
 ('authorization','proxyauthorization','cookie','setcookie','apikey','xapikey','password',
  'privatekey','secret','token','authtoken','accesstoken','refreshtoken','issuedtoken',
  'clientsecret','vendorsecret','signingsecret','sharedsecret','credential','credentials',
  'signature','xsignature','xauthtoken','xwebhooktoken','xinternaledgetoken','d360apikey',
  'xhubsignature','xhubsignature256','xapisignature','xauthsignature','xhmacsignature','hmac')),FALSE);
$$;


CREATE FUNCTION public.plugin_studio_input_v1(p_value JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $input$
 SELECT COALESCE(
  p_value#>'{normalized_contract,route,body_sample}',p_value#>'{normalized_contract,webhook,sample_payload}',
  p_value#>'{route,body_sample}',p_value#>'{webhook,sample_payload}',
  p_value#>'{source_payload,sample_rows,0}',p_value#>'{source_payload,sample}',p_value#>'{source_payload,payload}',
  p_value->'sample_payload',p_value->'body_sample','{}'::jsonb);
$input$;

CREATE FUNCTION public.plugin_studio_reference_v1(p_value JSONB,p_input JSONB DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $reference$
DECLARE value_text TEXT; tokens TEXT[];
BEGIN
 IF jsonb_typeof(p_value)='object' THEN
  RETURN COALESCE(p_value->>'type'='SecretRef' AND p_value ? 'id'
   AND p_value-ARRAY['type','id']='{}'::jsonb
   AND (p_value->>'id') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',FALSE);
 END IF;
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
 value_text:=p_value#>>'{}';
 IF value_text ~* '^((Bearer|Basic)[[:space:]]+)?\{\{[A-Za-z0-9_.$\[\]-]+\}\}$' THEN RETURN TRUE; END IF;
 value_text:=regexp_replace(value_text,'^(Bearer|Basic)[[:space:]]+','','i');
 IF value_text !~ '^\$(\.[A-Za-z0-9_$-]+|\[([0-9]+|\*)\])+$' THEN RETURN FALSE; END IF;
 value_text:=regexp_replace(value_text,'^\$\.?','');
 value_text:=regexp_replace(regexp_replace(value_text,'\[\*\]','.0','g'),'\[([0-9]+)\]','.\1','g');
 value_text:=regexp_replace(value_text,'^\.','');
 tokens:=string_to_array(value_text,'.');
 RETURN p_input IS NOT NULL AND (p_input#>tokens) IS NOT NULL;
END;
$reference$;

CREATE FUNCTION public.plugin_studio_redact_text_v1(p_value TEXT,p_input JSONB DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $text$
DECLARE result TEXT:=p_value; parts TEXT[]; decoded_key TEXT; decoded_value JSONB;
 pair RECORD; value_parts TEXT[]; scan_text TEXT; key_start INT; value_start INT;
 key_pattern CONSTANT TEXT:='(\m([A-Za-z0-9_.-]+(?:[[:blank:]]+[Kk]ey)?)[[:space:]]*[=:][[:space:]]*)';
BEGIN
 IF p_value IS NULL THEN RETURN NULL; END IF;
 -- URL userinfo is a credential even when its username is not a sensitive key.
 result:=regexp_replace(result,'(//|\\/\\/)[^/?#[:space:]]+@','\1REDACTED@','g');
 FOR parts IN SELECT regexp_matches(result,
  '(\m(?:bearer|basic)[[:space:]]+)(\{\{[^{}[:space:]]+\}\}|[^[:space:]"'',;}]+)','gi') LOOP
  IF NOT COALESCE(public.plugin_studio_reference_v1(to_jsonb(parts[2]),p_input),FALSE) THEN
   result:=replace(result,parts[1]||parts[2],parts[1]||'REDACTED');
  END IF;
 END LOOP;

 scan_text:=result;
 FOR pair IN SELECT m,n FROM regexp_matches(scan_text,key_pattern,'g') WITH ORDINALITY AS matches(m,n) LOOP
  IF NOT public.plugin_studio_sensitive_key_v1(pair.m[2]) THEN CONTINUE; END IF;
  key_start:=regexp_instr(scan_text,key_pattern,1,pair.n::int,0);
  value_start:=regexp_instr(scan_text,key_pattern,1,pair.n::int,1);
  -- Preserve only a real host:port authority, never userinfo credentials.
  IF substr(scan_text,GREATEST(1,key_start-2),2)='//'
   AND substr(scan_text,value_start) ~ '^[0-9]+([/?#]|$)' THEN CONTINUE; END IF;
  value_parts:=regexp_match(substr(scan_text,value_start),
   '^(?!bearer[[:space:]]|basic[[:space:]])(\{\{[^{}[:space:]]+\}\}|\$\.[A-Za-z0-9_.$\[\]-]+|[^&[:space:]"'',;}]+)','i');
  IF value_parts IS NOT NULL AND NOT public.plugin_studio_reference_v1(to_jsonb(value_parts[1]),p_input) THEN
   result:=replace(result,pair.m[1]||value_parts[1],pair.m[1]||'REDACTED');
  END IF;
 END LOOP;
 FOR parts IN SELECT regexp_matches(result,
  '("([^"\\]*(?:\\.[^"\\]*)*)"[[:space:]]*:[[:space:]]*")([^"\\]*(?:\\.[^"\\]*)*)(")','g') LOOP
  BEGIN
   decoded_key:=('"'||parts[2]||'"')::jsonb#>>'{}';
   decoded_value:=('"'||parts[3]||'"')::jsonb;
  EXCEPTION WHEN data_exception THEN
   result:=replace(result,parts[1]||parts[3]||parts[4],'"REDACTED":"REDACTED"');
   CONTINUE;
  END;
  IF public.plugin_studio_sensitive_key_v1(decoded_key)
   AND NOT COALESCE(public.plugin_studio_reference_v1(decoded_value,p_input),FALSE) THEN
   result:=replace(result,parts[1]||parts[3]||parts[4],parts[1]||'REDACTED'||parts[4]);
  END IF;
 END LOOP;
 RETURN result;
END;
$text$;

-- Match the current handler's asString(source_path) / truthy source_column fallback.
CREATE FUNCTION public.plugin_studio_rule_source_v1(p_rule JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $source$
DECLARE source TEXT; column_value JSONB:=p_rule->'source_column'; column_text TEXT;
 trim_chars TEXT:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
 source:=CASE WHEN jsonb_typeof(p_rule->'source_path')='string' THEN btrim(p_rule->>'source_path',trim_chars) ELSE '' END;
 IF source<>'' THEN RETURN source; END IF;
 IF column_value IS NULL OR column_value IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) THEN RETURN ''; END IF;
 -- Array#toString joins recursively; object values stringify to [object Object].
 WITH RECURSIVE elements(value,path) AS (
  SELECT column_value,ARRAY[]::bigint[]
  UNION ALL
  SELECT child.value,e.path||child.n FROM elements e
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.value)='array' THEN e.value ELSE '[]'::jsonb END)
    WITH ORDINALITY child(value,n)
 ) SELECT string_agg(CASE jsonb_typeof(value) WHEN 'null' THEN '' WHEN 'array' THEN ''
    WHEN 'object' THEN '[object Object]' ELSE value#>>'{}' END,',' ORDER BY path)
   INTO column_text FROM elements WHERE jsonb_typeof(value)<>'array' OR value='[]'::jsonb;
 RETURN btrim('column:'||column_text,trim_chars);
END;
$source$;

CREATE FUNCTION public.plugin_studio_redact_json_v1(
 p_value JSONB,p_context TEXT DEFAULT 'data',p_persist BOOLEAN DEFAULT FALSE,p_key TEXT DEFAULT NULL,p_input JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $json$
DECLARE result JSONB; entry RECORD; context TEXT; safe_text TEXT; sensitive BOOLEAN; sample_key TEXT;
 rules JSONB; rule JSONB; preview JSONB; target TEXT; source TEXT; rule_source TEXT;
 parsed_body JSONB; safe_body JSONB;
 trim_chars TEXT:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
 IF p_value IS NULL OR p_value='null'::jsonb THEN RETURN p_value; END IF;
 IF p_context NOT IN ('data','source','openapi','openapi_members','openapi_components','discriminator','reference_map','literal_values',
  'definition','schema_members','mapping','config','headers','auth','response') THEN
  RAISE EXCEPTION 'Invalid Plugin Studio redaction context' USING ERRCODE='22023';
 END IF;
 IF p_context='reference_map' THEN RETURN p_value; END IF;
 p_input:=COALESCE(p_input,public.plugin_studio_input_v1(p_value));
 sensitive:=public.plugin_studio_sensitive_key_v1(p_key);

 IF sensitive AND p_context IN ('data','source','response','config','headers','auth') THEN
  IF (p_context IN ('config','headers','auth') OR jsonb_typeof(p_value)='object')
   AND public.plugin_studio_reference_v1(p_value,p_input) THEN RETURN p_value; END IF;
  IF jsonb_typeof(p_value)='object' AND p_value->>'type'='SecretRef'
   AND p_persist AND p_context IN ('config','headers','auth') THEN
   RAISE EXCEPTION 'Inline credentials are not allowed in executable configuration; use an auth binding' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(p_value)='string' THEN
   IF p_context IN ('config','headers','auth') AND btrim(p_value#>>'{}')='' THEN RETURN p_value; END IF;
   IF p_persist AND p_context IN ('config','headers','auth') THEN
    RAISE EXCEPTION 'Inline credentials are not allowed in executable configuration; use an auth binding' USING ERRCODE='23514';
   END IF;
   RETURN to_jsonb('REDACTED'::text);
  END IF;
 END IF;

 IF jsonb_typeof(p_value)='string' THEN
  IF p_key='body_template' AND p_context IN ('data','source','response','config','headers','auth') THEN
   BEGIN parsed_body:=(p_value#>>'{}')::jsonb;
   EXCEPTION WHEN data_exception THEN parsed_body:=NULL; END;
   IF jsonb_typeof(parsed_body) IN ('object','array') THEN
    safe_body:=public.plugin_studio_redact_json_v1(parsed_body,
     CASE WHEN p_context IN ('config','headers','auth') THEN 'config' ELSE 'data' END,p_persist,NULL,p_input);
    RETURN CASE WHEN safe_body IS DISTINCT FROM parsed_body THEN to_jsonb(safe_body::text) ELSE p_value END;
   END IF;
  END IF;
  -- Mapping expressions and selector names are definitions, not sample values.
  IF p_context='mapping' OR (p_context IN ('config','auth')
   AND COALESCE(p_key,'') NOT IN ('url','url_template','upstream_url','server_url','body_template')) THEN RETURN p_value; END IF;
  safe_text:=public.plugin_studio_redact_text_v1(p_value#>>'{}',p_input);
  IF p_persist AND p_context IN ('config','headers','auth') AND safe_text IS DISTINCT FROM p_value#>>'{}' THEN
   RAISE EXCEPTION 'Inline credentials are not allowed in executable configuration; use an auth binding'
    USING ERRCODE='23514';
  END IF;
  RETURN to_jsonb(safe_text);
 END IF;
 IF jsonb_typeof(p_value)='array' THEN
  SELECT COALESCE(jsonb_agg(public.plugin_studio_redact_json_v1(value,p_context,p_persist,p_key,p_input) ORDER BY n),'[]'::jsonb)
   INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY a(value,n);
  RETURN result;
 END IF;
 IF jsonb_typeof(p_value)<>'object' THEN RETURN p_value; END IF;
 IF NOT sensitive AND p_context='source' AND (jsonb_typeof(p_value->'openapi')='string' OR jsonb_typeof(p_value->'swagger')='string')
  AND (jsonb_typeof(p_value->'paths')='object' OR jsonb_typeof(p_value->'webhooks')='object'
   OR jsonb_typeof(p_value->'components')='object') THEN
  p_context:='openapi';
 END IF;
 sample_key:=CASE WHEN jsonb_typeof(p_value->'target_field')='string' THEN btrim(p_value->>'target_field',trim_chars) ELSE '' END;
 source:=public.plugin_studio_rule_source_v1(p_value);
 result:='{}'::jsonb;
 FOR entry IN SELECT key,value FROM jsonb_each(p_value) LOOP
  context:=p_context;
  IF sensitive AND p_context IN ('data','source','response','config','headers','auth') THEN
   NULL; -- Credential descendants retain their context, even under definition-like child names.
  ELSIF p_context='schema_members' THEN
   -- Member names are identifiers even when a schema has no type/properties keys.
   context:='definition';
  ELSIF p_context='openapi_members' THEN
   context:='openapi';
  ELSIF p_context='openapi_components' THEN
   CASE
    WHEN entry.key='schemas' THEN context:='schema_members';
    WHEN entry.key IN ('responses','parameters','examples','requestBodies','headers','securitySchemes','links','callbacks','pathItems') THEN context:='openapi_members';
    WHEN entry.key ~* '^x-' THEN context:='data';
    ELSE context:='openapi';
   END CASE;
  ELSIF p_context='discriminator' THEN
   CASE
    WHEN entry.key='mapping' THEN context:='reference_map';
    WHEN entry.key='propertyName' THEN context:='mapping';
    WHEN entry.key ~* '^x-' THEN context:='data';
    ELSE context:='openapi';
   END CASE;
  ELSIF p_context='definition' THEN
   CASE
    WHEN entry.key ~* '^x-' THEN context:='data';
    WHEN entry.key IN ('properties','patternProperties','$defs','definitions','dependentSchemas') THEN context:='schema_members';
    WHEN entry.key IN ('example','examples') THEN context:='data';
    WHEN entry.key='discriminator' THEN context:='discriminator';
    WHEN entry.key IN ('default','const','enum','required','dependentRequired','type','$ref','$schema','$id','$anchor',
     '$dynamicRef','$dynamicAnchor','format','pattern','contentEncoding','contentMediaType') THEN context:='mapping';
    ELSE NULL;
   END CASE;
  ELSIF p_context='openapi' THEN
   CASE
    WHEN entry.key ~* '^x-' THEN context:='data';
    WHEN entry.key='schema' THEN context:='definition';
    WHEN entry.key='definitions' THEN context:='schema_members';
    WHEN entry.key='components' THEN context:='openapi_components';
    WHEN entry.key IN ('webhooks','variables','headers','content','encoding','links','callbacks','examples','scopes') THEN context:='openapi_members';
    -- Link literal names survive, but strings still need text redaction; operation parameters are arrays.
    WHEN entry.key='parameters' AND jsonb_typeof(entry.value)='object' THEN context:='literal_values';
    WHEN entry.key IN ('$ref','operationId','name','required','enum','default','security') THEN context:='mapping';
    WHEN entry.key IN ('example','value') THEN context:='data';
    ELSE NULL;
   END CASE;
  ELSIF p_context='auth' AND entry.key IN ('mode','auth_type','auth_config_id','latest_auth_config_id','credential_binding_id',
   'latest_auth_type','header','scheme','credential_key','username_key','password_key','query_param','fields') THEN
   context:='mapping';
  ELSIF p_context='source' THEN
   IF entry.key IN ('sample_schema','input_schema') THEN
    context:='definition';
   END IF;
  ELSIF p_context IN ('config','auth','mapping','response') THEN
   CASE entry.key
    WHEN 'auth' THEN context:='auth';
    WHEN 'auth_bindings' THEN context:='auth';
    WHEN 'input_schema' THEN context:='definition';
    WHEN 'sample_schema' THEN context:='definition';
    WHEN 'target_schema' THEN context:='definition';
    WHEN 'mapping_config' THEN context:='mapping';
    WHEN 'mapping_suggestion' THEN context:='mapping';
    WHEN 'request_mappings' THEN context:='mapping';
    WHEN 'response_mapping' THEN context:='mapping';
    WHEN 'response_mapping_config' THEN context:='mapping';
    WHEN 'source_path' THEN context:='mapping';
    WHEN 'source_paths' THEN context:='mapping';
    WHEN 'target_field' THEN context:='mapping';
    WHEN 'value_path' THEN context:='mapping';
    WHEN 'normalized_contract' THEN context:='source';
    WHEN 'outbound_suggestions' THEN context:='config';
    WHEN 'outbound_operations' THEN context:='config';
    WHEN 'request_config' THEN context:='config';
    WHEN 'inbound_config' THEN context:='config';
    WHEN 'headers_template' THEN context:='headers';
    WHEN 'metadata' THEN context:='data';
    WHEN 'sample_value' THEN context:='data';
    WHEN 'sample_payload' THEN context:='data';
    WHEN 'body_sample' THEN context:='data';
    WHEN 'sample_rows' THEN context:='data';
    WHEN 'coerced_preview' THEN context:='data';
    ELSE NULL;
   END CASE;
  END IF;
  IF p_context='definition' AND entry.key IN ('default','const')
   AND public.plugin_studio_sensitive_key_v1(p_key) AND jsonb_typeof(entry.value)='string'
   AND public.plugin_studio_redact_text_v1(entry.value#>>'{}',p_input) IS DISTINCT FROM entry.value#>>'{}' THEN
   IF p_persist THEN
    RAISE EXCEPTION 'Inline credentials are not allowed in executable configuration; use an auth binding'
     USING ERRCODE='23514';
   END IF;
   result:=result||jsonb_build_object(entry.key,public.plugin_studio_redact_text_v1(entry.value#>>'{}',p_input));
   CONTINUE;
  END IF;
  IF NOT sensitive AND entry.key='coerced_preview' AND p_context IN ('data','response') AND jsonb_typeof(entry.value)='object' THEN
   -- A renamed sample is still evidence, even when no coercion was needed.
   preview:=public.plugin_studio_redact_json_v1(entry.value,'data',FALSE,NULL,p_input);
   IF jsonb_typeof(p_value#>'{mapping_config,fields}')='array' THEN
    rules:=p_value#>'{mapping_config,fields}';
   ELSIF jsonb_typeof(p_value#>'{mapping_config,column_mappings}')='array' THEN
    rules:=p_value#>'{mapping_config,column_mappings}';
   ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('target_field',key,'source_path',
     CASE jsonb_typeof(value) WHEN 'array' THEN (SELECT item#>>'{}' FROM jsonb_array_elements(value)
      WITH ORDINALITY a(item,n) WHERE jsonb_typeof(item)='string' ORDER BY n LIMIT 1)
      WHEN 'string' THEN value#>>'{}' END)),'[]'::jsonb)
     INTO rules FROM jsonb_each(CASE WHEN jsonb_typeof(p_value#>'{mapping_config,field_mappings}')='object'
      THEN p_value#>'{mapping_config,field_mappings}' ELSE '{}'::jsonb END);
   END IF;
   FOR rule IN SELECT value FROM jsonb_array_elements(rules) WHERE jsonb_typeof(value)='object' LOOP
    target:=CASE WHEN jsonb_typeof(rule->'target_field')='string' THEN btrim(rule->>'target_field',trim_chars) ELSE '' END;
    rule_source:=public.plugin_studio_rule_source_v1(rule);
    IF target<>'' AND preview ? target AND (public.plugin_studio_sensitive_key_v1(target) OR CASE
     WHEN left(rule_source,7)='column:' THEN public.plugin_studio_sensitive_key_v1(substr(rule_source,8))
     ELSE EXISTS(SELECT 1 FROM regexp_split_to_table(rule_source,'[.\[\]]+') segment
      WHERE public.plugin_studio_sensitive_key_v1(segment)) END) THEN
     preview:=jsonb_set(preview,ARRAY[target],public.plugin_studio_redact_json_v1(preview->target,'data',FALSE,'token',p_input));
    END IF;
   END LOOP;
   result:=result||jsonb_build_object(entry.key,preview);
  ELSIF NOT sensitive AND p_context<>'literal_values' AND entry.key IN ('original_value','converted_value','sample_value')
   AND (public.plugin_studio_sensitive_key_v1(sample_key) OR CASE
    WHEN left(source,7)='column:' THEN public.plugin_studio_sensitive_key_v1(substr(source,8))
    ELSE EXISTS(SELECT 1 FROM regexp_split_to_table(source,'[.\[\]]+') segment
     WHERE public.plugin_studio_sensitive_key_v1(segment)) END) THEN
   result:=result||jsonb_build_object(entry.key,public.plugin_studio_redact_json_v1(entry.value,'data',FALSE,'token',p_input));
  ELSE
   result:=result||jsonb_build_object(entry.key,public.plugin_studio_redact_json_v1(entry.value,context,p_persist,
    CASE WHEN sensitive AND p_context IN ('data','source','response','config','headers','auth') THEN p_key ELSE entry.key END,p_input));
  END IF;
 END LOOP;
 RETURN result;
END;
$json$;

CREATE FUNCTION public.plugin_studio_redact_write_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path TO public,extensions,pg_temp AS $trigger$
DECLARE fields TEXT[]; field TEXT; context TEXT; row_value JSONB:=to_jsonb(NEW); prior JSONB;
BEGIN
 IF TG_OP='UPDATE' THEN prior:=to_jsonb(OLD); END IF;
 fields:=CASE TG_TABLE_NAME
  WHEN 'integration_plugins' THEN ARRAY['metadata']
  WHEN 'integration_plugin_versions' THEN ARRAY['source_payload','normalized_contract','inbound_config','mapping_config',
   'outbound_operations','auth_bindings','validation_summary','metadata']
  WHEN 'mapping_operation_reports' THEN ARRAY['request_summary','conversion_summary','diagnostics_summary','result_payload','decision_refs','next_steps']
 END;
 FOREACH field IN ARRAY fields LOOP
  -- UPDATE OF also fires for col=col; never rewrite an unchanged historical value.
  IF TG_OP='UPDATE' AND row_value->field IS NOT DISTINCT FROM prior->field THEN CONTINUE; END IF;
  context:=CASE field WHEN 'source_payload' THEN 'source' WHEN 'normalized_contract' THEN 'source'
   WHEN 'inbound_config' THEN 'config' WHEN 'mapping_config' THEN 'mapping'
   WHEN 'outbound_operations' THEN 'config' WHEN 'auth_bindings' THEN 'auth'
   WHEN 'result_payload' THEN 'response' ELSE 'data' END;
  row_value:=jsonb_set(row_value,ARRAY[field],public.plugin_studio_redact_json_v1(row_value->field,context,context IN ('config','auth','mapping'),NULL,public.plugin_studio_input_v1(row_value)));
 END LOOP;
 NEW:=jsonb_populate_record(NEW,row_value);
 RETURN NEW;
END;
$trigger$;

CREATE TRIGGER trg_plugin_studio_metadata_redaction_v1
 BEFORE INSERT OR UPDATE OF metadata ON public.integration_plugins
 FOR EACH ROW EXECUTE FUNCTION public.plugin_studio_redact_write_v1();
CREATE TRIGGER trg_plugin_studio_version_redaction_v1
 BEFORE INSERT OR UPDATE OF source_payload,normalized_contract,inbound_config,mapping_config,outbound_operations,auth_bindings,validation_summary,metadata
 ON public.integration_plugin_versions FOR EACH ROW EXECUTE FUNCTION public.plugin_studio_redact_write_v1();
CREATE TRIGGER trg_plugin_studio_report_redaction_v1
 BEFORE INSERT OR UPDATE OF request_summary,conversion_summary,diagnostics_summary,result_payload,decision_refs,next_steps
 ON public.mapping_operation_reports FOR EACH ROW EXECUTE FUNCTION public.plugin_studio_redact_write_v1();

-- Preserve the current shared direct-save body, including its authorization order.
DO $direct_save$
DECLARE fn REGPROCEDURE:='public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure; body TEXT;
 marker TEXT:='  IF p_artifact ? ''workflow_binding''';
 preparation TEXT:=E'  v_mapping_config := public.plugin_studio_redact_json_v1(v_mapping_config,''mapping'',TRUE,NULL,public.plugin_studio_input_v1(p_artifact));\n'
  ||E'  v_response_mapping_config := public.plugin_studio_redact_json_v1(v_response_mapping_config,''mapping'',TRUE,NULL,public.plugin_studio_input_v1(p_artifact));\n'
  ||E'  v_request_config := public.plugin_studio_redact_json_v1(v_request_config,''config'',TRUE,NULL,public.plugin_studio_input_v1(p_artifact));\n\n';
BEGIN
 body:=pg_get_functiondef(fn);
 IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
  OR position('public.plugin_studio_redact_json_v1' IN body)>0 THEN
  RAISE EXCEPTION 'Expected one unmodified current mapping artifact preparation seam';
 END IF;
 EXECUTE replace(body,marker,preparation||marker);
END;
$direct_save$;

CREATE FUNCTION api.integration_plugin_redact_projection_v1(p_value JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path TO public,extensions,pg_temp AS $$
 SELECT public.plugin_studio_redact_json_v1(p_value,'response',FALSE);
$$;


CREATE FUNCTION api.integration_plugin_validate_config_v1(p_value JSONB,p_input JSONB DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path TO public,extensions,pg_temp AS $validate$
BEGIN
 PERFORM public.plugin_studio_redact_json_v1(p_value,'config',TRUE,NULL,p_input);
 RETURN TRUE;
END;
$validate$;

REVOKE ALL ON FUNCTION api.integration_plugin_validate_config_v1(JSONB,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.integration_plugin_validate_config_v1(JSONB,JSONB) TO authenticated,service_role;

REVOKE ALL ON FUNCTION public.plugin_studio_sensitive_key_v1(TEXT),public.plugin_studio_reference_v1(JSONB,JSONB),public.plugin_studio_input_v1(JSONB),
 public.plugin_studio_redact_text_v1(TEXT,JSONB),public.plugin_studio_rule_source_v1(JSONB),public.plugin_studio_redact_json_v1(JSONB,TEXT,BOOLEAN,TEXT,JSONB),
 public.plugin_studio_redact_write_v1(),api.integration_plugin_redact_projection_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plugin_studio_sensitive_key_v1(TEXT),public.plugin_studio_reference_v1(JSONB,JSONB),public.plugin_studio_input_v1(JSONB),
 public.plugin_studio_redact_text_v1(TEXT,JSONB),public.plugin_studio_rule_source_v1(JSONB),public.plugin_studio_redact_json_v1(JSONB,TEXT,BOOLEAN,TEXT,JSONB),
 api.integration_plugin_redact_projection_v1(JSONB) TO authenticated,service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
