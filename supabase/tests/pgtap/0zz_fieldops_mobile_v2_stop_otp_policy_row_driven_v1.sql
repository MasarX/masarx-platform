-- pgTAP: Mobile V2 stop OTP requirements stay row-driven. Service-level
-- labels such as express must not silently make a stop require OTP unless
-- policy/metadata explicitly says so.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  NOT public.fieldops_v2_stop_otp_required_v1('{}'::jsonb, '{}'::jsonb, 'express'),
  'express service level alone does not require OTP'
);

SELECT ok(
  public.fieldops_v2_stop_otp_required_v1('{"otp_required": true}'::jsonb, '{}'::jsonb, 'standard'),
  'shipment metadata can explicitly require OTP'
);

SELECT ok(
  public.fieldops_v2_stop_otp_required_v1('{}'::jsonb, '{"otp_required": true}'::jsonb, 'standard'),
  'stop metadata can explicitly require OTP'
);

SELECT ok(
  NOT public.fieldops_v2_stop_otp_required_v1('{"otp_required": true}'::jsonb, '{"otp_required": false}'::jsonb, 'standard'),
  'stop metadata can explicitly override shipment OTP requirement'
);

SELECT ok(
  NOT public.fieldops_v2_stop_otp_required_v1('{"otp_required": false}'::jsonb, '{}'::jsonb, 'premium'),
  'explicit shipment metadata can keep premium service OTP off'
);

SELECT * FROM finish();
ROLLBACK;
