-- Synthetic rollback-only native proof. Offline source checks are not a DB pass.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(352);
SELECT is(public.plugin_studio_redact_json_v1('{"key":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"key":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited key redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"key":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested key');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"key":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under key');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"key":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under key');
SELECT is(public.plugin_studio_redact_json_v1('{"apikeY":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"apikeY":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited apikeY redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"apikeY":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested apikeY');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"apikeY":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under apikeY');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"apikeY":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under apikeY');
SELECT is(public.plugin_studio_redact_json_v1('{"ACCESSKEY":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"ACCESSKEY":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited ACCESSKEY redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"ACCESSKEY":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested ACCESSKEY');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"ACCESSKEY":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under ACCESSKEY');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"ACCESSKEY":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under ACCESSKEY');
SELECT is(public.plugin_studio_redact_json_v1('{"masterkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"masterkey":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited masterkey redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"masterkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested masterkey');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"masterkey":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under masterkey');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"masterkey":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under masterkey');
SELECT is(public.plugin_studio_redact_json_v1('{"licensekey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"licensekey":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited licensekey redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"licensekey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested licensekey');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"licensekey":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under licensekey');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"licensekey":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under licensekey');
SELECT is(public.plugin_studio_redact_json_v1('{"secretkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"secretkey":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited secretkey redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"secretkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested secretkey');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"secretkey":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under secretkey');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"secretkey":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under secretkey');
SELECT is(public.plugin_studio_redact_json_v1('{"privatekey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"privatekey":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited privatekey redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"privatekey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested privatekey');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"privatekey":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under privatekey');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"privatekey":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under privatekey');
SELECT is(public.plugin_studio_redact_json_v1('{"clientkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"clientkey":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited clientkey redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"clientkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested clientkey');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"clientkey":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under clientkey');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"clientkey":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under clientkey');
SELECT is(public.plugin_studio_redact_json_v1('{"authkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"authkey":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited authkey redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"authkey":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested authkey');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"authkey":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under authkey');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"authkey":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under authkey');
SELECT is(public.plugin_studio_redact_json_v1('{"passphrase":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"passphrase":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited passphrase redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"passphrase":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested passphrase');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"passphrase":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under passphrase');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"passphrase":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under passphrase');
SELECT is(public.plugin_studio_redact_json_v1('{"pwd":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"pwd":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited pwd redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"pwd":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested pwd');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"pwd":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under pwd');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"pwd":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under pwd');
SELECT is(public.plugin_studio_redact_json_v1('{"cookie":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"cookie":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited cookie redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"cookie":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested cookie');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"cookie":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under cookie');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"cookie":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under cookie');
SELECT is(public.plugin_studio_redact_json_v1('{"signature":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"signature":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited signature redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"signature":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested signature');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"signature":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under signature');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"signature":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under signature');
SELECT is(public.plugin_studio_redact_json_v1('{"hmac":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"hmac":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited hmac redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"hmac":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested hmac');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"hmac":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under hmac');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"hmac":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under hmac');
SELECT is(public.plugin_studio_redact_json_v1('{"primary_key":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}'::jsonb,'data'),'{"primary_key":{"rows":[{"public_key":"REDACTED","count":3,"enabled":true}]}}'::jsonb,'inherited primary_key redacts string leaves and preserves numbers and booleans');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":{"primary_key":{"rows":[{"public_key":"synthetic-private","count":3,"enabled":true}]}}}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks nested primary_key');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"primary_key":"$.literalSecret"}}'::jsonb)$case$,'23514',NULL::text,'unknown reference is a value under primary_key');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"primary_key":"$.input.value"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'known input reference survives under primary_key');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"apiToken":[1,true,false,null,{"nested":42}]}}'::jsonb),TRUE,'credential containers containing no string values are valid');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"Authorization":{"type":"SecretRef","id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830","value":"synthetic-private"}}}'::jsonb)$case$,'23514',NULL::text,'preview rejects a malformed SecretRef');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"Authorization":{"type":"SecretRef","id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"}}}'::jsonb),TRUE,'preview accepts a closed SecretRef');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"{\"apiKey\":{\"nested\":[\"synthetic-private\"]}}"}}'::jsonb)$case$,'23514',NULL::text,'serialized body credentials are blocked');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"apiKey=one apiKey=two"}}'::jsonb)$case$,'23514',NULL::text,'all repeated credential assignments in a text body are blocked');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"https://token.example:8443/?scope=public"}}'::jsonb),TRUE,'URL authorities are not mistaken for credential assignments');
SELECT is(public.plugin_studio_redact_text_v1(('https' || '://x-access-token:synthetic-private@github.example/x')),'https://REDACTED@github.example/x','credential-shaped URL userinfo is fully redacted');
SELECT is(public.plugin_studio_redact_text_v1(('https' || '://user:synthetic-private@host.example/x')),'https://REDACTED@host.example/x','ordinary usernames do not hide URL passwords');
SELECT is(public.plugin_studio_redact_text_v1('https://synthetic-private@host.example/x'),'https://REDACTED@host.example/x','token-only URL userinfo is redacted');
SELECT is(public.plugin_studio_redact_json_v1(('{"url":"https' || '://u:p@ss@host.example/x"}')::jsonb,'data'),'{"url":"https://REDACTED@host.example/x"}'::jsonb,'raw at signs inside passwords do not expose their tail');
SELECT is(public.plugin_studio_redact_text_v1($text${"url":"https:\/\/u:p@ss@host.example/x"}$text$),$text${"url":"https:\/\/REDACTED@host.example/x"}$text$,'raw JSON-escaped evidence redacts through the final userinfo separator');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('raw_body',$text$https:\/\/synthetic-private@host.example/x$text$),'response'),jsonb_build_object('raw_body',$text$https:\/\/REDACTED@host.example/x$text$),'raw response strings redact JSON-escaped token-only userinfo');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1(jsonb_build_object('request_config',jsonb_build_object('body_template',$text$raw: https:\/\/u:p@ss@host.example/x$text$)))$case$,'23514',NULL::text,'config persistence rejects JSON-escaped raw URL credentials');
SELECT is(public.plugin_studio_redact_text_v1('https://host.example?mail=a@b'),'https://host.example?mail=a@b','query at signs are outside the URL authority');
SELECT is(public.plugin_studio_redact_text_v1($text$https:\/\/host.example:8443/x$text$),$text$https:\/\/host.example:8443/x$text$,'plain JSON-escaped host ports remain intact');
SELECT throws_ok(($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"https$case$ || $case$://x-access-token:synthetic-private@host.example/x"}}'::jsonb)$case$),'23514',NULL::text,'preview validator blocks credential-shaped URL userinfo');
SELECT throws_ok(($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"https$case$ || $case$://user:synthetic-private@host.example/x"}}'::jsonb)$case$),'23514',NULL::text,'preview validator blocks URL passwords under ordinary usernames');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"https://synthetic-private@host.example/x"}}'::jsonb)$case$,'23514',NULL::text,'preview validator blocks token-only URL userinfo');
SELECT is(public.plugin_studio_redact_json_v1(('{"url":"https' || '://user:synthetic-private@host.example:8443/x"}')::jsonb,'data'),'{"url":"https://REDACTED@host.example:8443/x"}'::jsonb,'data projections redact URL credentials and retain the host port');
SELECT is(public.plugin_studio_redact_json_v1('{"url":"https://synthetic-private@host.example/x"}'::jsonb,'response'),'{"url":"https://REDACTED@host.example/x"}'::jsonb,'response projections redact token-only URL userinfo');
SELECT is(api.integration_plugin_redact_projection_v1(('{"result":{"url":"https' || '://user:synthetic-private@host.example/x"}}')::jsonb),'{"result":{"url":"https://REDACTED@host.example/x"}}'::jsonb,'response RPC projects URL userinfo safely');
SELECT is(public.plugin_studio_reference_v1('"$[0].token"'::jsonb,'[{"token":"synthetic-input"}]'::jsonb),TRUE,'root-array numeric references resolve against known input');
SELECT is(public.plugin_studio_reference_v1('"$[*].token"'::jsonb,'[{"token":"synthetic-input"}]'::jsonb),TRUE,'root-array wildcard references resolve against known input');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"{ \"apiToken\": 3, \"enabled\": true }"}}'::jsonb),TRUE,'serialized numeric and boolean bodies retain ordinary values');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"{\"apiKey\":\"$.literalSecret\"}"}}'::jsonb)$case$,'23514',NULL::text,'serialized unknown references are values');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"body_template":"{\"apiKey\":\"$.input.value\"}"}}'::jsonb,'{"input":{"value":"synthetic-input"}}'::jsonb),TRUE,'serialized known references survive');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"apiKey":{"input_schema":{"properties":{"public_key":"synthetic-private"}}}}}'::jsonb)$case$,'23514',NULL::text,'definition-like child names cannot escape inherited credentials');
SELECT throws_ok($case$SELECT api.integration_plugin_validate_config_v1('{"request_config":{"apiKey":"$.constructor"}}'::jsonb,'{}'::jsonb)$case$,'23514',NULL::text,'prototype paths are not known JSON inputs');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"sort_key":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret sort_key');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"idempotency_key":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret idempotency_key');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"public_key":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret public_key');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"publishable_key":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret publishable_key');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"max_tokens":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret max_tokens');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"token_type":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret token_type');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"credential_type":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret credential_type');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"next_page_token":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret next_page_token');
SELECT is(api.integration_plugin_validate_config_v1('{"request_config":{"page_token":"public-reference"}}'::jsonb),TRUE,'preview retains nonsecret page_token');
SELECT is(api.integration_plugin_redact_projection_v1('{"request_config":{"body_template":"{\"apiKey\":{\"nested\":[\"synthetic-private\"]}}"}}'::jsonb)#>>'{request_config,body_template}','{"apiKey":{"nested":["REDACTED"]}}'::jsonb::text,'string-form body evidence retains its type and redacts nested values');
SELECT ok(has_function_privilege('authenticated','api.integration_plugin_validate_config_v1(jsonb,jsonb)','EXECUTE'),'authenticated preview can use the shared validator');
SELECT ok(NOT has_function_privilege('anon','api.integration_plugin_validate_config_v1(jsonb,jsonb)','EXECUTE'),'anonymous preview has no validator privilege');
SELECT ok(EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid='public.providers'::regclass AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=2 AND (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.n<=i.indnkeyatts)=ARRAY['organization_id','name']),'providers has a valid nonpartial unique conflict index');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('apiToken','synthetic-private'),'source',FALSE)->>'apiToken','REDACTED','source redacts apiToken');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('apiToken','synthetic-private'))->>'apiToken','REDACTED','response redacts apiToken');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('apiToken','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable apiToken is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('apiToken','{{provider.token}}'),'config',TRUE)->>'apiToken','{{provider.token}}','reference survives for apiToken');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('AccessKey','synthetic-private'),'source',FALSE)->>'AccessKey','REDACTED','source redacts AccessKey');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('AccessKey','synthetic-private'))->>'AccessKey','REDACTED','response redacts AccessKey');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('AccessKey','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable AccessKey is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('AccessKey','{{provider.token}}'),'config',TRUE)->>'AccessKey','{{provider.token}}','reference survives for AccessKey');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('accessKey','synthetic-private'),'source',FALSE)->>'accessKey','REDACTED','source redacts accessKey');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('accessKey','synthetic-private'))->>'accessKey','REDACTED','response redacts accessKey');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('accessKey','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable accessKey is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('accessKey','{{provider.token}}'),'config',TRUE)->>'accessKey','{{provider.token}}','reference survives for accessKey');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('signingKey','synthetic-private'),'source',FALSE)->>'signingKey','REDACTED','source redacts signingKey');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('signingKey','synthetic-private'))->>'signingKey','REDACTED','response redacts signingKey');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('signingKey','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable signingKey is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('signingKey','{{provider.token}}'),'config',TRUE)->>'signingKey','{{provider.token}}','reference survives for signingKey');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('encryptionKey','synthetic-private'),'source',FALSE)->>'encryptionKey','REDACTED','source redacts encryptionKey');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('encryptionKey','synthetic-private'))->>'encryptionKey','REDACTED','response redacts encryptionKey');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('encryptionKey','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable encryptionKey is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('encryptionKey','{{provider.token}}'),'config',TRUE)->>'encryptionKey','{{provider.token}}','reference survives for encryptionKey');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('masterKey','synthetic-private'),'source',FALSE)->>'masterKey','REDACTED','source redacts masterKey');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('masterKey','synthetic-private'))->>'masterKey','REDACTED','response redacts masterKey');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('masterKey','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable masterKey is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('masterKey','{{provider.token}}'),'config',TRUE)->>'masterKey','{{provider.token}}','reference survives for masterKey');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('clientKey','synthetic-private'),'source',FALSE)->>'clientKey','REDACTED','source redacts clientKey');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('clientKey','synthetic-private'))->>'clientKey','REDACTED','response redacts clientKey');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('clientKey','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable clientKey is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('clientKey','{{provider.token}}'),'config',TRUE)->>'clientKey','{{provider.token}}','reference survives for clientKey');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('licenseKey','synthetic-private'),'source',FALSE)->>'licenseKey','REDACTED','source redacts licenseKey');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('licenseKey','synthetic-private'))->>'licenseKey','REDACTED','response redacts licenseKey');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('licenseKey','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable licenseKey is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('licenseKey','{{provider.token}}'),'config',TRUE)->>'licenseKey','{{provider.token}}','reference survives for licenseKey');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('aws.access.key','synthetic-private'),'source',FALSE)->>'aws.access.key','REDACTED','source redacts aws.access.key');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('aws.access.key','synthetic-private'))->>'aws.access.key','REDACTED','response redacts aws.access.key');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('aws.access.key','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable aws.access.key is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('aws.access.key','{{provider.token}}'),'config',TRUE)->>'aws.access.key','{{provider.token}}','reference survives for aws.access.key');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('signing key','synthetic-private'),'source',FALSE)->>'signing key','REDACTED','source redacts signing key');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('signing key','synthetic-private'))->>'signing key','REDACTED','response redacts signing key');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('signing key','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable signing key is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('signing key','{{provider.token}}'),'config',TRUE)->>'signing key','{{provider.token}}','reference survives for signing key');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('sort_key','public-reference'),'config',TRUE)->>'sort_key','public-reference','non-secret sort_key survives');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('primary_key','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'Azure primary_key is a credential');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('idempotency_key','public-reference'),'config',TRUE)->>'idempotency_key','public-reference','non-secret idempotency_key survives');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('public_key','public-reference'),'config',TRUE)->>'public_key','public-reference','non-secret public_key survives');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('publishable_key','public-reference'),'config',TRUE)->>'publishable_key','public-reference','non-secret publishable_key survives');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('max_tokens','public-reference'),'config',TRUE)->>'max_tokens','public-reference','non-secret max_tokens survives');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('token_type','public-reference'),'config',TRUE)->>'token_type','public-reference','non-secret token_type survives');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('credential_type','public-reference'),'config',TRUE)->>'credential_type','public-reference','non-secret credential_type survives');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('next_page_token','public-reference'),'config',TRUE)->>'next_page_token','public-reference','non-secret next_page_token survives');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('page_token','public-reference'),'config',TRUE)->>'page_token','public-reference','non-secret page_token survives');
SELECT is(public.plugin_studio_redact_json_v1('{"apiToken":123,"AccessKey":true}'::jsonb,'config',TRUE),'{"apiToken":123,"AccessKey":true}'::jsonb,'numeric and boolean credential-shaped values survive');
SELECT is(public.plugin_studio_redact_json_v1('{"rows":[{"nested":{"apiToken":"synthetic-private"}}]}'::jsonb,'source',FALSE)#>>'{rows,0,nested,apiToken}','REDACTED','nested array and object evidence is redacted');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1('{"rows":[{"nested":{"AccessKey":"synthetic-private"}}]}'::jsonb,'config',TRUE)$case$,'23514',NULL::text,'nested array and object credentials are rejected');

SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('api_token','synthetic-private'),'source',FALSE)->>'api_token','REDACTED','source redacts api_token');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('api_token','synthetic-private'))->>'api_token','REDACTED','response redacts api_token');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('api_token','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable api_token is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('api_token','{{provider.token}}'),'config',TRUE)->>'api_token','{{provider.token}}','reference survives for api_token');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('x-access-token','synthetic-private'),'source',FALSE)->>'x-access-token','REDACTED','source redacts x-access-token');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('x-access-token','synthetic-private'))->>'x-access-token','REDACTED','response redacts x-access-token');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('x-access-token','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable x-access-token is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('x-access-token','{{provider.token}}'),'config',TRUE)->>'x-access-token','{{provider.token}}','reference survives for x-access-token');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('secret_key','synthetic-private'),'source',FALSE)->>'secret_key','REDACTED','source redacts secret_key');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('secret_key','synthetic-private'))->>'secret_key','REDACTED','response redacts secret_key');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('secret_key','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable secret_key is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('secret_key','{{provider.token}}'),'config',TRUE)->>'secret_key','{{provider.token}}','reference survives for secret_key');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('access_key','synthetic-private'),'source',FALSE)->>'access_key','REDACTED','source redacts access_key');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('access_key','synthetic-private'))->>'access_key','REDACTED','response redacts access_key');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('access_key','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable access_key is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('access_key','{{provider.token}}'),'config',TRUE)->>'access_key','{{provider.token}}','reference survives for access_key');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('api_secret','synthetic-private'),'source',FALSE)->>'api_secret','REDACTED','source redacts api_secret');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('api_secret','synthetic-private'))->>'api_secret','REDACTED','response redacts api_secret');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('api_secret','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable api_secret is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('api_secret','{{provider.token}}'),'config',TRUE)->>'api_secret','{{provider.token}}','reference survives for api_secret');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('webhook_secret','synthetic-private'),'source',FALSE)->>'webhook_secret','REDACTED','source redacts webhook_secret');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('webhook_secret','synthetic-private'))->>'webhook_secret','REDACTED','response redacts webhook_secret');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('webhook_secret','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable webhook_secret is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('webhook_secret','{{provider.token}}'),'config',TRUE)->>'webhook_secret','{{provider.token}}','reference survives for webhook_secret');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('aws_secret_access_key','synthetic-private'),'source',FALSE)->>'aws_secret_access_key','REDACTED','source redacts aws_secret_access_key');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('aws_secret_access_key','synthetic-private'))->>'aws_secret_access_key','REDACTED','response redacts aws_secret_access_key');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('aws_secret_access_key','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable aws_secret_access_key is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('aws_secret_access_key','{{provider.token}}'),'config',TRUE)->>'aws_secret_access_key','{{provider.token}}','reference survives for aws_secret_access_key');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('passwd','synthetic-private'),'source',FALSE)->>'passwd','REDACTED','source redacts passwd');
SELECT is(api.integration_plugin_redact_projection_v1(jsonb_build_object('passwd','synthetic-private'))->>'passwd','REDACTED','response redacts passwd');
SELECT throws_ok($case$SELECT public.plugin_studio_redact_json_v1(jsonb_build_object('passwd','synthetic-private'),'config',TRUE)$case$,'23514',NULL::text,'executable passwd is rejected');
SELECT is(public.plugin_studio_redact_json_v1(jsonb_build_object('passwd','{{provider.token}}'),'config',TRUE)->>'passwd','{{provider.token}}','reference survives for passwd');
SELECT is(public.plugin_studio_redact_json_v1('{"public_token":"public-reference"}'::jsonb,'source',FALSE)->>'public_token','public-reference','deliberate public token survives');
SELECT is(public.plugin_studio_redact_json_v1('{"plugin_key":"plugin-name","mapping_key":"mapping-name","handler_key":"outbound_http"}'::jsonb,'config',TRUE),'{"plugin_key":"plugin-name","mapping_key":"mapping-name","handler_key":"outbound_http"}'::jsonb,'public registry identifiers survive');


-- OAS 3.1.1 named maps are definitions; their keys are not extension fields.
CREATE FUNCTION pg_temp.sg40_openapi_named_maps() RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $fixture$
 SELECT '{
 "openapi": "3.1.1",
 "paths": {
  "/x-api-key": {
   "post": {
    "parameters": [
     {
      "name": "x-api-key",
      "in": "query",
      "schema": {
       "type": "string"
      },
      "examples": {
       "x-api-key": {
        "value": {
         "public_token": "public-reference"
        }
       }
      }
     }
    ],
    "callbacks": {
     "x-api-key": {
      "{$request.query.callback}?public_token=reference": {
       "post": {}
      }
     }
    },
    "requestBody": {
     "content": {
      "application/x-api-key": {
       "schema": {
        "type": "object",
        "properties": {
         "x-api-key": {
          "type": "string"
         }
        }
       },
       "examples": {
        "x-api-key": {
         "value": {
          "public_token": "public-reference"
         }
        }
       },
       "encoding": {
        "x-api-key": {
         "headers": {
          "x-api-key": {
           "description": "Public header definition",
           "schema": {
            "type": "string"
           },
           "examples": {
            "x-api-key": {
             "value": {
              "public_token": "public-reference"
             }
            }
           }
          }
         }
        }
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Public response",
      "headers": {
       "x-api-key": {
        "description": "Public header definition",
        "schema": {
         "type": "string"
        },
        "examples": {
         "x-api-key": {
          "value": {
           "public_token": "public-reference"
          }
         }
        }
       }
      },
      "content": {
       "application/x-api-key": {
        "schema": {
         "type": "string"
        },
        "examples": {
         "x-api-key": {
          "value": {
           "public_token": "public-reference"
          }
         }
        }
       }
      },
      "links": {
       "x-api-key": {
        "operationId": "public-operation",
        "parameters": {
         "x-api-key": "public-reference",
         "metadata": {
          "x-api-key": "public-reference"
         }
        }
       }
      }
     }
    }
   }
  }
 },
 "webhooks": {
  "x-api-key": {
   "post": {}
  }
 },
 "servers": [
  {
   "url": "https://{x-api-key}.example.invalid",
   "variables": {
    "x-api-key": {
     "default": "public-reference",
     "enum": [
      "public-reference"
     ],
     "description": "Public host reference"
    }
   }
  }
 ],
 "components": {
  "schemas": {
   "x-api-key": {
    "type": "object",
    "properties": {
     "x-api-key": {
      "description": "Public tracking key",
      "maxLength": 64
     }
    },
    "$defs": {
     "x-api-key": {
      "type": "string"
     }
    },
    "discriminator": {
     "propertyName": "x-api-key",
     "mapping": {
      "x-api-key": "#/components/schemas/x-api-key",
      "headers_template": "https://example.invalid/Schema?api_key=public-reference"
     }
    }
   }
  },
  "responses": {
   "x-api-key": {
    "description": "Public response"
   }
  },
  "parameters": {
   "x-api-key": {
    "name": "x-api-key",
    "in": "header",
    "schema": {
     "type": "string"
    },
    "examples": {
     "x-api-key": {
      "value": {
       "public_token": "public-reference"
      }
     }
    }
   }
  },
  "examples": {
   "x-api-key": {
    "value": {
     "public_token": "public-reference"
    }
   }
  },
  "requestBodies": {
   "x-api-key": {
    "content": {
     "application/x-api-key": {
      "schema": {
       "type": "string"
      }
     }
    }
   }
  },
  "headers": {
   "x-api-key": {
    "description": "Public header definition",
    "schema": {
     "type": "string"
    },
    "examples": {
     "x-api-key": {
      "value": {
       "public_token": "public-reference"
      }
     }
    }
   }
  },
  "securitySchemes": {
   "x-api-key": {
    "type": "oauth2",
    "flows": {
     "implicit": {
      "authorizationUrl": "https://example.invalid/oauth",
      "scopes": {
       "x-api-key": "Public scope"
      }
     }
    }
   }
  },
  "links": {
   "next": {
    "operationId": "public-operation",
    "parameters": {
     "x-api-key": "public-reference",
     "metadata": {
      "x-api-key": "public-reference"
     }
    }
   },
   "components": {
    "operationId": "public-operation",
    "parameters": {
     "x-api-key": "public-reference",
     "metadata": {
      "x-api-key": "public-reference"
     }
    }
   }
  },
  "callbacks": {
   "x-api-key": {
    "{$request.query.callback}?public_token=reference": {
     "post": {}
    }
   }
  },
  "pathItems": {
   "x-api-key": {
    "post": {}
   }
  }
 }
}'::jsonb;
$fixture$;

CREATE FUNCTION pg_temp.sg40_openapi_link_literals() RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $links$
 SELECT '{"openapi":"3.1.1","paths":{},"components":{"links":{"next":{"parameters":{"x-api-key":"public-reference","session":"Bearer sg40-raw","callback":"https://example.invalid/?token=sg40-raw","runtime":"$request.query.token","response":"$response.body#/token","template":"{{context.public_token}}","nested":{"x-api-key":"public-reference","headers_template":{"service":"public-reference"},"array":["Bearer sg40-raw","ordinary",false,0,null],"target_field":"token","sample_value":"public-reference"}}}},"schemas":{"token":{"discriminator":{"propertyName":"token","mapping":{"x-api-key":"https://example.invalid/Schema?token=public-reference"}}}}}}'::jsonb;
$links$;
SELECT is(public.plugin_studio_redact_json_v1(pg_temp.sg40_openapi_link_literals(),'source'),
 replace(pg_temp.sg40_openapi_link_literals()::text,'sg40-raw','REDACTED')::jsonb,
 'Link literal credentials redact while parameter names, expressions, constants and discriminator references survive');
SELECT is(public.plugin_studio_redact_json_v1(pg_temp.sg40_openapi_named_maps(),'source'),
 pg_temp.sg40_openapi_named_maps(),'all OpenAPI named-map positions preserve identities, references and nonsecret literals');
SELECT is(public.plugin_studio_redact_json_v1('{"openapi":"3.1.1","paths":{},"x-api-key":"sg40-raw","x-evidence":{"token":"sg40-raw","public_token":"public-reference"},"webhooks":{"x-api-key":{"post":{"x-api-key":"sg40-raw"}}},"components":{"examples":{"x-api-key":{"value":{"token":"sg40-raw","public_token":"public-reference"},"x-api-key":"sg40-raw"}},"links":{"next":{"parameters":{"x-api-key":"public-reference"},"x-api-key":"sg40-raw"}},"schemas":{"x-api-key":{"examples":[{"token":"sg40-raw","public_token":"public-reference"}],"x-api-key":"sg40-raw","discriminator":{"propertyName":"token","mapping":{"x-api-key":"#/components/schemas/x-api-key"},"x-api-key":"sg40-raw"}}},"securitySchemes":{"x-api-key":{"type":"oauth2","flows":{"implicit":{"authorizationUrl":"https://example.invalid/oauth","scopes":{"x-api-key":"Authorization: Bearer sg40-raw"}}}}}}}','source'),
 '{"openapi":"3.1.1","paths":{},"x-api-key":"REDACTED","x-evidence":{"token":"REDACTED","public_token":"public-reference"},"webhooks":{"x-api-key":{"post":{"x-api-key":"REDACTED"}}},"components":{"examples":{"x-api-key":{"value":{"token":"REDACTED","public_token":"public-reference"},"x-api-key":"REDACTED"}},"links":{"next":{"parameters":{"x-api-key":"public-reference"},"x-api-key":"REDACTED"}},"schemas":{"x-api-key":{"examples":[{"token":"REDACTED","public_token":"public-reference"}],"x-api-key":"REDACTED","discriminator":{"propertyName":"token","mapping":{"x-api-key":"#/components/schemas/x-api-key"},"x-api-key":"REDACTED"}}},"securitySchemes":{"x-api-key":{"type":"oauth2","flows":{"implicit":{"authorizationUrl":"https://example.invalid/oauth","scopes":{"x-api-key":"Authorization: Bearer REDACTED"}}}}}}}'::jsonb,'real OpenAPI extensions and Example/Schema evidence redact outside named-map identities');
SELECT is(public.plugin_studio_redact_json_v1('[{"openapi":"3.1.1","webhooks":{"x-api-key":{"post":{}}}},{"openapi":"3.1.1","components":{"links":{"next":{"parameters":{"x-api-key":"public-reference"}}}}}]','source'),
 '[{"openapi":"3.1.1","webhooks":{"x-api-key":{"post":{}}}},{"openapi":"3.1.1","components":{"links":{"next":{"parameters":{"x-api-key":"public-reference"}}}}}]'::jsonb,'legal webhooks-only and components-only documents retain named-map identities');

SELECT is(public.plugin_studio_redact_json_v1(NULL),NULL::jsonb,'SQL null is preserved');
SELECT is(public.plugin_studio_redact_json_v1('null'),'null'::jsonb,'JSON null is preserved');
SELECT is(public.plugin_studio_redact_json_v1('[false,0,[],{}]'),'[false,0,[],{}]'::jsonb,'ordinary scalar and container types survive');
SELECT is(public.plugin_studio_redact_json_v1('{"nested":[{"clientSecret":"sg40-raw"}]}'),
 '{"nested":[{"clientSecret":"REDACTED"}]}'::jsonb,'nested credential data is redacted');
SELECT is(public.plugin_studio_redact_json_v1('{"token":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"}'),
 '{"token":"REDACTED"}'::jsonb,'a UUID-shaped token is still credential data');
SELECT is(public.plugin_studio_redact_text_v1('Bearer sg40-raw Basic c2c0MDpyYXc= ?api_key=sg40-raw&safe=1 Authorization: Bearer {{provider.token}}'),
 'Bearer REDACTED Basic REDACTED ?api_key=REDACTED&safe=1 Authorization: Bearer {{provider.token}}','bearer/basic/query text is redacted without changing an authorization reference');
SELECT is(public.plugin_studio_redact_text_v1('curl -d ''{"password":"sg40-raw","private_key":"sg40-raw","client_secret":"sg40-other","X-Auth-Token":"sg40-raw","issued-token":"sg40-raw","token":"{{provider.token}}","public_token":"public-reference"}'''),
 'curl -d ''{"password":"REDACTED","private_key":"REDACTED","client_secret":"REDACTED","X-Auth-Token":"REDACTED","issued-token":"REDACTED","token":"{{provider.token}}","public_token":"public-reference"}''',
 'serialized JSON uses normalized sensitive keys and retains reference and noncredential keys');
SELECT is(public.plugin_studio_redact_text_v1('curl -d ''{"\u0074oken":"sg40-raw","client\u005fsecret":"sg40-other","private_key":"sg40-raw","public_token":"public-reference"}'''),
 'curl -d ''{"\u0074oken":"REDACTED","client\u005fsecret":"REDACTED","private_key":"REDACTED","public_token":"public-reference"}''',
 'serialized JSON keys are decoded before recognized credential classification');
SELECT is(public.plugin_studio_redact_text_v1('curl -d ''{"\u0074oken":"\u007b\u007bprovider.token\u007d\u007d"}'''),
 'curl -d ''{"\u0074oken":"\u007b\u007bprovider.token\u007d\u007d"}''','escaped JSON reference values retain their exact source expression');
SELECT is(public.plugin_studio_redact_text_v1('curl -d ''{"\uZZZZoken":"sg40-raw","token":"\u0000sg40-raw"}'''),
 'curl -d ''{"REDACTED":"REDACTED","REDACTED":"REDACTED"}''','malformed quoted JSON pairs fail closed without parser errors or raw fallback');
SELECT is(public.plugin_studio_redact_json_v1(
 '{"input_schema":{"properties":{"token":{"description":"Public tracking token","maxLength":64},"authorization":false},"$defs":{"token":{"maxLength":64}},"allOf":[{"properties":{"token":{"default":"document-reference","enum":["public","private"]}}}]}}','config',TRUE),
 '{"input_schema":{"properties":{"token":{"description":"Public tracking token","maxLength":64},"authorization":false},"$defs":{"token":{"maxLength":64}},"allOf":[{"properties":{"token":{"default":"document-reference","enum":["public","private"]}}}]}}'::jsonb,
 'schema-member positions preserve untyped descriptors, boolean schemas and nested member names');
SELECT is(public.plugin_studio_redact_json_v1(
 '{"openapi":"3.1.0","servers":[{"url":"https://example.invalid/?api_key=sg40-raw","description":"Authorization: Bearer sg40-raw"}],"paths":{"/token":{"get":{"responses":{"200":{"description":"Authorization: Bearer sg40-raw","content":{"application/json":{"schema":{"properties":{"token":{"description":"Public tracking token","maxLength":64}}}}}}}}}},"components":{"schemas":{"token":{"description":"Public tracking token","maxLength":64}}}}','source'),
 '{"openapi":"3.1.0","servers":[{"url":"https://example.invalid/?api_key=REDACTED","description":"Authorization: Bearer REDACTED"}],"paths":{"/token":{"get":{"responses":{"200":{"description":"Authorization: Bearer REDACTED","content":{"application/json":{"schema":{"properties":{"token":{"description":"Public tracking token","maxLength":64}}}}}}}}}},"components":{"schemas":{"token":{"description":"Public tracking token","maxLength":64}}}}'::jsonb,
 'OpenAPI evidence URLs and descriptions redact without changing actual schema members or route identities');
SELECT is(public.plugin_studio_redact_json_v1('{"openapi":"3.0.0","x-api-key":"sg40-raw","paths":{"/x-api-key":{"post":{"x-auth-token":"sg40-raw","operationId":"x-api-key","responses":{"200":{"headers":{"x-api-key":{"description":"Public header definition","schema":{"type":"string"}}}}}}}},"components":{"securitySchemes":{"x-api-key":{"type":"apiKey","in":"header","name":"x-api-key"}},"schemas":{"x-api-key":{"description":"Public tracking key","maxLength":64,"x-api-key":"sg40-raw"},"token":{"properties":{"x-api-key":{"default":"public-reference"}}}}}}','source'),
 '{"openapi":"3.0.0","x-api-key":"REDACTED","paths":{"/x-api-key":{"post":{"x-auth-token":"REDACTED","operationId":"x-api-key","responses":{"200":{"headers":{"x-api-key":{"description":"Public header definition","schema":{"type":"string"}}}}}}}},"components":{"securitySchemes":{"x-api-key":{"type":"apiKey","in":"header","name":"x-api-key"}},"schemas":{"x-api-key":{"description":"Public tracking key","maxLength":64,"x-api-key":"REDACTED"},"token":{"properties":{"x-api-key":{"default":"public-reference"}}}}}}'::jsonb,
 'recognized OpenAPI and schema extension values redact without changing path or schema-member identifiers');
SELECT is(public.plugin_studio_redact_json_v1('{"input_schema":{"properties":{"token":{"description":"Authorization: Bearer sg40-raw","default":"public-reference","examples":["document-reference"]}}}}','config',TRUE),
 '{"input_schema":{"properties":{"token":{"description":"Authorization: Bearer REDACTED","default":"public-reference","examples":["document-reference"]}}}}'::jsonb,
 'schema documentation is evidence while nonsecret defaults and examples remain usable');
SELECT is(public.plugin_studio_redact_json_v1(
 '{"input_schema":{"type":"object","properties":{"token":{"type":"string","default":"document-reference","enum":["public","private"],"examples":["document-reference"]}}}}','config',TRUE),
 '{"input_schema":{"type":"object","properties":{"token":{"type":"string","default":"document-reference","enum":["public","private"],"examples":["document-reference"]}}}}'::jsonb,
 'schema property names, legitimate defaults, enums and examples retain their definitions');
SELECT is(public.plugin_studio_redact_json_v1(
 '{"fields":[{"target_field":"token","source_path":"$.payload.public_token","sample_value":"sg40-raw"}],"value_path":"$.provider.api_key","constant":"ordinary"}','mapping',TRUE),
 '{"fields":[{"target_field":"token","source_path":"$.payload.public_token","sample_value":"REDACTED"}],"value_path":"$.provider.api_key","constant":"ordinary"}'::jsonb,
 'mapping identities/JSONPaths/constants survive while sample values are removed');
SELECT is(public.plugin_studio_redact_json_v1(
 '{"mode":"bearer_token_header","auth_config_id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830","credential_key":"token","password_key":"password","fields":{"token":"access_token"}}','auth',TRUE),
 '{"mode":"bearer_token_header","auth_config_id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830","credential_key":"token","password_key":"password","fields":{"token":"access_token"}}'::jsonb,
 'dispatch auth selectors are references, not credential values');
SELECT is(public.plugin_studio_redact_json_v1(
 '{"token":{"type":"SecretRef","id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"}}','config',TRUE),
 '{"token":{"type":"SecretRef","id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"}}'::jsonb,'closed SecretRef shape survives');
SELECT throws_ok($q$SELECT public.plugin_studio_redact_json_v1('{"token":{"type":"SecretRef","id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830","value":"sg40-raw"}}','config',TRUE)$q$,
 '23514','Inline credentials are not allowed in executable configuration; use an auth binding','an arbitrary object cannot bypass credential validation by claiming a reference type');
SELECT is(public.plugin_studio_redact_json_v1(
 '{"authorization":"Bearer {{provider.token}}","url_template":"https://example.invalid/?token={{context.public_token}}"}','config',TRUE),
 '{"authorization":"Bearer {{provider.token}}","url_template":"https://example.invalid/?token={{context.public_token}}"}'::jsonb,
 'template expressions and public-token references survive');
SELECT is(public.plugin_studio_redact_json_v1('{"body_template":{"service":"Basic service","reference":"public-token-name"},"url_template":"https://example.invalid/?public_token=public-reference"}','config',TRUE),
 '{"body_template":{"service":"Basic service","reference":"public-token-name"},"url_template":"https://example.invalid/?public_token=public-reference"}'::jsonb,
 'noncredential executable literal values are not treated as log messages');
SELECT is(public.plugin_studio_redact_json_v1('{"headers_template":{"authorization":""},"body_template":{"token":null}}','config',TRUE),
 '{"headers_template":{"authorization":""},"body_template":{"token":null}}'::jsonb,'empty/null credential placeholders retain their absence semantics');
SELECT throws_ok($q$SELECT public.plugin_studio_redact_json_v1('{"headers_template":{"authorization":"Bearer sg40-raw"}}','config',TRUE)$q$,
 '23514','Inline credentials are not allowed in executable configuration; use an auth binding','new executable credentials are rejected, never stored as REDACTED');
SELECT throws_ok($q$SELECT public.plugin_studio_redact_json_v1('{"headers_template":{"X-Provider-Auth":"Bearer sg40-raw"},"body_template":{"service":"Basic service"}}','config',TRUE)$q$,
 '23514','Inline credentials are not allowed in executable configuration; use an auth binding','custom executable header names cannot bypass credential-text validation');
SELECT is(public.plugin_studio_redact_json_v1('{"headers_template":{"X-Provider-Auth":"Bearer {{provider.token}}","X-Public-Ref":"$.context.public_token","content-type":"application/json"},"body_template":{"service":"Basic service"}}','config',TRUE),
 '{"headers_template":{"X-Provider-Auth":"Bearer {{provider.token}}","X-Public-Ref":"$.context.public_token","content-type":"application/json"},"body_template":{"service":"Basic service"}}'::jsonb,
 'custom executable header references and noncredential body literals retain runtime meaning');
SELECT is(public.plugin_studio_redact_json_v1('{"request_config":{"headers_template":{"X-Provider-Auth":"Bearer sg40-raw"},"body_template":{"service":"Basic service"}}}','response'),
 '{"request_config":{"headers_template":{"X-Provider-Auth":"Bearer REDACTED"},"body_template":{"service":"Basic service"}}}'::jsonb,
 'unsaved custom-header evidence redacts without treating body literals as log messages');
SELECT is(public.plugin_studio_redact_json_v1('{"review":{"mapping_config":{"fields":[{"target_field":"reference","source_path":"$.token"},{"target_field":"public_reference","source_path":"$.public_token"}]},"coerced_preview":{"reference":"sg40-raw","public_reference":"public-reference"},"coercions":[]}}','response'),
 '{"review":{"mapping_config":{"fields":[{"target_field":"reference","source_path":"$.token"},{"target_field":"public_reference","source_path":"$.public_token"}]},"coerced_preview":{"reference":"REDACTED","public_reference":"public-reference"},"coercions":[]}}'::jsonb,
 'uncoerced renamed preview data follows mapping provenance without changing the mapping');
SELECT is(public.plugin_studio_redact_json_v1('[{"mapping_config":{"column_mappings":[{"target_field":"reference","source_column":"client_secret"}]},"coerced_preview":{"reference":"sg40-raw"}},{"mapping_config":{"field_mappings":{"reference":["$.token.value"]}},"coerced_preview":{"reference":"sg40-raw"}},{"mapping_config":{"fields":[{"target_field":"reference","source_path":"$.token[0]"},{"target_field":"nested","source_path":"$.token[*].nested"},{"target_field":"column","source_path":"column:token"} ]},"coerced_preview":{"reference":"sg40-raw","nested":"sg40-raw","column":"sg40-raw"}}]','response'),
 '[{"mapping_config":{"column_mappings":[{"target_field":"reference","source_column":"client_secret"}]},"coerced_preview":{"reference":"REDACTED"}},{"mapping_config":{"field_mappings":{"reference":["$.token.value"]}},"coerced_preview":{"reference":"REDACTED"}},{"mapping_config":{"fields":[{"target_field":"reference","source_path":"$.token[0]"},{"target_field":"nested","source_path":"$.token[*].nested"},{"target_field":"column","source_path":"column:token"} ]},"coerced_preview":{"reference":"REDACTED","nested":"REDACTED","column":"REDACTED"}}]'::jsonb,
 'all current field-rule forms and sensitive ancestor paths preserve provenance through preview redaction');
SELECT is(public.plugin_studio_redact_json_v1('{"mapping_config":{"column_mappings":[{"target_field":"reference","source_column":"public.reference","sample_value":"public-reference"}]},"coerced_preview":{"reference":"public-reference"},"coercions":[{"target_field":"reference","source_path":"column:public.reference","original_value":"public-reference","converted_value":"public-reference"}]}','response'),
 '{"mapping_config":{"column_mappings":[{"target_field":"reference","source_column":"public.reference","sample_value":"public-reference"}]},"coerced_preview":{"reference":"public-reference"},"coercions":[{"target_field":"reference","source_path":"column:public.reference","original_value":"public-reference","converted_value":"public-reference"}]}'::jsonb,
 'column names remain literal keys rather than invented nested JSONPaths');
SELECT is(public.plugin_studio_redact_json_v1('[{"mapping_config":{"fields":null,"column_mappings":[{"target_field":" reference ","source_path":3,"source_column":"token"}]},"coerced_preview":{"reference":"sg40-raw"}},{"mapping_config":{"fields":{},"column_mappings":[null,3,[],{"target_field":"reference","source_path":" $.token "}]},"coerced_preview":{"reference":"sg40-raw"}},{"mapping_config":{"fields":[],"column_mappings":[{"target_field":"reference","source_path":"$.token"}]},"coerced_preview":{"reference":"public-reference"}},{"mapping_config":{"fields":false,"column_mappings":null,"field_mappings":{" reference ":[3," $.token ",null]}},"coerced_preview":{"reference":"sg40-raw"}},{"mapping_config":{"field_mappings":{"reference":[3,"$.public_token","$.token"]}},"coerced_preview":{"reference":"public-reference"}},{"mapping_config":{"fields":[{"target_field":3,"source_path":"$.token"},{"target_field":" ","source_path":"$.token"}]},"coerced_preview":{"3":"public-reference","":"public-reference"}},{"mapping_config":{"fields":[{"target_field":"reference","source_path":{},"source_column":["token"]}]},"coerced_preview":{"reference":"sg40-raw"}}]','response'),
 '[{"mapping_config":{"fields":null,"column_mappings":[{"target_field":" reference ","source_path":3,"source_column":"token"}]},"coerced_preview":{"reference":"REDACTED"}},{"mapping_config":{"fields":{},"column_mappings":[null,3,[],{"target_field":"reference","source_path":" $.token "}]},"coerced_preview":{"reference":"REDACTED"}},{"mapping_config":{"fields":[],"column_mappings":[{"target_field":"reference","source_path":"$.token"}]},"coerced_preview":{"reference":"public-reference"}},{"mapping_config":{"fields":false,"column_mappings":null,"field_mappings":{" reference ":[3," $.token ",null]}},"coerced_preview":{"reference":"REDACTED"}},{"mapping_config":{"field_mappings":{"reference":[3,"$.public_token","$.token"]}},"coerced_preview":{"reference":"public-reference"}},{"mapping_config":{"fields":[{"target_field":3,"source_path":"$.token"},{"target_field":" ","source_path":"$.token"}]},"coerced_preview":{"3":"public-reference","":"public-reference"}},{"mapping_config":{"fields":[{"target_field":"reference","source_path":{},"source_column":["token"]}]},"coerced_preview":{"reference":"REDACTED"}}]'::jsonb,
 'preview provenance mirrors current array priority, object filtering, trimmed string selectors and first-string field mappings');
SELECT is(jsonb_build_array(
 public.plugin_studio_rule_source_v1('{"source_path":"\t $.token\u00a0","source_column":"public_token"}'),
 public.plugin_studio_rule_source_v1('{"source_path":3,"source_column":["token"]}'),
 public.plugin_studio_rule_source_v1('{"source_column":[[],["to",null,"ken"]]}'),
 public.plugin_studio_rule_source_v1('{"source_column":false}'),
 public.plugin_studio_rule_source_v1('{"source_column":0}'),
 public.plugin_studio_rule_source_v1('{"source_column":{}}'),
 public.plugin_studio_rule_source_v1('{"source_column":[false]}'),
 public.plugin_studio_rule_source_v1('{"source_column":" token "}')),
 '["$.token","column:token","column:,to,,ken","","","column:[object Object]","column:false","column: token"]'::jsonb,
 'current source normalization preserves JS whitespace, truthy column fallback and recursive array stringification');
SELECT throws_ok($q$SELECT public.plugin_studio_redact_json_v1('{"input_schema":{"properties":{"token":{"default":"Bearer sg40-raw"}}}}','config',TRUE)$q$,
 '23514','Inline credentials are not allowed in executable configuration; use an auth binding','executable credential-shaped defaults are rejected without values');
SELECT ok(has_function_privilege('authenticated','api.integration_plugin_redact_projection_v1(jsonb)','EXECUTE'),
 'authenticated callers can project their own supplied response');
SELECT ok(NOT has_function_privilege('anon','api.integration_plugin_redact_projection_v1(jsonb)','EXECUTE'),
 'anonymous callers gain no projection privilege');
SELECT is(public.plugin_studio_redact_json_v1(public.plugin_studio_redact_json_v1('{"token":"sg40-raw","message":"token=sg40-raw"}')),
 public.plugin_studio_redact_json_v1('{"token":"sg40-raw","message":"token=sg40-raw"}'),'redaction is idempotent');

CREATE FUNCTION pg_temp.sg40_writes() RETURNS SETOF TEXT LANGUAGE plpgsql SECURITY INVOKER AS $test$
DECLARE
 org UUID:=gen_random_uuid(); foreign_org UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid();
 plugin_id UUID; version_id UUID; report_id UUID; direct_id UUID:=gen_random_uuid(); direct_version UUID:=gen_random_uuid();
 policy JSONB; policy_version INT; result JSONB; stored JSONB; before_value JSONB; query_sql TEXT;
 fixture_label TEXT; fixture_policy JSONB; fixture_version UUID;
 fixture_plugin UUID; fixture_key TEXT; fixture_provider UUID; fixture_source UUID; fixture_operation UUID;
 fixture_source_mapping UUID; fixture_response_mapping UUID; fixture_collision UUID;
 fixture_surface TEXT; fixture_owner TEXT; fixture_table TEXT; fixture_error TEXT; fixture_tags JSONB;
 provider_before JSONB; bindings_before JSONB; collision_before JSONB; resources_before JSONB;
 named_maps JSONB:=pg_temp.sg40_openapi_named_maps();
 link_literals JSONB:=pg_temp.sg40_openapi_link_literals(); safe_link_literals JSONB:=replace(link_literals::text,'sg40-raw','REDACTED')::jsonb;
 workflow_name TEXT:='sg40-'||gen_random_uuid();
 config JSONB:='[{"operation_name":"sg40_forward","method":"POST","url_template":"https://example.invalid/sg40","headers_template":{"content-type":"application/json","X-Provider-Auth":"Bearer {{provider.token}}"},"body_template":{"reference":"fixed-public-reference","service":"Basic service"},"request_mappings":{"headers":{"authorization":"$.context.authorization"}},"auth":{"mode":"bearer_token_header","auth_type":"bearer","credential_key":"token"}}]';
BEGIN
 INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
  (org,'SG40 owned','sg40-'||org,'active'),(foreign_org,'SG40 foreign','sg40-'||foreign_org,'active');
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
  VALUES(actor,org,'sg40-'||actor||'@example.test','SG40 actor','ops_admin','active','tenant');
 INSERT INTO public.workflow_templates(name,version,status,scope_type,scope_id)
  VALUES(workflow_name,1,'active','tenant',org);
 SELECT v.value,v.schema_version INTO STRICT policy,policy_version
 FROM public.settings s JOIN public.settings_versions v ON v.id=s.settings_version_id
 WHERE s.category='access_control_policy' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
 SELECT jsonb_set(policy,'{roles}',jsonb_agg(CASE WHEN e->>'key'='ops_admin'
  THEN jsonb_set(e,'{capability_keys}','["integration_plugins.*","mappings.*","system.write"]'::jsonb)
  ELSE e END ORDER BY n)) INTO policy FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY x(e,n);
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,policy,policy_version,'SG40 rollback policy');
 PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.integration_plugin_generate_draft_v1(
  p_plugin_name:='SG40 draft',p_plugin_kind:='api',p_source_type:='curl',
  p_source_payload:=jsonb_build_object('token','sg40-raw','curl','curl https://example.invalid/?api_key=sg40-raw -d ''{"private_key":"sg40-raw","client_secret":"sg40-other","\u0074oken":"sg40-raw"}''',
   'document','{"openapi":"3.0.0","paths":{"/orders":{"post":{}}},"x-api-key":"sg40-raw"}'::jsonb,'named_maps',named_maps,'link_literals',link_literals),
  p_inbound_config:='{"route":{"method":"POST","path_template":"/sg40"},"input_schema":{"properties":{"token":{"description":"Public tracking token","maxLength":64}}}}',
  p_mapping_config:='{"fields":[{"target_field":"token","source_path":"$.payload.public_token","sample_value":"sg40-raw"}]}',
  p_workflow_binding:=jsonb_build_object('template_name',workflow_name),p_outbound_operations:=config,
  p_organization_id:=org,p_metadata:='{"secret":"sg40-raw"}');
 plugin_id:=(result->>'plugin_id')::uuid; version_id:=(result->>'version_id')::uuid;
 RETURN NEXT ok(plugin_id IS NOT NULL AND version_id IS NOT NULL,'draft RPC returns canonical persisted identifiers');
 SELECT to_jsonb(v) INTO stored FROM public.integration_plugin_versions v WHERE id=version_id;
 RETURN NEXT is(stored#>>'{source_payload,token}','REDACTED','draft source payload is redacted before persistence');
 RETURN NEXT is(stored#>>'{normalized_contract,token}','REDACTED','duplicate normalized snapshot is independently redacted');
 RETURN NEXT ok(stored#>>'{source_payload,document,x-api-key}'='REDACTED'
  AND stored#>>'{normalized_contract,document,x-api-key}'='REDACTED','draft RPC redacts recognized OpenAPI extension values in both persisted snapshots');
 RETURN NEXT is(jsonb_build_array(stored#>'{source_payload,named_maps}',stored#>'{normalized_contract,named_maps}'),
  jsonb_build_array(named_maps,named_maps),'draft RPC canonical snapshots retain every OpenAPI named-map class');
 RETURN NEXT is(jsonb_build_array(stored#>'{source_payload,link_literals}',stored#>'{normalized_contract,link_literals}'),
  jsonb_build_array(safe_link_literals,safe_link_literals),'draft RPC redacts Link literals in both canonical persisted snapshots');
 RETURN NEXT ok((stored->'source_payload')::text !~ 'sg40-(raw|other)'
  AND (stored->'normalized_contract')::text !~ 'sg40-(raw|other)','raw serialized source credentials are not persisted');
 RETURN NEXT is(stored#>'{inbound_config,input_schema,properties,token}',
  '{"description":"Public tracking token","maxLength":64}'::jsonb,'draft readback retains untyped schema-member definitions');
 RETURN NEXT is(stored->'outbound_operations',config,'executable nonsecret literals, mappings and auth selectors are unchanged');
 RETURN NEXT is(stored#>>'{mapping_config,fields,0,source_path}','$.payload.public_token','persisted mapping expression survives');
 RETURN NEXT is(stored#>>'{mapping_config,fields,0,sample_value}','REDACTED','persisted mapping sample is redacted');
 RETURN NEXT is((SELECT metadata->>'secret' FROM public.integration_plugins WHERE id=plugin_id),'REDACTED','plugin metadata is redacted');
 INSERT INTO public.integration_plugins(id,organization_id,plugin_key,name,metadata)
  VALUES(direct_id,org,'sg40-'||direct_id,'SG40 direct','{"password":"sg40-raw"}');
 RETURN NEXT is((SELECT metadata->>'password' FROM public.integration_plugins WHERE id=direct_id),'REDACTED','permitted direct insert cannot bypass redaction');
 UPDATE public.integration_plugins SET metadata='{"token":"sg40-update"}' WHERE id=direct_id;
 RETURN NEXT is((SELECT metadata->>'token' FROM public.integration_plugins WHERE id=direct_id),'REDACTED','permitted direct update cannot bypass redaction');
 INSERT INTO public.integration_plugin_versions(id,plugin_id,organization_id,version_no,source_payload,mapping_config)
  VALUES(direct_version,plugin_id,org,98,'{"token":"sg40-direct"}','{"fields":[{"target_field":"token","source_path":"$.public_token"}]}');
 RETURN NEXT is((SELECT source_payload->>'token' FROM public.integration_plugin_versions WHERE id=direct_version),'REDACTED',
  'permitted direct version insert returns sanitized readback');
 UPDATE public.integration_plugin_versions SET source_payload='{"openapi":"3.1.0","x-api-key":"sg40-raw","servers":[{"url":"https://example.invalid/?api_key=sg40-raw","description":"Authorization: Bearer sg40-raw"}],"paths":{"/x-api-key":{"post":{}}},"components":{"schemas":{"token":{"description":"Public tracking token","maxLength":64}}}}'
  WHERE id=direct_version RETURNING to_jsonb(integration_plugin_versions) INTO stored;
 RETURN NEXT ok(position('sg40-raw' IN (stored->'source_payload')::text)=0,'direct version update redacts OpenAPI URL and description evidence');
 RETURN NEXT is(stored#>'{source_payload,components,schemas,token}',
  '{"description":"Public tracking token","maxLength":64}'::jsonb,'direct version update retains actual OpenAPI schema-member definitions');
 UPDATE public.integration_plugin_versions SET source_payload=named_maps,normalized_contract=named_maps
  WHERE id=direct_version RETURNING to_jsonb(integration_plugin_versions) INTO stored;
 RETURN NEXT is(stored->'source_payload',named_maps,'direct source write readback retains complete OpenAPI named-map identities');
 RETURN NEXT is(stored->'normalized_contract',named_maps,'direct normalized write readback retains complete OpenAPI named-map identities');
 UPDATE public.integration_plugin_versions SET source_payload=link_literals,normalized_contract=link_literals
  WHERE id=direct_version RETURNING to_jsonb(integration_plugin_versions) INTO stored;
 RETURN NEXT is(jsonb_build_array(stored->'source_payload',stored->'normalized_contract'),
  jsonb_build_array(safe_link_literals,safe_link_literals),'direct write readback redacts Link literals in both source snapshots');
 UPDATE public.integration_plugin_versions SET artifact_hash='sg40-artifact',diff_hash='sg40-diff' WHERE id=version_id;
 SELECT to_jsonb(v) INTO before_value FROM public.integration_plugin_versions v WHERE id=version_id;
 UPDATE public.integration_plugin_versions SET metadata='{"token":"sg40-update"}',source_payload=source_payload WHERE id=version_id;
 SELECT to_jsonb(v) INTO stored FROM public.integration_plugin_versions v WHERE id=version_id;
 RETURN NEXT is(stored-ARRAY['metadata','updated_at'],before_value-ARRAY['metadata','updated_at'],
  'changing one JSON column and col=col preserve other JSON and existing hashes');
 UPDATE public.integration_plugin_versions SET auth_bindings='{"latest_auth_config_id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830","latest_auth_type":"bearer"}' WHERE id=version_id;
 RETURN NEXT is((SELECT auth_bindings->>'latest_auth_config_id' FROM public.integration_plugin_versions WHERE id=version_id),
  '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830','auth binding reference UUID round trips');
 RETURN NEXT throws_ok(format($q$INSERT INTO public.integration_plugin_versions(plugin_id,organization_id,version_no,outbound_operations) VALUES(%L,%L,99,'[{"headers_template":{"X-Provider-Auth":"Bearer sg40-raw"}}]')$q$,plugin_id,org),
  '23514','Inline credentials are not allowed in executable configuration; use an auth binding','direct version insert rejects custom-header executable credentials');
 RETURN NEXT throws_ok(format($q$UPDATE public.integration_plugin_versions SET outbound_operations='[{"headers_template":{"X-Provider-Auth":"Basic c2c0MDpyYXc="}}]' WHERE id=%L$q$,version_id),
  '23514','Inline credentials are not allowed in executable configuration; use an auth binding','direct version update rejects custom-header executable credentials');
 RETURN NEXT throws_ok(format($q$SELECT api.integration_plugin_generate_draft_v1(p_plugin_name:='SG40 custom header denied',p_plugin_kind:='api',p_organization_id:=%L::uuid,p_outbound_operations:='[{"headers_template":{"X-Provider-Auth":"Bearer sg40-raw"}}]')$q$,org),
  '23514','Inline credentials are not allowed in executable configuration; use an auth binding','draft RPC rejects custom-header executable credentials before lifecycle publication');
 RETURN NEXT throws_ok(format($q$SELECT api.ui_upsert_mapping_artifact_v1(%L::jsonb)$q$,
  jsonb_build_object('artifact','api_outbound','organization_id',org,'request_config',jsonb_build_object('headers_template',jsonb_build_object('X-Provider-Auth','Bearer sg40-raw')))),
  '23514','Inline credentials are not allowed in executable configuration; use an auth binding','direct shared save RPC cannot bypass custom-header executable credential rejection');
 RETURN NEXT throws_ok(format($q$SELECT api.ui_upsert_mapping_artifact_v1(%L::jsonb)$q$,
  jsonb_build_object('artifact','api_outbound','organization_id',org,'request_config',jsonb_build_object('url_template',('https' || '://x-access-token:synthetic-private@host.example/x')))),
  '23514','Inline credentials are not allowed in executable configuration; use an auth binding','direct shared save rejects URL userinfo passwords');
 RETURN NEXT throws_ok(format($q$SELECT api.ui_upsert_mapping_artifact_v1(%L::jsonb)$q$,
  jsonb_build_object('artifact','api_outbound','organization_id',org,'request_config',jsonb_build_object('url_template','https://synthetic-private@host.example/x'))),
  '23514','Inline credentials are not allowed in executable configuration; use an auth binding','direct shared save rejects token-only URL userinfo');
 result:=api.ui_create_mapping_operation_report_v1(jsonb_build_object('organization_id',org,'artifact_type','integration_plugin',
  'request_summary',jsonb_build_object('token','sg40-raw'),'result_payload',jsonb_build_object('nested',jsonb_build_array(jsonb_build_object('password','sg40-raw'))),
  'next_steps',jsonb_build_array('Rotate token=sg40-raw')));
 report_id:=(result->>'id')::uuid;
 RETURN NEXT is(result#>>'{request_summary,token}','REDACTED','report RPC returns stored redacted readback');
 RETURN NEXT is(result#>>'{result_payload,nested,0,password}','REDACTED','nested report result data is redacted');
 RETURN NEXT is(result#>>'{next_steps,0}','Rotate token=REDACTED','report next-step text is redacted');
 UPDATE public.mapping_operation_reports SET result_payload=('{"first_url":"https' || '://user:synthetic-private@host.example/x","second_url":"https://synthetic-private@host.example/x","plain_url":"https://token.example:8443/x"}')::jsonb WHERE id=report_id;
 RETURN NEXT is((SELECT result_payload FROM public.mapping_operation_reports WHERE id=report_id),
  '{"first_url":"https://REDACTED@host.example/x","second_url":"https://REDACTED@host.example/x","plain_url":"https://token.example:8443/x"}'::jsonb,
  'direct report trigger redacts password and token userinfo while preserving plain port URLs');
 UPDATE public.mapping_operation_reports SET result_payload=jsonb_build_object('raw_body',$text${"url":"https:\/\/u:p@ss@host.example/x"}$text$) WHERE id=report_id;
 RETURN NEXT is((SELECT result_payload->>'raw_body' FROM public.mapping_operation_reports WHERE id=report_id),
  $text${"url":"https:\/\/REDACTED@host.example/x"}$text$,'report trigger redacts JSON-escaped raw response userinfo through its final at sign');
 result:=api.ui_create_mapping_operation_report_v1(jsonb_build_object('organization_id',org,'artifact_type','integration_plugin',
  'result_payload','{"review":{"mapping_config":{"fields":null,"column_mappings":[{"target_field":" reference ","source_path":3,"source_column":"token"}]},"coerced_preview":{"reference":"sg40-raw"},"coercions":[]},"field_mapping_review":{"mapping_config":{"field_mappings":{"reference":[3,"$.token"]}},"coerced_preview":{"reference":"sg40-raw"}}}'::jsonb,
  'conversion_summary','{"coercion_count":1,"coercions":[{"target_field":"reference","source_path":"$.token[0]","original_value":"sg40-raw","converted_value":"sg40-raw"}]}'::jsonb));
 RETURN NEXT ok(position('sg40-raw' IN (result->'result_payload')::text)=0,'report RPC canonical readback redacts uncoerced renamed result evidence');
 RETURN NEXT ok(position('sg40-raw' IN (result->'conversion_summary')::text)=0,'current persisted report coercions use sensitive source ancestry too');
 RETURN NEXT is(result#>>'{result_payload,review,mapping_config,column_mappings,0,source_column}','token','report projection preserves executable mapping provenance');
 UPDATE public.mapping_operation_reports SET diagnostics_summary='{"message":"Basic c2c0MDpyYXc="}',
  result_payload='{"review":{"mapping_config":{"column_mappings":[{"target_field":"reference","source_column":"token"}]},"coerced_preview":{"reference":"sg40-raw"}}}' WHERE id=report_id;
 RETURN NEXT is((SELECT diagnostics_summary->>'message' FROM public.mapping_operation_reports WHERE id=report_id),'Basic REDACTED','direct report update is redacted');
 RETURN NEXT is((SELECT result_payload#>>'{review,coerced_preview,reference}' FROM public.mapping_operation_reports WHERE id=report_id),
  'REDACTED','permitted direct report update cannot bypass renamed evidence redaction');
 INSERT INTO public.mapping_operation_reports(organization_id,artifact_type,operation_kind,save_mode,status,result_payload)
  VALUES(org,'integration_plugin','mapping_save','draft','succeeded','{"refresh_token":"sg40-raw","review":{"mapping_config":{"fields":[{"target_field":"reference","source_path":"$.token"}]},"coerced_preview":{"reference":"sg40-raw"}}}') RETURNING id INTO report_id;
 RETURN NEXT is((SELECT result_payload->>'refresh_token' FROM public.mapping_operation_reports WHERE id=report_id),'REDACTED','direct report insert is redacted');
 RETURN NEXT is((SELECT result_payload#>>'{review,coerced_preview,reference}' FROM public.mapping_operation_reports WHERE id=report_id),
  'REDACTED','permitted direct report insert cannot bypass renamed evidence redaction');
 result:=api.integration_plugin_redact_projection_v1('{"normalized_contract":{"route":{"headers":{"Authorization":"Bearer sg40-raw"}}},"review":{"coerced_preview":{"token":"sg40-raw"},"coercions":[{"target_field":"token","source_path":"$.public_token","original_value":"sg40-raw","converted_value":"sg40-raw"}]},"error":{"message":"token=sg40-raw"},"result":{"password":"sg40-raw"}}');
 RETURN NEXT ok(position('sg40-raw' IN result::text)=0,'unsaved normalized/review/coercion/error/result response copies are all redacted');
 RETURN NEXT is(result#>>'{review,coercions,0,source_path}','$.public_token','response projection retains reference metadata');
 result:=api.integration_plugin_submit_v1(version_id,'SG40 synthetic submit');
 RETURN NEXT is(result->>'status','submitted','submit consumes persisted sanitized version');
 result:=api.integration_plugin_approve_v1(version_id,'approved','SG40 synthetic approve');
 SELECT to_jsonb(v) INTO stored FROM public.integration_plugin_versions v WHERE id=version_id;
 RETURN NEXT is(stored->>'diff_hash',public.integration_plugin_hash_payload_v1(jsonb_build_object(
  'normalized_contract',stored->'normalized_contract','inbound_config',stored->'inbound_config',
  'mapping_config',stored->'mapping_config','workflow_binding',stored->'workflow_binding','outbound_operations',stored->'outbound_operations')),
  'approval hashes the canonical persisted sanitized configuration');
 result:=api.integration_plugin_activate_v1(version_id,'tenant',org,'SG40 synthetic activate');
 RETURN NEXT is(result->>'artifact_hash',(SELECT artifact_hash FROM public.integration_plugin_versions WHERE id=version_id),
  'activation returns the stored artifact hash');
 -- Runtime materialization is private; inspect persisted rows only as the harness owner.
 EXECUTE 'SET LOCAL ROLE postgres';
 RETURN NEXT is((SELECT ot.headers_template FROM public.operation_templates ot
  JOIN public.integration_plugin_bindings b ON b.runtime_resource_id=ot.id
  WHERE b.plugin_version_id=version_id AND b.binding_type='operation_template' LIMIT 1),config#>'{0,headers_template}',
  'activation copies intact executable configuration instead of REDACTED');
 RETURN NEXT is((SELECT r.policy FROM public.api_routes r
  JOIN public.integration_plugin_bindings b ON b.runtime_resource_id=r.id
  WHERE b.plugin_version_id=version_id AND b.binding_type='api_route' AND b.runtime_resource_type='api_routes' LIMIT 1),
  jsonb_build_object('workflow',jsonb_build_object('enabled',TRUE,'template_name',workflow_name),
   'delivery',jsonb_build_object('mode','accepted_async','status_code',202)),
  'activation creates canonical workflow and delivery policy without supplied route policy');

 RETURN NEXT is((SELECT jsonb_build_array(ot.handler_key,ot.handler_version) FROM public.operation_templates ot
  JOIN public.integration_plugin_bindings b ON b.runtime_resource_id=ot.id
  WHERE b.plugin_version_id=version_id AND b.binding_type='operation_template' LIMIT 1),
  '["outbound_http","v1"]'::jsonb,'activation supplies canonical handler pins without handler fields in the draft');
 EXECUTE 'SET LOCAL ROLE authenticated';

 -- Seed owned predecessors, then exercise actual activation conflict updates.
 result:=api.integration_plugin_generate_draft_v1(p_plugin_name:='SG40 owned materialization',p_plugin_kind:='api',
  p_organization_id:=org,p_inbound_config:=jsonb_build_object('route',jsonb_build_object('method','POST','path_template','/sg40-owned-'||gen_random_uuid())),
  p_workflow_binding:=jsonb_build_object('template_name',workflow_name),p_outbound_operations:=config);
 fixture_version:=(result->>'version_id')::uuid; fixture_plugin:=(result->>'plugin_id')::uuid;
 PERFORM api.integration_plugin_submit_v1(fixture_version,'SG40 owned submit');
 PERFORM api.integration_plugin_approve_v1(fixture_version,'approved','SG40 owned approve');
 EXECUTE 'SET LOCAL ROLE postgres';
 SELECT plugin_key INTO fixture_key FROM public.integration_plugins WHERE id=fixture_plugin;
 fixture_tags:=jsonb_build_object('managed_by','integration_plugin','plugin_id',fixture_plugin,'plugin_version_id',fixture_version);
 INSERT INTO public.providers(organization_id,name,provider_type,metadata)
  VALUES(org,format('integration_plugin_%s_v1',fixture_key),'webhook',fixture_tags) RETURNING id INTO fixture_provider;
 SELECT to_jsonb(p) INTO provider_before FROM public.providers p WHERE id=fixture_provider;
 INSERT INTO public.mapping_configs(mapping_type,mapping_key,mapping_config,organization_id,managed_by,managed_metadata) VALUES
  ('webhook_inbound',format('integration_plugin:%s:source:tenant:%s',fixture_version,org),'{"before":true}',org,'integration_plugin',fixture_tags)
  RETURNING id INTO fixture_source_mapping;
 INSERT INTO public.mapping_configs(mapping_type,mapping_key,mapping_config,organization_id,managed_by,managed_metadata) VALUES
  ('provider_response',format('integration_plugin:%s:sg40_forward',fixture_version),'{"before":true}',org,'integration_plugin',fixture_tags)
  RETURNING id INTO fixture_response_mapping;
 INSERT INTO public.operation_templates(provider_id,operation_name,handler_key,handler_version,method,url_template,mapping_config_id,metadata)
  VALUES(fixture_provider,'sg40_forward','label_job','v2','GET','https://example.invalid/before',fixture_response_mapping,fixture_tags)
  RETURNING id INTO fixture_operation;
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.integration_plugin_activate_v1(fixture_version,'tenant',org,'SG40 owned activate');
 RETURN NEXT is((result->>'provider_id')::uuid,fixture_provider,'activation reuses only the exact owned canonical provider');
 EXECUTE 'SET LOCAL ROLE postgres';
 RETURN NEXT is((SELECT to_jsonb(p) FROM public.providers p WHERE id=fixture_provider),provider_before,'owned provider reuse never overwrites provider state');
 RETURN NEXT is(jsonb_build_array(
  (SELECT mapping_config FROM public.mapping_configs WHERE id=fixture_source_mapping),
  (SELECT mapping_config FROM public.mapping_configs WHERE id=fixture_response_mapping)),
  jsonb_build_array(public.normalize_shipment_webhook_mapping_config_v1('webhook_inbound','{}'::jsonb),'{}'::jsonb),
  'owned source and response mapping conflicts update the existing rows');
 RETURN NEXT is((SELECT jsonb_build_object('id',ot.id,'handler_key',ot.handler_key,'handler_version',ot.handler_version,
  'method',ot.method,'url_template',ot.url_template,'headers_template',ot.headers_template,'body_template',ot.body_template,
  'request_mappings',ot.request_mappings,'mapping_config_id',ot.mapping_config_id,'timeout_seconds',ot.timeout_seconds,
  'call_type',ot.call_type,'auth',ot.metadata->'auth') FROM public.operation_templates ot WHERE id=fixture_operation),
  jsonb_build_object('id',fixture_operation,'handler_key','outbound_http','handler_version','v1','method','POST',
   'url_template',config#>>'{0,url_template}','headers_template',config#>'{0,headers_template}','body_template',config#>'{0,body_template}',
   'request_mappings',config#>'{0,request_mappings}','mapping_config_id',fixture_response_mapping,'timeout_seconds',30,
   'call_type','provider_api','auth',config#>'{0,auth}'),'owned operation conflict updates exact runtime fields and canonical handler pins');
 EXECUTE 'SET LOCAL ROLE authenticated';

 -- A supported second scope reuses the webhook outbound provider, not its old scope binding.
 result:=api.integration_plugin_generate_draft_v1(p_plugin_name:='SG40 webhook scopes',p_plugin_kind:='webhook',p_organization_id:=org,
  p_workflow_binding:=jsonb_build_object('template_name',workflow_name),p_outbound_operations:=config);
 fixture_version:=(result->>'version_id')::uuid;
 PERFORM api.integration_plugin_submit_v1(fixture_version,'SG40 scopes submit');
 PERFORM api.integration_plugin_approve_v1(fixture_version,'approved','SG40 scopes approve');
 result:=api.integration_plugin_activate_v1(fixture_version,'tenant',org,'SG40 first scope');
 fixture_provider:=(result->>'provider_id')::uuid; fixture_source:=(result->>'webhook_source_id')::uuid;
 EXECUTE 'SET LOCAL ROLE postgres';
 SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) INTO bindings_before FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id=fixture_version AND b.scope_type='tenant' AND b.scope_id=org;
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.integration_plugin_activate_v1(fixture_version,'source',fixture_source,'SG40 second scope');
 RETURN NEXT is((result->>'provider_id')::uuid,fixture_provider,'second webhook scope reuses the same owned outbound provider');
 EXECUTE 'SET LOCAL ROLE postgres';
 RETURN NEXT is((SELECT count(*) FROM public.integration_plugin_bindings b WHERE b.plugin_version_id=fixture_version
  AND b.scope_type='source' AND b.scope_id=fixture_source AND b.binding_type='provider' AND b.runtime_resource_id=fixture_provider),
  1::bigint,'reused webhook provider receives the new current-scope binding');
 RETURN NEXT is((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id=fixture_version AND b.scope_type='tenant' AND b.scope_id=org),
  bindings_before,'second-scope activation preserves historical tenant bindings');
 RETURN NEXT ok((SELECT enabled FROM public.providers WHERE id=fixture_provider)
  AND (SELECT enabled FROM public.webhook_sources WHERE id=fixture_source),'second-scope activation retains existing enabled runtime resources');
 SELECT jsonb_agg(b.id ORDER BY b.id) INTO bindings_before FROM public.integration_plugin_bindings b WHERE b.plugin_version_id=fixture_version;
 EXECUTE 'SET LOCAL ROLE authenticated';
 PERFORM api.integration_plugin_activate_v1(fixture_version,'source',fixture_source,'SG40 repeated scope');
 EXECUTE 'SET LOCAL ROLE postgres';
 RETURN NEXT is((SELECT jsonb_agg(b.id ORDER BY b.id) FROM public.integration_plugin_bindings b WHERE b.plugin_version_id=fixture_version),
  bindings_before,'same-scope reactivation does not duplicate runtime bindings');
 EXECUTE 'SET LOCAL ROLE authenticated';

 -- Each rejected collision must roll back all activation writes, not adopt another resource.
 FOR fixture_surface,fixture_owner IN
  SELECT surface,ownership FROM (VALUES ('source'),('response'),('operation'),('api provider'),('webhook provider')) s(surface)
   CROSS JOIN (VALUES ('unmanaged'),('other plugin'),('other version')) o(ownership)
  UNION ALL SELECT * FROM (VALUES ('source','foreign organization'),('response','foreign organization'),
   ('api provider','wrong type'),('webhook provider','wrong type')) extra(surface,ownership)
 LOOP
  result:=api.integration_plugin_generate_draft_v1(p_plugin_name:='SG40 denied '||fixture_surface||' '||fixture_owner,
   p_plugin_kind:=CASE WHEN fixture_surface='webhook provider' THEN 'webhook' ELSE 'api' END,p_organization_id:=org,
   p_inbound_config:=jsonb_build_object('route',jsonb_build_object('method','POST','path_template','/sg40-denied-'||gen_random_uuid())),
   p_workflow_binding:=jsonb_build_object('template_name',workflow_name),p_outbound_operations:=config);
  fixture_version:=(result->>'version_id')::uuid; fixture_plugin:=(result->>'plugin_id')::uuid;
  PERFORM api.integration_plugin_submit_v1(fixture_version,'SG40 denial submit');
  PERFORM api.integration_plugin_approve_v1(fixture_version,'approved','SG40 denial approve');
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT plugin_key INTO fixture_key FROM public.integration_plugins WHERE id=fixture_plugin;
  fixture_tags:=jsonb_build_object('managed_by','integration_plugin','plugin_id',fixture_plugin,'plugin_version_id',fixture_version);
  IF fixture_owner='unmanaged' THEN fixture_tags:=fixture_tags-'managed_by';
  ELSIF fixture_owner='other plugin' THEN fixture_tags:=jsonb_set(fixture_tags,'{plugin_id}',to_jsonb(gen_random_uuid()));
  ELSIF fixture_owner='other version' THEN fixture_tags:=jsonb_set(fixture_tags,'{plugin_version_id}',to_jsonb(gen_random_uuid()));
  END IF;
  IF fixture_surface IN ('source','response') THEN
   fixture_table:='mapping_configs';
   INSERT INTO public.mapping_configs(mapping_type,mapping_key,mapping_config,organization_id,managed_by,managed_metadata)
    VALUES(CASE WHEN fixture_surface='source' THEN 'webhook_inbound' ELSE 'provider_response' END,
     CASE WHEN fixture_surface='source' THEN format('integration_plugin:%s:source:tenant:%s',fixture_version,org)
      ELSE format('integration_plugin:%s:sg40_forward',fixture_version) END,'{"before":true}',
     CASE WHEN fixture_owner='foreign organization' THEN foreign_org ELSE org END,
     CASE WHEN fixture_owner='unmanaged' THEN 'platform' ELSE 'integration_plugin' END,fixture_tags)
    RETURNING id INTO fixture_collision;
   fixture_error:=CASE WHEN fixture_surface='source' THEN 'Integration plugin source mapping is not owned by this version'
    ELSE 'Integration plugin response mapping is not owned by this version' END;
  ELSE
   INSERT INTO public.providers(organization_id,name,provider_type,metadata)
    VALUES(org,format('integration_plugin_%s_v1%s',fixture_key,CASE WHEN fixture_surface='webhook provider' THEN '_ops' ELSE '' END),
     CASE WHEN fixture_owner='wrong type' THEN 'geocoding' ELSE 'webhook' END,
     CASE WHEN fixture_surface='operation' THEN jsonb_build_object('managed_by','integration_plugin','plugin_id',fixture_plugin,'plugin_version_id',fixture_version)
      ELSE fixture_tags END) RETURNING id INTO fixture_provider;
   IF fixture_surface='operation' THEN
    INSERT INTO public.mapping_configs(mapping_type,mapping_key,mapping_config,organization_id,managed_by,managed_metadata)
     VALUES('provider_response',format('sg40-unrelated:%s',fixture_version),'{}',org,'integration_plugin',fixture_tags)
     RETURNING id INTO fixture_response_mapping;
    INSERT INTO public.operation_templates(provider_id,operation_name,handler_key,method,url_template,mapping_config_id,metadata)
     VALUES(fixture_provider,'sg40_forward','outbound_http','GET','https://example.invalid/do-not-overwrite',fixture_response_mapping,fixture_tags)
     RETURNING id INTO fixture_collision;
    fixture_table:='operation_templates'; fixture_error:='Integration plugin operation template is not owned by this version';
   ELSE
    fixture_collision:=fixture_provider; fixture_table:='providers'; fixture_error:='Integration plugin provider is not owned by this version';
   END IF;
  END IF;
  query_sql:=format('SELECT to_jsonb(t) FROM public.%I t WHERE id=%L::uuid',fixture_table,fixture_collision);
  EXECUTE query_sql INTO collision_before;
  SELECT jsonb_build_object('plugin',to_jsonb(p),'version',to_jsonb(v)) INTO before_value
   FROM public.integration_plugins p JOIN public.integration_plugin_versions v ON v.plugin_id=p.id WHERE v.id=fixture_version;
  SELECT jsonb_build_array(
   (SELECT count(*) FROM public.mapping_configs),(SELECT count(*) FROM public.providers),
   (SELECT count(*) FROM public.operation_templates),(SELECT count(*) FROM public.webhook_sources),
   (SELECT count(*) FROM public.api_route_packs),(SELECT count(*) FROM public.api_routes),
   (SELECT count(*) FROM public.integration_plugin_bindings),(SELECT count(*) FROM public.integration_plugin_approval_events)) INTO resources_before;
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format($q$SELECT api.integration_plugin_activate_v1(%L::uuid,'tenant',%L::uuid,'SG40 denied collision')$q$,fixture_version,org),
   '23514',fixture_error,'activation rejects '||fixture_surface||' collision: '||fixture_owner);
  EXECUTE 'SET LOCAL ROLE postgres';
  EXECUTE query_sql INTO stored;
  RETURN NEXT is(stored,collision_before,'rejected '||fixture_surface||' '||fixture_owner||' row remains byte-for-byte unchanged');
  SELECT jsonb_build_object('plugin',to_jsonb(p),'version',to_jsonb(v)) INTO stored
   FROM public.integration_plugins p JOIN public.integration_plugin_versions v ON v.plugin_id=p.id WHERE v.id=fixture_version;
  RETURN NEXT ok(stored=before_value AND resources_before=jsonb_build_array(
   (SELECT count(*) FROM public.mapping_configs),(SELECT count(*) FROM public.providers),
   (SELECT count(*) FROM public.operation_templates),(SELECT count(*) FROM public.webhook_sources),
   (SELECT count(*) FROM public.api_route_packs),(SELECT count(*) FROM public.api_routes),
   (SELECT count(*) FROM public.integration_plugin_bindings),(SELECT count(*) FROM public.integration_plugin_approval_events)),
   'rejected '||fixture_surface||' '||fixture_owner||' activation rolls back status, hashes and all materialization writes');
  EXECUTE 'SET LOCAL ROLE authenticated';
 END LOOP;
 FOR fixture_label,fixture_policy IN SELECT * FROM (VALUES
  ('missing delivery','{"workflow":{"note":"workflow-preserved"},"custom":{"keep":true}}'::jsonb),
  ('missing workflow','{"delivery":{"note":"delivery-preserved"},"custom":[0,false]}'::jsonb),
  ('disabled sync','{"workflow":{"enabled":false,"template_name":"sg40-stale","note":"workflow-preserved"},"delivery":{"mode":"sync","status_code":200,"note":"delivery-preserved"},"custom":{"keep":true}}'::jsonb),
  ('disabled proxy','{"workflow":{"enabled":false,"template_name":"sg40-stale","note":"workflow-preserved"},"delivery":{"mode":"proxy","status_code":201,"note":"delivery-preserved"},"custom":{"keep":true}}'::jsonb)
 ) AS cases(label,policy) LOOP
  result:=api.integration_plugin_generate_draft_v1(
   p_plugin_name:='SG40 policy '||fixture_label,p_plugin_kind:='api',p_organization_id:=org,
   p_inbound_config:=jsonb_build_object('route',jsonb_build_object('method','POST',
    'path_template','/sg40-policy-'||gen_random_uuid(),'policy',fixture_policy)),
   p_workflow_binding:=jsonb_build_object('template_name',workflow_name));
  fixture_version:=(result->>'version_id')::uuid;
  PERFORM api.integration_plugin_submit_v1(fixture_version,'SG40 synthetic policy submit');
  PERFORM api.integration_plugin_approve_v1(fixture_version,'approved','SG40 synthetic policy approve');
  PERFORM api.integration_plugin_activate_v1(fixture_version,'tenant',org,'SG40 synthetic policy activate');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT r.policy FROM public.api_routes r
   JOIN public.integration_plugin_bindings b ON b.runtime_resource_id=r.id
   WHERE b.plugin_version_id=fixture_version AND b.binding_type='api_route' AND b.runtime_resource_type='api_routes' LIMIT 1),
   fixture_policy||jsonb_build_object(
    'workflow',COALESCE(fixture_policy->'workflow','{}'::jsonb)||jsonb_build_object('enabled',TRUE,'template_name',workflow_name),
    'delivery',COALESCE(fixture_policy->'delivery','{}'::jsonb)||jsonb_build_object('mode','accepted_async','status_code',202)),
   'activation canonicalizes '||fixture_label||' and preserves unrelated policy keys');
  EXECUTE 'SET LOCAL ROLE authenticated';
 END LOOP;
 SELECT to_jsonb(v) INTO before_value FROM public.integration_plugin_versions v WHERE id=version_id;
 UPDATE public.integration_plugin_versions SET metadata='{"password":"sg40-after-activation"}',source_payload=source_payload WHERE id=version_id;
 SELECT to_jsonb(v) INTO stored FROM public.integration_plugin_versions v WHERE id=version_id;
 RETURN NEXT is(stored-ARRAY['metadata','updated_at'],before_value-ARRAY['metadata','updated_at'],
  'post-activation metadata changes retain canonical payload and published hashes');
 RETURN NEXT throws_ok(format($q$SELECT api.integration_plugin_generate_draft_v1(p_plugin_name:='SG40 foreign',p_plugin_kind:='api',p_organization_id:=%L::uuid)$q$,foreign_org),
  'P0001','integration_plugin_generate_draft_v1 cannot create drafts for another organization','draft tenant authorization remains effective');
 RETURN NEXT throws_ok(format($q$INSERT INTO public.integration_plugins(organization_id,plugin_key,name) VALUES(%L,'sg40-denied','SG40 denied')$q$,foreign_org),
  '42501',NULL,'direct cross-tenant insert still fails RLS');
 EXECUTE 'SET LOCAL ROLE postgres';
 policy:=jsonb_set(policy,'{denies}','[{"capability_key":"integration_plugins.*"},{"capability_key":"mappings.*"},{"capability_key":"system.write"}]');
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,policy,policy_version,'SG40 rollback denial');
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT throws_ok($q$SELECT api.integration_plugin_generate_draft_v1(p_plugin_name:='SG40 denied',p_plugin_kind:='api')$q$,
  '42501','Capability denied: integration_plugins.write','redaction does not bypass capability denial');
 RETURN NEXT throws_ok($q$SELECT api.ui_create_mapping_operation_report_v1('{"artifact_type":"integration_plugin"}')$q$,
  'P0001','ui_create_mapping_operation_report_v1 missing write capability','report RPC retains capability denial');
 RETURN NEXT throws_ok($q$SELECT api.ui_upsert_mapping_artifact_v1('{"artifact":"api_outbound"}')$q$,
  '42501','Capability denied: system.write','direct shared save retains capability denial before preparation');
 EXECUTE 'SET LOCAL ROLE postgres';
 PERFORM set_config('request.jwt.claim.sub','',TRUE);
 PERFORM set_config('request.jwt.claims','{"role":"anon"}',TRUE);
 EXECUTE 'SET LOCAL ROLE anon';
 RETURN NEXT throws_ok($q$SELECT api.integration_plugin_redact_projection_v1('{}')$q$,'42501',NULL,'anonymous response RPC remains denied');
 EXECUTE 'SET LOCAL ROLE postgres';
END;
$test$;
SELECT * FROM pg_temp.sg40_writes();
SELECT * FROM finish();
ROLLBACK;
