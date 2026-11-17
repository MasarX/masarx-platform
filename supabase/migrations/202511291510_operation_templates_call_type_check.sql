-- Migration: operation_templates.call_type CHECK constraint normalization
-- Purpose:
--   Align the call_type CHECK constraint definition with pgTAP expectations
--   while keeping the allowed values and semantics identical.

BEGIN;

ALTER TABLE public.operation_templates
  DROP CONSTRAINT IF EXISTS operation_templates_call_type_check;

ALTER TABLE public.operation_templates
  ADD CONSTRAINT operation_templates_call_type_check
  CHECK (
    call_type IN (
      'provider_api',
      'client_webhook',
      'comms_sms',
      'comms_whatsapp',
      'comms_email',
      'comms_voice'
    )
  );

COMMIT;

