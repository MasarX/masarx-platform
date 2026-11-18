-- Register the existing authenticated rotation writer's decision category.
BEGIN;
SET LOCAL lock_timeout = '10s';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, is_default, status)
SELECT id, 'webhooks.rotate_source_token', 'Webhook source token rotation',
       'Authenticated webhook source credential rotation', false, 'active'
FROM public.lookup_definitions
WHERE category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET status = 'active', retired_at = NULL,
    effective_from = NULL, effective_until = NULL, updated_at = now();

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'decision_category'
      AND v.value = 'webhooks.rotate_source_token'
      AND v.status = 'active' AND v.retired_at IS NULL
      AND v.effective_from IS NULL AND v.effective_until IS NULL
  ) THEN
    RAISE EXCEPTION 'Webhook rotation decision category contract is incomplete';
  END IF;
END;
$assert$;
COMMIT;
