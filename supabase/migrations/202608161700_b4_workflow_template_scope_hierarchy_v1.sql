-- Migration: workflow template scope hierarchy fix v1
-- Purpose:
--   - Prevent client/sender scoped users from reading sibling workflow template scopes.
--   - Preserve hierarchical reads for tenant users and direct-child sender reads for client users.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603062235_workflow_template_scope_hierarchy_fix_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
    v_scope_type TEXT := lower(COALESCE(NULLIF(public.current_user_scope_type(), ''), ''));
    v_scope_id UUID := public.current_user_scope_id();
    v_client_id UUID := public.current_user_client_id();
    v_target_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), 'global'));
BEGIN
    IF public.is_platform_user() THEN
        RETURN TRUE;
    END IF;

    IF v_org IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_target_scope_type = 'global' THEN
        RETURN TRUE;
    END IF;

    IF v_target_scope_type = 'tenant' THEN
        RETURN v_scope_type = 'tenant' AND p_scope_id = v_org;
    END IF;

    IF v_target_scope_type = 'client' THEN
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

    IF v_target_scope_type = 'sender' THEN
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
    END IF;

    RETURN FALSE;
END;
$function$;

COMMENT ON FUNCTION public.workflow_template_scope_allowed(TEXT, UUID)
    IS 'Return TRUE when current authenticated user can access a workflow template scope based on platform/tenant/client/sender hierarchy.';

SELECT pg_advisory_unlock(hashtext('202603062235_workflow_template_scope_hierarchy_fix_v1'));

COMMIT;
