BEGIN;
SET LOCAL lock_timeout = '30s';

-- One receipt for the non-atomic Auth/email + membership operation; not a job queue.
CREATE TABLE public.tenant_user_invite_requests (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  actor_user_id UUID NOT NULL REFERENCES public.users(id),
  action TEXT NOT NULL,
  email TEXT NOT NULL CHECK (email = lower(btrim(email))),
  full_name TEXT NOT NULL,
  user_type TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES public.rbac_roles(id),
  access_scope_type TEXT NOT NULL,
  access_scope_id UUID,
  auth_user_id UUID,
  mailbox_token_hash TEXT,
  mailbox_expires_at TIMESTAMPTZ,
  mailbox_claimed_at TIMESTAMPTZ,
  mailbox_accepted_at TIMESTAMPTZ,
  auth_created_by_invite BOOLEAN NOT NULL DEFAULT FALSE,
  mailbox_support_only BOOLEAN NOT NULL DEFAULT FALSE,
  password_fingerprint TEXT,
  provider_state TEXT NOT NULL,
  membership_state TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The lookup subset owns vocabulary; this constraint only enforces the scope/id shape.
  CHECK ((access_scope_type = 'tenant') = (access_scope_id IS NULL))
);
CREATE INDEX tenant_user_invite_requests_organization_id_idx ON public.tenant_user_invite_requests(organization_id);
CREATE INDEX tenant_user_invite_requests_actor_user_id_idx ON public.tenant_user_invite_requests(actor_user_id);
CREATE INDEX tenant_user_invite_requests_role_id_idx ON public.tenant_user_invite_requests(role_id);
CREATE UNIQUE INDEX tenant_user_invite_requests_mailbox_token_hash_idx
  ON public.tenant_user_invite_requests(mailbox_token_hash) WHERE mailbox_token_hash IS NOT NULL;
CREATE UNIQUE INDEX tenant_user_invite_requests_created_auth_user_id_idx
  ON public.tenant_user_invite_requests(auth_user_id) WHERE auth_created_by_invite;
ALTER TABLE public.tenant_user_invite_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_user_invite_requests FROM PUBLIC, anon, authenticated, service_role;
-- Explicit service-only policy; existing ACLs still require the checked RPC facades.
CREATE POLICY tenant_user_invite_requests_service_policy
  ON public.tenant_user_invite_requests
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);
CREATE TRIGGER trg_tenant_user_invite_requests_set_updated_at
  BEFORE UPDATE ON public.tenant_user_invite_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER audit_row_change BEFORE INSERT OR UPDATE OR DELETE
  ON public.tenant_user_invite_requests FOR EACH ROW EXECUTE FUNCTION public.audit_capture_row_change();
CREATE TRIGGER audit_truncate_change AFTER TRUNCATE
  ON public.tenant_user_invite_requests FOR EACH STATEMENT EXECUTE FUNCTION public.audit_capture_row_change();
INSERT INTO public.table_contracts(table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES ('public', 'tenant_user_invite_requests', TRUE, TRUE, TRUE, 'Tenant-managed invite provider/membership outcomes; no automatic provider retry.');
INSERT INTO public.audit_redaction_rules(table_schema, table_name, mode, columns, redaction_token)
VALUES ('public', 'tenant_user_invite_requests', 'denylist',
  ARRAY['auth_user_id', 'auth_created_by_invite', 'mailbox_support_only', 'mailbox_token_hash',
    'mailbox_expires_at', 'mailbox_claimed_at', 'mailbox_accepted_at', 'password_fingerprint', 'provider_state']::TEXT[], '[REDACTED]')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET mode = EXCLUDED.mode, columns = EXCLUDED.columns, redaction_token = EXCLUDED.redaction_token, updated_at = now();

-- Same canonical row-driven contracts as other lifecycle tables; no literal enum CHECKs.
INSERT INTO public.lookup_definitions(category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('tenant_user_invite_action', 'Explicit tenant user invitation operation.', 'engineering', 'tier_1', FALSE),
  ('tenant_user_invite_provider_state', 'Tenant invitation provider outcome, independent of membership.', 'engineering', 'tier_1', FALSE),
  ('tenant_user_invite_membership_state', 'Tenant invitation membership readback state.', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description, owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy, is_mutable = EXCLUDED.is_mutable;

INSERT INTO public.lookup_values(lookup_definition_id, value, label, description, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.description, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d JOIN (VALUES
  ('tenant_user_invite_action', 'invite', 'Invite', 'Explicit invitation requiring fresh mailbox acceptance.', 10, TRUE),
  ('tenant_user_invite_action', 'resend', 'Resend', 'Explicit resend without changing existing membership.', 20, FALSE),
  ('tenant_user_invite_provider_state', 'ready', 'Ready', 'Authorized operation not yet dispatched.', 10, TRUE),
  ('tenant_user_invite_provider_state', 'accepted', 'Accepted', 'Provider accepted; inbox delivery is not proven.', 30, FALSE),
  ('tenant_user_invite_provider_state', 'failed', 'Failed', 'Provider definitively rejected the operation.', 40, FALSE),
  ('tenant_user_invite_provider_state', 'unknown', 'Unknown', 'Provider side effect is possible; do not resend automatically.', 50, FALSE),
  ('tenant_user_invite_membership_state', 'pending', 'Pending', 'Scoped membership is not yet confirmed.', 10, TRUE),
  ('tenant_user_invite_membership_state', 'applied', 'Applied', 'Authenticated scoped membership applied and read back.', 20, FALSE)
) AS v(category, value, label, description, sort_order, is_default) ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default, status = EXCLUDED.status, retired_at = NULL, effective_until = NULL, updated_at = now();

INSERT INTO public.lookup_column_contracts(table_schema, table_name, column_name, lookup_category, allow_inactive, allowed_values)
VALUES
  ('public', 'tenant_user_invite_requests', 'action', 'tenant_user_invite_action', FALSE, ARRAY['invite', 'resend']::TEXT[]),
  ('public', 'tenant_user_invite_requests', 'access_scope_type', 'scope_type', FALSE, ARRAY['tenant', 'client', 'sender']::TEXT[]),
  ('public', 'tenant_user_invite_requests', 'provider_state', 'tenant_user_invite_provider_state', FALSE,
    ARRAY['ready', 'accepted', 'failed', 'unknown']::TEXT[]),
  ('public', 'tenant_user_invite_requests', 'membership_state', 'tenant_user_invite_membership_state', FALSE, ARRAY['pending', 'applied']::TEXT[])
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category, allow_inactive = EXCLUDED.allow_inactive,
  allowed_values = EXCLUDED.allowed_values, updated_at = now();
-- Target-only application of the existing canonical lookup-trigger contract.
DO $lookup$
DECLARE
  v_trigger TEXT := 'trg_lookup_contract_' || substr(md5('public.tenant_user_invite_requests'), 1, 12);
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF access_scope_type, action, membership_state, provider_state ON public.tenant_user_invite_requests
    FOR EACH ROW EXECUTE FUNCTION public.enforce_lookup_column_contracts()', v_trigger);
END;
$lookup$;

-- Authenticated senders see their intent and a neutral outcome, never identity eligibility.
CREATE FUNCTION public.tenant_user_invite_receipt_v1(p_row public.tenant_user_invite_requests)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', p_row.id, 'request_id', p_row.id, 'action', p_row.action,
    'user_type', p_row.user_type, 'role_id', p_row.role_id,
    'access_scope_type', p_row.access_scope_type, 'access_scope_id', p_row.access_scope_id,
    'provider_state', CASE WHEN p_row.dispatched_at IS NULL THEN 'ready' ELSE 'unknown' END,
    'membership_state', p_row.membership_state)
$$;
REVOKE ALL ON FUNCTION public.tenant_user_invite_receipt_v1(public.tenant_user_invite_requests)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.tenant_user_invite_assert_v1(
  p_user_type TEXT, p_role_id UUID, p_scope_type TEXT, p_scope_id UUID, p_target_user_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_actor public.users%ROWTYPE;
  v_role public.rbac_roles%ROWTYPE;
  v_target public.users%ROWTYPE;
  v_default_scope TEXT;
  v_policy JSONB;
  v_scope_id UUID;
  v_role_keys TEXT[];
  v_actor_caps TEXT[];
  v_pattern TEXT;
  v_expanded TEXT[];
  v_cap TEXT;
  v_permission RECORD;
BEGIN
  -- A service credential or caller-supplied actor is never tenant delegation authority.
  IF COALESCE(auth.role(), '') <> 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite:authenticated_actor_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_actor FROM public.users WHERE id = auth.uid();
  IF v_actor.id IS NULL OR v_actor.status IS DISTINCT FROM 'active' OR v_actor.access_scope_type IS DISTINCT FROM 'tenant' THEN
    RAISE EXCEPTION 'tenant_user_invite:tenant_manager_required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('users.manage', 'tenant', v_actor.organization_id);
  SELECT lv.metadata->>'default_scope_type' INTO v_default_scope
    FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'user_type' AND lv.value = p_user_type AND lv.status = 'active';
  IF v_default_scope IS NULL OR v_default_scope NOT IN ('tenant', 'client', 'sender')
     OR p_scope_type IS DISTINCT FROM v_default_scope THEN
    RAISE EXCEPTION 'tenant_user_invite:incompatible_user_scope' USING ERRCODE = '42501';
  END IF;
  IF (p_scope_type = 'tenant' AND p_scope_id IS NOT NULL)
     OR (p_scope_type = 'client' AND NOT EXISTS (
       SELECT 1 FROM public.clients WHERE id = p_scope_id AND organization_id = v_actor.organization_id))
     OR (p_scope_type = 'sender' AND NOT EXISTS (
       SELECT 1 FROM public.senders s JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = p_scope_id AND c.organization_id = v_actor.organization_id)) THEN
    RAISE EXCEPTION 'tenant_user_invite:scope_outside_tenant' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_role FROM public.rbac_roles
    WHERE id = p_role_id AND organization_id = v_actor.organization_id AND is_active;
  IF v_role.id IS NULL OR COALESCE(v_role.metadata->>'scope_type', '') IN ('platform', 'global') THEN
    RAISE EXCEPTION 'tenant_user_invite:role_outside_tenant' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_target FROM public.users WHERE id = p_target_user_id;
  IF v_target.id IS NOT NULL AND (v_target.organization_id <> v_actor.organization_id
    OR v_target.status IS DISTINCT FROM 'active' OR v_target.user_type IS DISTINCT FROM p_user_type
    OR v_target.access_scope_type IS DISTINCT FROM p_scope_type
    OR v_target.access_scope_id IS DISTINCT FROM p_scope_id) THEN
    RAISE EXCEPTION 'tenant_user_invite:existing_membership_conflict' USING ERRCODE = '42501';
  END IF;

  v_scope_id := CASE WHEN p_scope_type = 'tenant' THEN v_actor.organization_id ELSE p_scope_id END;
  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1(p_scope_type, v_scope_id, FALSE) LIMIT 1;
  v_role_keys := public.resolve_role_keys_v1(v_policy,
    COALESCE(p_target_user_id, '00000000-0000-0000-0000-000000000000'::uuid), p_user_type);
  IF v_policy IS NULL OR COALESCE(cardinality(v_role_keys), 0) = 0 OR EXISTS (
    SELECT 1 FROM unnest(v_role_keys) k WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_policy->'roles') r WHERE r->>'key' = k)) THEN
    RAISE EXCEPTION 'tenant_user_invite:unknown_capability_role' USING ERRCODE = '42501';
  END IF;
  v_actor_caps := public.resolve_capabilities_v1(v_policy,
    public.resolve_role_keys_v1(v_policy, auth.uid(), v_actor.user_type));
  -- user_type capability roles and the requested RBAC role are independent SSOTs.
  FOR v_pattern IN SELECT unnest(public.resolve_capabilities_v1(v_policy, v_role_keys || ARRAY[v_role.key])) LOOP
    IF v_pattern IS NULL OR v_pattern = '' OR v_pattern = '*' THEN
      RAISE EXCEPTION 'tenant_user_invite:capability_escalation' USING ERRCODE = '42501';
    END IF;
    IF position('*' IN v_pattern) > 0 THEN
      -- A tenant wildcard needs a covering actor rule AND effective checks over its registered domain.
      IF right(v_pattern, 2) <> '.*' OR NOT EXISTS (
        SELECT 1 FROM unnest(v_actor_caps) rule WHERE public.capability_key_match(v_pattern, rule)) THEN
        RAISE EXCEPTION 'tenant_user_invite:capability_escalation' USING ERRCODE = '42501';
      END IF;
      SELECT array_agg(DISTINCT key) INTO v_expanded FROM (
        SELECT c->>'key' AS key FROM jsonb_array_elements(v_policy->'capabilities') c
        UNION SELECT d->>'capability_key' FROM jsonb_array_elements(COALESCE(v_policy->'denies', '[]')) d
      ) known WHERE key IS NOT NULL AND position('*' IN key) = 0 AND public.capability_key_match(key, v_pattern);
      IF COALESCE(cardinality(v_expanded), 0) = 0 THEN
        RAISE EXCEPTION 'tenant_user_invite:unknown_capability_domain' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_policy->'capabilities') c WHERE c->>'key' = v_pattern) THEN
        RAISE EXCEPTION 'tenant_user_invite:unknown_capability_domain' USING ERRCODE = '42501';
      END IF;
      v_expanded := ARRAY[v_pattern];
    END IF;
    FOREACH v_cap IN ARRAY v_expanded LOOP
      IF NOT COALESCE(public.user_has_capability_v1(v_cap, p_scope_type, v_scope_id), FALSE) THEN
        RAISE EXCEPTION 'tenant_user_invite:capability_escalation' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
  FOR v_permission IN
    SELECT rp.organization_id, lv.value, lv.status, ld.category
    FROM public.rbac_role_permissions rp
    JOIN public.lookup_values lv ON lv.id = rp.permission_id
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE rp.role_id = p_role_id OR rp.role_id IN (
      SELECT ura.role_id FROM public.rbac_user_role_assignments ura
      JOIN public.rbac_roles r ON r.id = ura.role_id AND r.is_active
      WHERE ura.user_id = p_target_user_id AND ura.revoked_at IS NULL
        AND ura.organization_id = v_actor.organization_id AND r.organization_id = v_actor.organization_id)
  LOOP
    IF v_permission.organization_id IS DISTINCT FROM v_actor.organization_id OR v_permission.category IS DISTINCT FROM 'rbac_permission'
       OR v_permission.status IS DISTINCT FROM 'active'
       OR NOT COALESCE(public.user_has_permission_v1(v_permission.value, v_actor.organization_id), FALSE) THEN
      RAISE EXCEPTION 'tenant_user_invite:permission_escalation' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN v_actor.organization_id;
END;
$$;
REVOKE ALL ON FUNCTION public.tenant_user_invite_assert_v1(TEXT, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.tenant_user_invite_prepare_v1(p_request_id UUID, p_args JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_row public.tenant_user_invite_requests%ROWTYPE;
  v_existing public.users%ROWTYPE;
  v_email TEXT := lower(btrim(p_args->>'email'));
  v_name TEXT := btrim(p_args->>'full_name');
  v_type TEXT := p_args->>'user_type';
  v_role UUID := NULLIF(p_args->>'role_id', '')::uuid;
  v_scope TEXT := p_args->>'access_scope_type';
  v_scope_id UUID := NULLIF(p_args->>'access_scope_id', '')::uuid;
  v_action TEXT := COALESCE(p_args->>'action', 'invite');
  v_auth_id UUID;
  v_org UUID;
BEGIN
  IF COALESCE(auth.role(), '') <> 'authenticated' OR auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND status = 'active' AND access_scope_type = 'tenant') THEN
    RAISE EXCEPTION 'tenant_user_invite:tenant_manager_required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('users.manage', 'tenant', public.current_user_org_id());
  IF p_request_id IS NULL OR v_action NOT IN ('invite', 'resend') OR p_args->>'send_email' = 'false' THEN
    RAISE EXCEPTION 'tenant_user_invite:invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_action = 'resend' THEN
    SELECT * INTO v_existing FROM public.users WHERE id = NULLIF(p_args->>'target_user_id', '')::uuid
      AND organization_id = public.current_user_org_id();
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION 'tenant_user_invite:target_unavailable' USING ERRCODE = '42501';
    END IF;
    v_email := lower(v_existing.email); v_name := v_existing.full_name; v_type := v_existing.user_type;
    v_scope := v_existing.access_scope_type; v_scope_id := v_existing.access_scope_id;
    SELECT ura.role_id INTO v_role FROM public.rbac_user_role_assignments ura
      JOIN public.rbac_roles r ON r.id = ura.role_id AND r.is_active AND r.organization_id = v_existing.organization_id
      WHERE ura.user_id = v_existing.id AND ura.organization_id = v_existing.organization_id AND ura.revoked_at IS NULL
      ORDER BY ura.assigned_at, ura.id LIMIT 1;
  END IF;
  IF v_email IS NULL OR length(v_email) > 320 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR COALESCE(length(v_name), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'tenant_user_invite:invalid_input' USING ERRCODE = '22023';
  END IF;
  -- Serialize the email boundary without holding a transaction across the provider call.
  PERFORM pg_advisory_xact_lock(hashtextextended('tenant_user_invite:' || v_email, 0));
  SELECT id INTO v_auth_id FROM auth.users WHERE lower(email) = v_email;
  v_org := public.tenant_user_invite_assert_v1(v_type, v_role, v_scope, v_scope_id, NULL);
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NOT NULL THEN
    IF v_row.actor_user_id IS DISTINCT FROM auth.uid() OR v_row.organization_id <> v_org
       OR (v_row.action, v_row.email, v_row.full_name, v_row.user_type, v_row.role_id,
           v_row.access_scope_type, v_row.access_scope_id)
          IS DISTINCT FROM (v_action, v_email, v_name, v_type, v_role, v_scope, v_scope_id) THEN
      RAISE EXCEPTION 'tenant_user_invite:request_conflict' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- One unresolved provider operation per email, even with different request IDs.
    IF EXISTS (SELECT 1 FROM public.tenant_user_invite_requests WHERE email = v_email AND organization_id = v_org
      AND provider_state IN ('ready', 'unknown') AND id <> p_request_id) THEN
      RAISE EXCEPTION 'tenant_user_invite:provider_outcome_pending' USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.tenant_user_invite_requests(id, organization_id, actor_user_id, action,
      email, full_name, user_type, role_id, access_scope_type, access_scope_id, auth_user_id, provider_state)
    VALUES (p_request_id, v_org, auth.uid(), v_action, v_email, v_name, v_type, v_role, v_scope,
      v_scope_id, v_auth_id, 'ready')
    RETURNING * INTO v_row;
  END IF;
  RETURN public.tenant_user_invite_receipt_v1(v_row);
END;
$$;

CREATE FUNCTION public.tenant_user_invite_dispatch_v1(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row public.tenant_user_invite_requests%ROWTYPE; v_dispatch BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.actor_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'tenant_user_invite:request_unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM public.tenant_user_invite_assert_v1(v_row.user_type, v_row.role_id,
    v_row.access_scope_type, v_row.access_scope_id, NULL);
  IF v_row.provider_state = 'ready' THEN
    UPDATE public.tenant_user_invite_requests SET provider_state = 'unknown', dispatched_at = now(), updated_at = now()
      WHERE id = p_request_id RETURNING * INTO v_row;
    v_dispatch := TRUE;
  END IF;
  RETURN public.tenant_user_invite_receipt_v1(v_row) || jsonb_build_object(
    'email', v_row.email, 'full_name', v_row.full_name, 'should_dispatch', v_dispatch);
END;
$$;

-- Service may report the provider result, never choose actor/tenant/grants or apply membership.
CREATE FUNCTION public.tenant_user_invite_provider_result_v1(p_request_id UUID, p_state TEXT, p_auth_user_id UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row public.tenant_user_invite_requests%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'tenant_user_invite:provider_reporter_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.provider_state <> 'unknown' OR v_row.dispatched_at IS NULL
     OR p_state IS NULL OR p_state NOT IN ('accepted', 'failed', 'unknown')
     OR (p_state <> 'accepted' AND p_auth_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant_user_invite:invalid_provider_result' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'accepted' AND NOT (v_row.mailbox_support_only AND p_auth_user_id IS NULL)
     AND (p_auth_user_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM auth.users WHERE id = p_auth_user_id AND lower(email) = v_row.email)) THEN
    RAISE EXCEPTION 'tenant_user_invite:provider_identity_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_row.auth_user_id IS NOT NULL AND p_auth_user_id IS NOT NULL AND v_row.auth_user_id <> p_auth_user_id THEN
    RAISE EXCEPTION 'tenant_user_invite:provider_identity_mismatch' USING ERRCODE = '42501';
  END IF;
  UPDATE public.tenant_user_invite_requests SET provider_state = p_state,
    auth_user_id = COALESCE(p_auth_user_id, auth_user_id), updated_at = now() WHERE id = p_request_id;
END;
$$;

-- Only a successful createUser result from this dispatch may attest a new identity.
CREATE FUNCTION public.tenant_user_invite_mailbox_issue_v1(
  p_request_id UUID, p_token_hash TEXT, p_created_auth_user_id UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row public.tenant_user_invite_requests%ROWTYPE; v_auth auth.users%ROWTYPE; v_mode TEXT := 'support_only';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'tenant_user_invite:mailbox_reporter_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id;
  IF v_row.id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'tenant_user_invite:invalid_mailbox_request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tenant_user_invite:' || v_row.email, 0));
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.provider_state <> 'unknown' OR v_row.dispatched_at IS NULL OR v_row.mailbox_token_hash IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_user_invite:mailbox_already_issued_or_unavailable' USING ERRCODE = '55000';
  END IF;
  IF v_row.mailbox_support_only THEN
    RETURN jsonb_build_object('acceptance_mode', 'support_only', 'email', v_row.email);
  END IF;
  SELECT * INTO v_auth FROM auth.users WHERE lower(email) = v_row.email FOR UPDATE;
  IF v_auth.id IS NOT NULL AND v_auth.is_anonymous IS FALSE
     AND (SELECT count(*) FROM auth.users WHERE lower(email) = v_row.email) = 1
     AND (v_row.auth_user_id IS NULL OR v_row.auth_user_id = v_auth.id) THEN
    IF p_created_auth_user_id = v_auth.id AND v_row.auth_user_id IS NULL
       AND v_auth.email_confirmed_at IS NOT NULL AND COALESCE(v_auth.encrypted_password, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_auth.id OR lower(email) = v_row.email)
       AND NOT EXISTS (SELECT 1 FROM public.tenant_user_invite_requests
         WHERE auth_user_id = v_auth.id AND auth_created_by_invite) THEN
      v_mode := 'new_account';
    ELSIF p_created_auth_user_id IS NULL AND EXISTS (SELECT 1 FROM public.users
      WHERE id = v_auth.id AND lower(email) = v_row.email AND status = 'active'
        AND organization_id = v_row.organization_id) THEN
      v_mode := 'active_member';
    END IF;
  END IF;
  -- Orphans and unsupported foreign memberships are neutral, never recovery authority.
  IF v_mode = 'support_only' THEN
    UPDATE public.tenant_user_invite_requests SET mailbox_support_only = TRUE, updated_at = now() WHERE id = p_request_id;
    RETURN jsonb_build_object('acceptance_mode', v_mode, 'email', v_row.email);
  END IF;
  UPDATE public.tenant_user_invite_requests SET auth_user_id = v_auth.id,
    auth_created_by_invite = (v_mode = 'new_account'), mailbox_token_hash = p_token_hash,
    mailbox_expires_at = clock_timestamp() + interval '1 hour', updated_at = now() WHERE id = p_request_id;
  RETURN jsonb_build_object('acceptance_mode', v_mode, 'auth_user_id', v_auth.id, 'email', v_row.email);
END;
$$;

CREATE FUNCTION public.tenant_user_invite_mailbox_claim_v1(p_request_id UUID, p_token_hash TEXT, p_new_password TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row public.tenant_user_invite_requests%ROWTYPE; v_auth auth.users%ROWTYPE; v_session TEXT;
BEGIN
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite:mailbox_token_invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tenant_user_invite:' || v_row.email, 0));
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id FOR UPDATE;
  IF p_token_hash IS NULL OR p_token_hash IS DISTINCT FROM v_row.mailbox_token_hash
     OR v_row.mailbox_expires_at IS NULL OR v_row.mailbox_expires_at <= clock_timestamp()
     OR v_row.mailbox_claimed_at IS NOT NULL OR v_row.mailbox_accepted_at IS NOT NULL
     OR v_row.provider_state NOT IN ('accepted', 'unknown') THEN
    RAISE EXCEPTION 'tenant_user_invite:mailbox_token_invalid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_auth FROM auth.users WHERE id = v_row.auth_user_id AND lower(email) = v_row.email FOR UPDATE;
  IF v_auth.id IS NULL OR v_auth.is_anonymous IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'tenant_user_invite:mailbox_token_invalid' USING ERRCODE = '42501';
  END IF;
  IF v_row.auth_created_by_invite THEN
    IF auth.role() IS DISTINCT FROM 'service_role' OR EXISTS (SELECT 1 FROM public.users WHERE id = v_auth.id) THEN
      RAISE EXCEPTION 'tenant_user_invite:mailbox_token_invalid' USING ERRCODE = '42501';
    END IF;
    IF p_new_password IS NULL OR length(p_new_password) < 12 OR octet_length(p_new_password) > 72 THEN
      RAISE EXCEPTION 'tenant_user_invite:new_password_required' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS DISTINCT FROM v_auth.id THEN
      RAISE EXCEPTION 'tenant_user_invite:recipient_session_required' USING ERRCODE = '42501';
    END IF;
    v_session := auth.jwt()->>'session_id';
    IF v_session IS NULL OR v_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'tenant_user_invite:recipient_session_required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id = v_session::uuid AND user_id = v_auth.id)
       OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_auth.id AND lower(email) = v_row.email
         AND organization_id = v_row.organization_id AND status = 'active') THEN
      RAISE EXCEPTION 'tenant_user_invite:recipient_session_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE public.tenant_user_invite_requests SET mailbox_claimed_at = clock_timestamp(),
    password_fingerprint = CASE WHEN auth_created_by_invite
      THEN encode(extensions.digest(COALESCE(v_auth.encrypted_password, ''), 'sha256'), 'hex') END,
    updated_at = now() WHERE id = p_request_id;
  RETURN jsonb_build_object('acceptance_mode', CASE WHEN v_row.auth_created_by_invite THEN 'new_account' ELSE 'active_member' END,
    'email', v_row.email, 'auth_user_id', v_auth.id);
END;
$$;

CREATE FUNCTION public.tenant_user_invite_mailbox_accept_v1(p_request_id UUID, p_token_hash TEXT, p_new_password TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row public.tenant_user_invite_requests%ROWTYPE; v_auth auth.users%ROWTYPE; v_session TEXT;
BEGIN
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NULL OR p_token_hash IS NULL OR p_token_hash IS DISTINCT FROM v_row.mailbox_token_hash
     OR v_row.mailbox_expires_at IS NULL OR v_row.mailbox_expires_at <= clock_timestamp()
     OR v_row.mailbox_claimed_at IS NULL OR v_row.mailbox_accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_user_invite:mailbox_token_invalid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_auth FROM auth.users WHERE id = v_row.auth_user_id AND lower(email) = v_row.email FOR UPDATE;
  IF v_auth.id IS NULL OR v_auth.is_anonymous IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'tenant_user_invite:mailbox_token_invalid' USING ERRCODE = '42501';
  END IF;
  IF v_row.auth_created_by_invite THEN
    IF auth.role() IS DISTINCT FROM 'service_role' OR EXISTS (SELECT 1 FROM public.users WHERE id = v_auth.id)
       OR v_auth.email_confirmed_at IS NULL OR p_new_password IS NULL OR length(p_new_password) < 12
       OR octet_length(p_new_password) > 72
       OR COALESCE(v_auth.encrypted_password, '') !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
       OR v_row.password_fingerprint IS NULL
       OR encode(extensions.digest(v_auth.encrypted_password, 'sha256'), 'hex') = v_row.password_fingerprint THEN
      RAISE EXCEPTION 'tenant_user_invite:new_account_password_required' USING ERRCODE = '42501';
    END IF;
    IF extensions.crypt(p_new_password, v_auth.encrypted_password) <> v_auth.encrypted_password THEN
      RAISE EXCEPTION 'tenant_user_invite:new_account_password_required' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS DISTINCT FROM v_auth.id THEN
      RAISE EXCEPTION 'tenant_user_invite:recipient_session_required' USING ERRCODE = '42501';
    END IF;
    v_session := auth.jwt()->>'session_id';
    IF v_session IS NULL OR v_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'tenant_user_invite:recipient_session_required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id = v_session::uuid AND user_id = v_auth.id)
       OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_auth.id AND lower(email) = v_row.email
         AND organization_id = v_row.organization_id AND status = 'active') THEN
      RAISE EXCEPTION 'tenant_user_invite:recipient_session_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE public.tenant_user_invite_requests SET mailbox_accepted_at = clock_timestamp(),
    password_fingerprint = CASE WHEN auth_created_by_invite
      THEN encode(extensions.digest(COALESCE(v_auth.encrypted_password, ''), 'sha256'), 'hex') END,
    updated_at = now() WHERE id = p_request_id;
  RETURN jsonb_build_object('accepted', TRUE);
END;
$$;

CREATE FUNCTION public.tenant_user_invite_finalize_v1(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row public.tenant_user_invite_requests%ROWTYPE; v_auth_id UUID; v_org UUID;
BEGIN
  SELECT * INTO v_row FROM public.tenant_user_invite_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.actor_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'tenant_user_invite:request_unavailable' USING ERRCODE = '42501';
  END IF;
  v_org := public.tenant_user_invite_assert_v1(v_row.user_type, v_row.role_id,
    v_row.access_scope_type, v_row.access_scope_id, NULL);
  IF v_org <> v_row.organization_id THEN
    RAISE EXCEPTION 'tenant_user_invite:organization_changed' USING ERRCODE = '42501';
  END IF;
  IF v_row.membership_state = 'pending' AND v_row.mailbox_accepted_at IS NOT NULL
     AND v_row.provider_state IN ('accepted', 'unknown') THEN
    SELECT id INTO v_auth_id FROM auth.users WHERE lower(email) = v_row.email FOR UPDATE;
    IF v_auth_id IS NULL OR (SELECT count(*) FROM auth.users WHERE lower(email) = v_row.email) <> 1
       OR v_auth_id IS DISTINCT FROM v_row.auth_user_id THEN
      RAISE EXCEPTION 'tenant_user_invite:identity_conflict' USING ERRCODE = '42501';
    END IF;
    PERFORM public.tenant_user_invite_assert_v1(v_row.user_type, v_row.role_id,
      v_row.access_scope_type, v_row.access_scope_id, v_auth_id);
    IF v_row.auth_created_by_invite THEN
      IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_auth_id
        AND encode(extensions.digest(COALESCE(encrypted_password, ''), 'sha256'), 'hex') = v_row.password_fingerprint) THEN
        RAISE EXCEPTION 'tenant_user_invite:accepted_credentials_changed' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_auth_id AND organization_id = v_org
      AND lower(email) = v_row.email AND status = 'active') THEN
      RAISE EXCEPTION 'tenant_user_invite:existing_membership_changed' USING ERRCODE = '42501';
    END IF;
    IF v_row.action = 'invite' THEN
      INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
        VALUES(v_auth_id, v_org, v_row.email, v_row.full_name, v_row.user_type, 'active', v_row.access_scope_type, v_row.access_scope_id)
        ON CONFLICT (id) DO NOTHING;
      PERFORM public.tenant_user_invite_assert_v1(v_row.user_type, v_row.role_id,
        v_row.access_scope_type, v_row.access_scope_id, v_auth_id);
      INSERT INTO public.rbac_user_role_assignments(organization_id, user_id, role_id, assigned_by_user_id, metadata)
        VALUES(v_org, v_auth_id, v_row.role_id, auth.uid(), jsonb_build_object('tenant_user_invite_request_id', p_request_id))
        ON CONFLICT (organization_id, user_id, role_id) WHERE revoked_at IS NULL DO NOTHING;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_auth_id AND organization_id = v_org)
         OR NOT EXISTS (SELECT 1 FROM public.rbac_user_role_assignments WHERE user_id = v_auth_id
           AND role_id = v_row.role_id AND organization_id = v_org AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'tenant_user_invite:resend_membership_changed' USING ERRCODE = '42501';
      END IF;
    END IF;
    UPDATE public.tenant_user_invite_requests SET membership_state = 'applied', updated_at = now()
      WHERE id = p_request_id RETURNING * INTO v_row;
  END IF;
  RETURN public.tenant_user_invite_receipt_v1(v_row);
END;
$$;

CREATE FUNCTION public.tenant_user_invite_options_v1() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_org UUID;
BEGIN
  IF COALESCE(auth.role(), '') <> 'authenticated' OR auth.uid() IS NULL
     OR public.current_user_scope_type() <> 'tenant'
     OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'tenant_user_invite:tenant_manager_required' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  PERFORM public.assert_capability_v1('users.manage', 'tenant', v_org);
  RETURN jsonb_build_object(
    'user_types', COALESCE((SELECT jsonb_agg(jsonb_build_object('value', lv.value, 'label', lv.label,
      'scope_type', lv.metadata->>'default_scope_type') ORDER BY lv.sort_order, lv.value)
      FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'user_type' AND lv.status = 'active'
        AND lv.metadata->>'default_scope_type' IN ('tenant', 'client', 'sender')), '[]'::jsonb),
    'roles', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name)
      FROM public.rbac_roles WHERE organization_id = v_org AND is_active
        AND COALESCE(metadata->>'scope_type', '') NOT IN ('platform', 'global')), '[]'::jsonb),
    'clients', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name)
      FROM public.clients WHERE organization_id = v_org), '[]'::jsonb),
    'senders', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
      FROM public.senders s JOIN public.clients c ON c.id = s.client_id WHERE c.organization_id = v_org), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_user_invite_prepare_v1(UUID, JSONB),
  public.tenant_user_invite_dispatch_v1(UUID), public.tenant_user_invite_finalize_v1(UUID),
  public.tenant_user_invite_options_v1() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.tenant_user_invite_provider_result_v1(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenant_user_invite_mailbox_issue_v1(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenant_user_invite_mailbox_claim_v1(UUID, TEXT, TEXT),
  public.tenant_user_invite_mailbox_accept_v1(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_prepare_v1(UUID, JSONB),
  public.tenant_user_invite_dispatch_v1(UUID), public.tenant_user_invite_finalize_v1(UUID),
  public.tenant_user_invite_options_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_provider_result_v1(UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_mailbox_issue_v1(UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_mailbox_claim_v1(UUID, TEXT, TEXT),
  public.tenant_user_invite_mailbox_accept_v1(UUID, TEXT, TEXT) TO authenticated, service_role;

CREATE FUNCTION api.tenant_user_invite_prepare_v1(p_request_id UUID, p_args JSONB) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_prepare_v1(p_request_id, p_args) $$;
CREATE FUNCTION api.tenant_user_invite_dispatch_v1(p_request_id UUID) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_dispatch_v1(p_request_id) $$;
CREATE FUNCTION api.tenant_user_invite_finalize_v1(p_request_id UUID) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_finalize_v1(p_request_id) $$;
CREATE FUNCTION api.tenant_user_invite_options_v1() RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_options_v1() $$;
CREATE FUNCTION api.tenant_user_invite_provider_result_v1(p_request_id UUID, p_state TEXT, p_auth_user_id UUID DEFAULT NULL) RETURNS VOID
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_provider_result_v1(p_request_id, p_state, p_auth_user_id) $$;
CREATE FUNCTION api.tenant_user_invite_mailbox_issue_v1(p_request_id UUID, p_token_hash TEXT, p_created_auth_user_id UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_mailbox_issue_v1(p_request_id, p_token_hash, p_created_auth_user_id) $$;
CREATE FUNCTION api.tenant_user_invite_mailbox_claim_v1(p_request_id UUID, p_token_hash TEXT, p_new_password TEXT) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_mailbox_claim_v1(p_request_id, p_token_hash, p_new_password) $$;
CREATE FUNCTION api.tenant_user_invite_mailbox_accept_v1(p_request_id UUID, p_token_hash TEXT, p_new_password TEXT) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT public.tenant_user_invite_mailbox_accept_v1(p_request_id, p_token_hash, p_new_password) $$;
REVOKE ALL ON FUNCTION api.tenant_user_invite_prepare_v1(UUID, JSONB), api.tenant_user_invite_dispatch_v1(UUID),
  api.tenant_user_invite_finalize_v1(UUID), api.tenant_user_invite_options_v1() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION api.tenant_user_invite_provider_result_v1(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.tenant_user_invite_mailbox_issue_v1(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.tenant_user_invite_mailbox_claim_v1(UUID, TEXT, TEXT),
  api.tenant_user_invite_mailbox_accept_v1(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_prepare_v1(UUID, JSONB), api.tenant_user_invite_dispatch_v1(UUID),
  api.tenant_user_invite_finalize_v1(UUID), api.tenant_user_invite_options_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_provider_result_v1(UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_mailbox_issue_v1(UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_mailbox_claim_v1(UUID, TEXT, TEXT),
  api.tenant_user_invite_mailbox_accept_v1(UUID, TEXT, TEXT) TO authenticated, service_role;
COMMIT;
