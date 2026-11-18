-- pgTAP: Recipient lookup values used by Console V2 must be present in the
-- live lookup catalog with row-driven display tones.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('valid', 'good'),
      ('pending', 'info'),
      ('unverified', 'warn'),
      ('invalid', 'danger')
    ) AS expected(value, tone)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
      WHERE d.category = 'phone_validation_status'
        AND v.value = expected.value
        AND v.status = 'active'
        AND v.metadata->>'tone' = expected.tone
    )
  ),
  'phone_validation_status lookup values are active and tone-backed'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'phone_validation_status'
      AND v.value = 'pending'
      AND v.is_default IS TRUE
  ),
  'phone_validation_status has a pending default for newly-created recipients'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('sms', 'info'),
      ('whatsapp', 'good'),
      ('email', 'neutral')
    ) AS expected(value, tone)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
      WHERE d.category = 'communication_channel'
        AND v.value = expected.value
        AND v.status = 'active'
        AND v.metadata->>'tone' = expected.tone
    )
  ),
  'communication_channel lookup values expose display tones'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('pending', 'info'),
      ('created', 'info'),
      ('in_transit', 'info'),
      ('out_for_delivery', 'info'),
      ('delivered', 'good'),
      ('delivery_failed', 'danger'),
      ('return_to_origin', 'warn'),
      ('cancelled', 'neutral')
    ) AS expected(value, tone)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
      WHERE d.category = 'shipment_status'
        AND v.value = expected.value
        AND v.status = 'active'
        AND v.metadata->>'tone' = expected.tone
    )
  ),
  'shipment_status lookup values expose display tones for recipient shipment chips'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('ar', 'Arabic'),
      ('en', 'English')
    ) AS expected(value, label)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
      WHERE d.category = 'language_code'
        AND v.value = expected.value
        AND v.label = expected.label
        AND v.status = 'active'
    )
  ),
  'language_code lookup values remain available for recipients.preferred_language'
);

SELECT * FROM finish();

ROLLBACK;
