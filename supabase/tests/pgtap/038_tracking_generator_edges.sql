-- pgTAP: Tracking generator edge behaviors (alphabet, checksum, date tokens)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

-- 1) CROCKFORD32 alphabet emits digits/letters without I or O.
WITH policy AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'CROCKFORD32',
    'checksum', 'iso7064_mod_37_36',
    'prefix', jsonb_build_object('value', 'zx', 'separator', '', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','prefix'),
      jsonb_build_object('type','seq','len',8)
    )
  ) AS body
), sample AS (
  SELECT generate_tracking_number('tenant', NULL, body) AS tn
  FROM policy
)
SELECT matches(
  tn,
  '^ZX[0-9A-HJKMNP-TV-Z]+$'::text,
  'CROCKFORD32 sequence omits I/O characters'
)
FROM sample;

-- 2) Checksum adds exactly one character when enabled.
WITH with_chk AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', 'iso7064_mod_37_36',
    'prefix', jsonb_build_object('value', NULL, 'separator', '', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','seq','len',6),
      jsonb_build_object('type','chk')
    )
  ) AS body
), without_chk AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', 'none',
    'prefix', jsonb_build_object('value', NULL, 'separator', '', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','seq','len',6),
      jsonb_build_object('type','chk')
    )
  ) AS body
), samples AS (
  SELECT
    generate_tracking_number('tenant', NULL, with_chk.body) AS with_checksum,
    generate_tracking_number('tenant', NULL, without_chk.body) AS without_checksum
  FROM with_chk, without_chk
)
SELECT cmp_ok(
  length(with_checksum),
  '=',
  length(without_checksum) + 1,
  'Checksum-enabled output adds exactly one character'
)
FROM samples;

-- 3) Date token pattern YY uses UTC year.
WITH policy AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', NULL,
    'prefix', jsonb_build_object('value', NULL, 'separator', '', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','date','pattern','YY'),
      jsonb_build_object('type','seq','len',4)
    )
  ) AS body
), sample AS (
  SELECT
    generate_tracking_number('tenant', NULL, body) AS tn,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YY') AS expected
  FROM policy
)
SELECT is(
  substr(tn, 1, 2),
  expected,
  'YY date token matches UTC year'
)
FROM sample;

-- 4) Date token pattern YYMM renders UTC year+month.
WITH policy AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', NULL,
    'prefix', jsonb_build_object('value', NULL, 'separator', '', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','date','pattern','YYMM'),
      jsonb_build_object('type','seq','len',4)
    )
  ) AS body
), sample AS (
  SELECT
    generate_tracking_number('tenant', NULL, body) AS tn,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYMM') AS expected
  FROM policy
)
SELECT is(
  substr(tn, 1, 4),
  expected,
  'YYMM date token matches UTC year+month'
)
FROM sample;

-- 5) Date token pattern YYYY renders four-digit UTC year.
WITH policy AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', NULL,
    'prefix', jsonb_build_object('value', NULL, 'separator', '', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','date','pattern','YYYY'),
      jsonb_build_object('type','seq','len',4)
    )
  ) AS body
), sample AS (
  SELECT
    generate_tracking_number('tenant', NULL, body) AS tn,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY') AS expected
  FROM policy
)
SELECT is(
  substr(tn, 1, 4),
  expected,
  'YYYY date token matches UTC year'
)
FROM sample;

SELECT * FROM finish();

ROLLBACK;
