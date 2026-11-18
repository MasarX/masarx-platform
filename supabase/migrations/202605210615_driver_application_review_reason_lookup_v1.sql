-- Console V2 driver application review reason lookup seeds.

BEGIN;
SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable, scope_type)
VALUES (
  'marketplace_participant_review_reason',
  'Marketplace participant application review reasons partitioned by decision.',
  'fleet',
  'tier_1',
  TRUE,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    scope_type = EXCLUDED.scope_type,
    updated_at = now();

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'marketplace_participant_review_reason'
), seed(value, label, description, sort_order, is_default, metadata) AS (
  VALUES
    (
      'background_check_clear',
      'Background check clear',
      'Application is approved after background and compliance checks are clear.',
      10,
      TRUE,
      '{"decision":"approve","tone":"good"}'::jsonb
    ),
    (
      'capacity_available',
      'Capacity available',
      'Application is approved because marketplace capacity is currently available.',
      20,
      FALSE,
      '{"decision":"approve","tone":"good"}'::jsonb
    ),
    (
      'qualification_gap',
      'Qualification gap',
      'Application is rejected because required qualifications are missing or insufficient.',
      30,
      TRUE,
      '{"decision":"reject","tone":"danger"}'::jsonb
    ),
    (
      'compliance_gap',
      'Compliance gap',
      'Application is rejected because compliance requirements are not met.',
      40,
      FALSE,
      '{"decision":"reject","tone":"danger"}'::jsonb
    ),
    (
      'other',
      'Other',
      'Reviewer supplied another reason in notes.',
      90,
      FALSE,
      '{"tone":"neutral"}'::jsonb
    )
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  published_at
)
SELECT def.id,
       seed.value,
       seed.label,
       seed.description,
       seed.sort_order,
       seed.is_default,
       'active',
       seed.metadata,
       now()
  FROM def
 CROSS JOIN seed
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = EXCLUDED.metadata,
    published_at = COALESCE(public.lookup_values.published_at, EXCLUDED.published_at),
    updated_at = now();

UPDATE public.lookup_values v
SET status = 'inactive',
    updated_at = now()
WHERE v.lookup_definition_id = (
    SELECT id
      FROM public.lookup_definitions
     WHERE category = 'marketplace_participant_review_reason'
  )
  AND v.value NOT IN (
    'background_check_clear',
    'capacity_available',
    'qualification_gap',
    'compliance_gap',
    'other'
  )
  AND v.status = 'active';

COMMIT;
