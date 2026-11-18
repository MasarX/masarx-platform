-- Migration: repair final qualification lookup contracts
-- Purpose:
--   - Move workflow-template scope shape validation behind the lookup SSOT.
--   - Register decision categories used by the converged identity operations.

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('202609041100_final_qualification_lookup_contract_repairs_v1'));

LOCK TABLE public.workflow_templates IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category,
  allow_inactive,
  allowed_values
)
VALUES (
  'public',
  'workflow_templates',
  'scope_type',
  'scope_type',
  false,
  ARRAY['global', 'tenant', 'client', 'sender']::TEXT[]
)
ON CONFLICT (table_schema, table_name, column_name)
DO UPDATE SET
  lookup_category = EXCLUDED.lookup_category,
  allow_inactive = EXCLUDED.allow_inactive,
  allowed_values = EXCLUDED.allowed_values,
  updated_at = now();

SELECT public.apply_lookup_column_contracts('public');

CREATE OR REPLACE FUNCTION public.workflow_template_scope_contract_valid_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.lookup_column_contracts lc
    JOIN public.lookup_definitions ld
      ON ld.category = lc.lookup_category
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
     AND lv.value = p_scope_type
    JOIN public.scope_type_registry r
      ON r.scope_type = lv.value
    WHERE lc.table_schema = 'public'
      AND lc.table_name = 'workflow_templates'
      AND lc.column_name = 'scope_type'
      AND (lc.allowed_values IS NULL OR p_scope_type = ANY (lc.allowed_values))
      AND lv.retired_at IS NULL
      AND r.is_enabled = TRUE
      AND (lc.allow_inactive OR lv.status = 'active')
      AND (lv.effective_from IS NULL OR lv.effective_from <= now())
      AND (lv.effective_until IS NULL OR lv.effective_until > now())
      AND (
        (p_scope_id IS NOT NULL) IS NOT DISTINCT FROM
        (r.entity_table IS NOT NULL)
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.workflow_template_scope_contract_valid_v1(TEXT, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_template_scope_contract_valid_v1(TEXT, UUID)
  FROM anon;
GRANT EXECUTE ON FUNCTION public.workflow_template_scope_contract_valid_v1(TEXT, UUID)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_template_scope_contract_valid_v1(TEXT, UUID)
  TO service_role;

COMMENT ON FUNCTION public.workflow_template_scope_contract_valid_v1(TEXT, UUID)
  IS 'Validate workflow-template scope membership and ID shape through lookup and scope registries without requiring caller lookup-table access.';

ALTER TABLE public.workflow_templates
  DROP CONSTRAINT IF EXISTS workflow_templates_scope_type_id_shape_ck;

ALTER TABLE public.workflow_templates
  ADD CONSTRAINT workflow_templates_scope_type_id_shape_ck
  CHECK (public.workflow_template_scope_contract_valid_v1(scope_type, scope_id));

CREATE OR REPLACE FUNCTION public.workflow_template_scope_allowed(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_org UUID := public.current_user_org_id();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_client_id UUID := public.current_user_client_id();
BEGIN
  IF NOT public.workflow_template_scope_contract_valid_v1(p_scope_type, p_scope_id) THEN
    RETURN FALSE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  IF v_org IS NULL THEN
    RETURN FALSE;
  END IF;

  IF p_scope_type = public.get_root_scope_type_key_v1() THEN
    RETURN TRUE;
  END IF;

  IF p_scope_type = 'tenant' THEN
    RETURN v_scope_type = 'tenant' AND p_scope_id = v_org;
  END IF;

  IF p_scope_type = 'client' THEN
    IF v_scope_type = 'tenant' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = p_scope_id
          AND c.organization_id = v_org
      );
    END IF;

    IF v_scope_type = 'client' THEN
      RETURN p_scope_id = v_scope_id;
    END IF;

    RETURN FALSE;
  END IF;

  IF v_scope_type = 'tenant' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = p_scope_id
        AND c.organization_id = v_org
    );
  END IF;

  IF v_scope_type = 'client' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.senders s
      WHERE s.id = p_scope_id
        AND s.client_id = v_client_id
    );
  END IF;

  IF v_scope_type = 'sender' THEN
    RETURN p_scope_id = v_scope_id;
  END IF;

  RETURN FALSE;
END;
$function$;

COMMENT ON FUNCTION public.workflow_template_scope_allowed(TEXT, UUID)
  IS 'Return TRUE only for lookup-backed workflow-template scope inputs visible to the current authenticated user hierarchy.';

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false,
  'active'
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    (
      'dispute.escalate',
      'Dispute escalate',
      'Escalation of a marketplace dispute',
      760
    ),
    (
      'branches.zone_assign',
      'Branch zone assign',
      'Assignment of a zone to a service branch',
      761
    ),
    (
      'branches.zone_unassign',
      'Branch zone unassign',
      'Removal of a zone assignment from a service branch',
      762
    ),
    (
      'branches.member_add',
      'Branch member add',
      'Addition of a user to a service branch',
      763
    )
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  retired_at = NULL,
  effective_from = NULL,
  effective_until = NULL,
  updated_at = now();

DO $assert$
DECLARE
  v_constraint_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.lookup_column_contracts lc
    WHERE lc.table_schema = 'public'
      AND lc.table_name = 'workflow_templates'
      AND lc.column_name = 'scope_type'
      AND lc.lookup_category = 'scope_type'
      AND cardinality(lc.allowed_values) = 4
      AND lc.allowed_values @> ARRAY['global', 'tenant', 'client', 'sender']::TEXT[]
      AND lc.allowed_values <@ ARRAY['global', 'tenant', 'client', 'sender']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'workflow_templates scope_type lookup contract is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'public.workflow_template_scope_contract_valid_v1(text,uuid)'
    )
      AND p.prosecdef
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee = 0
          AND a.privilege_type = 'EXECUTE'
      )
  )
  OR NOT has_function_privilege(
    'authenticated',
    'public.workflow_template_scope_contract_valid_v1(text,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'workflow template scope contract validator privileges are incomplete';
  END IF;

  SELECT pg_get_constraintdef(c.oid)
    INTO v_constraint_definition
  FROM pg_constraint c
  WHERE c.conrelid = 'public.workflow_templates'::regclass
    AND c.conname = 'workflow_templates_scope_type_id_shape_ck';

  IF v_constraint_definition IS NULL
     OR public.constraint_has_literal_allowlist_v1(v_constraint_definition) THEN
    RAISE EXCEPTION 'workflow_templates scope shape constraint remains literal-backed';
  END IF;

  IF (
    SELECT count(*)
    FROM public.lookup_definitions d
    JOIN public.lookup_values lv ON lv.lookup_definition_id = d.id
    WHERE d.category = 'decision_category'
      AND lv.value = ANY (
        ARRAY[
          'dispute.escalate',
          'branches.zone_assign',
          'branches.zone_unassign',
          'branches.member_add'
        ]::TEXT[]
      )
      AND lv.status = 'active'
      AND lv.retired_at IS NULL
      AND lv.effective_from IS NULL
      AND lv.effective_until IS NULL
  ) <> 4 THEN
    RAISE EXCEPTION 'identity decision-category lookup repair is incomplete';
  END IF;
END;
$assert$;

COMMIT;
