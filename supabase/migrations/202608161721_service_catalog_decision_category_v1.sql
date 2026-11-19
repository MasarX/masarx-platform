BEGIN;

INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, status
)
SELECT id, 'service_catalog', 'Service Catalog', 'Service-level and offering decisions', 'active'
FROM public.lookup_definitions
WHERE category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;
