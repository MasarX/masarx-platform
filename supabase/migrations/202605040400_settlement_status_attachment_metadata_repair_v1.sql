BEGIN;

-- Preserve Console V2 presentation metadata while restoring the settlement
-- lifecycle flag consumed by attach_finance_event_to_settlement_v1.
WITH status_flags(value, attachments_allowed) AS (
  VALUES
    ('open', TRUE),
    ('locked', FALSE),
    ('approved', FALSE),
    ('posted', FALSE),
    ('canceled', FALSE)
)
UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
      || jsonb_build_object('attachments_allowed', sf.attachments_allowed)
  FROM public.lookup_definitions ld
  JOIN status_flags sf ON TRUE
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'settlement_status'
   AND lv.value = sf.value;

COMMIT;
