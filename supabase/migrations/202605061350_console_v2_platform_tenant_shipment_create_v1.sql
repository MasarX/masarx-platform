-- Console V2 manual shipment create tenant-lens repair.
--
-- Platform operators use Console V2 with an explicit active tenant lens during
-- first-tenant onboarding. The create-shipment RPC still resolved organization
-- scope only from the authenticated platform user's home organization, which
-- rejected tenant-scoped clients/senders selected from the UI. Allow platform
-- callers to pass the active tenant organization id in metadata, while keeping
-- non-platform callers fail-closed against scope spoofing.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605061350_console_v2_platform_tenant_shipment_create_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_next TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)'::regprocedure
  )
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.ui_create_shipment_v1 function is missing';
  END IF;

  v_next := replace(
    v_def,
$old$
  v_correlation_id UUID := gen_random_uuid();
  v_run_id UUID;
$old$,
$new$
  v_correlation_id UUID := gen_random_uuid();
  v_requested_org_text TEXT;
  v_requested_org_id UUID;
  v_run_id UUID;
$new$
  );
  IF v_next = v_def THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 declaration patch anchor not found';
  END IF;
  v_def := v_next;

  v_next := replace(
    v_def,
$old$
  v_metadata := v_metadata - 'ui' - 'dry_run';
  v_cod_currency := NULLIF(btrim(COALESCE(v_metadata->>'cod_currency', '')), '');
$old$,
$new$
  v_metadata := v_metadata - 'ui' - 'dry_run';
  v_requested_org_text := NULLIF(btrim(COALESCE(
    v_metadata->>'organization_id',
    v_metadata->>'active_organization_id',
    ''
  )), '');
  IF v_requested_org_text IS NOT NULL THEN
    BEGIN
      v_requested_org_id := v_requested_org_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 organization_id must be a uuid';
    END;
  END IF;
  v_metadata := v_metadata - 'organization_id' - 'active_organization_id';
  v_cod_currency := NULLIF(btrim(COALESCE(v_metadata->>'cod_currency', '')), '');
$new$
  );
  IF v_next = v_def THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 metadata patch anchor not found';
  END IF;
  v_def := v_next;

  v_next := replace(
    v_def,
$old$
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires organization context';
  END IF;
$old$,
$new$
  IF v_requested_org_id IS NOT NULL THEN
    IF v_scope_type = 'platform' THEN
      PERFORM 1
        FROM public.organizations o
       WHERE o.id = v_requested_org_id
         AND lower(COALESCE(o.billing_status, 'active')) <> 'suspended';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ui_create_shipment_v1 organization_id is unavailable';
      END IF;
      v_org_id := v_requested_org_id;
    ELSIF v_org_id IS DISTINCT FROM v_requested_org_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 organization_id is outside the current scope';
    END IF;
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires organization context';
  END IF;
$new$
  );
  IF v_next = v_def THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 organization-scope patch anchor not found';
  END IF;

  EXECUTE v_next;
END $do$;

REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605061350_console_v2_platform_tenant_shipment_create_v1'));

COMMIT;
