-- Driver application edge-breadth review reasons for duplicate/compliance denial.

BEGIN;
SET search_path TO public, extensions, pg_temp;

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'marketplace_participant_review_reason'
), seed(value, label, description, sort_order, metadata) AS (
  VALUES
    (
      'duplicate_identity',
      'Duplicate identity',
      'Application is rejected because the applicant matches an existing driver or participant identity.',
      130,
      '{"decision":"reject","tone":"danger","edge_case":"duplicate_identity"}'::jsonb
    ),
    (
      'compliance_document_mismatch',
      'Compliance document mismatch',
      'Application is rejected because submitted documents conflict with compliance requirements.',
      140,
      '{"decision":"reject","tone":"danger","edge_case":"compliance_denied"}'::jsonb
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
       FALSE,
       'active',
       seed.metadata,
       now()
  FROM def
 CROSS JOIN seed
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = FALSE,
    status = 'active',
    metadata = EXCLUDED.metadata,
    published_at = COALESCE(public.lookup_values.published_at, EXCLUDED.published_at),
    updated_at = now();

COMMIT;
