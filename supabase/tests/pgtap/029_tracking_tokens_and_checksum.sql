-- Test Suite: tracking tokens + checksum characteristics

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- 1) Prefix truncation and uppercase
WITH policy AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', 'iso7064_mod_37_36',
    'prefix', jsonb_build_object('value','daxuretti-long-prefix','separator','', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','prefix'),
      jsonb_build_object('type','seq','len',6),
      jsonb_build_object('type','chk')
    )
  ) AS body
)
SELECT matches(
  (SELECT generate_tracking_number('tenant', NULL, body) FROM policy),
  '^DAXU[A-Z0-9]+$'::text,
  'prefix truncated to 4 and uppercased'::text
);

-- 2) Checksum appends one symbol
WITH policy AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', 'iso7064_mod_37_36',
    'prefix', jsonb_build_object('value',null,'separator','', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','seq','len',6),
      jsonb_build_object('type','chk')
    )
  ) AS body
), sample AS (
  SELECT generate_tracking_number('tenant', NULL, body) AS tn FROM policy
)
SELECT cmp_ok(length(tn), '>=', 7, 'checksum adds at least 1 character') FROM sample;

-- 3) Uppercase only
WITH policy AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', 'iso7064_mod_37_36',
    'prefix', jsonb_build_object('value', null, 'separator','', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','seq','len',4)
    )
  ) AS body
)
SELECT matches(
  (SELECT generate_tracking_number('tenant', NULL, body) FROM policy),
  '^[A-Z0-9]+$'::text,
  'uppercase alphanumerics only'::text
);

SELECT * FROM finish();

ROLLBACK;
