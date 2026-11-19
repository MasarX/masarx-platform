BEGIN;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('integration_plugin.set_binding', 'Plugin binding changed', 'Integration plugin runtime binding enablement changed from Console V2', 360)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('binding_enabled', 'Binding enabled', 'Integration plugin runtime binding enabled', 370),
  ('binding_disabled', 'Binding disabled', 'Integration plugin runtime binding disabled', 371)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_outcome'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    updated_at = now();

COMMIT;
