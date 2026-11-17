const fs = jest.requireActual('fs');
const path = jest.requireActual('path');
const root = path.resolve(__dirname, '../..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const sql = read('supabase/migrations/202610201230_tenant_user_invite_v1.sql');
const route = read('apps/console/app/api/tenant-user-invite/route.ts');

test('keeps the privileged credential allow-list bound to the shared server-only invite provider', () => {
  const config = JSON.parse(read('config/lint/frontend-lint.json'));
  const provider = read('apps/shared/tenant-user-invite-provider.ts');
  const match = config.allow.serviceRole.find((rule) => new RegExp(rule).test('apps/shared/tenant-user-invite-provider.ts'));
  expect(match).toBe('^apps/shared/tenant-user-invite-provider\\.ts$');
  expect(provider).toContain('import "server-only"');
  expect(route).toContain('import "server-only"');
  expect(new RegExp(match).test('apps/console/app/resources/users/invite-form.tsx')).toBe(false);
  expect(new RegExp(match).test('apps/console/app/auth/invite-confirm/route.ts')).toBe(false);
  expect(route).toContain('email_confirm: true');
  expect(route).toContain('randomBytes(32).toString("hex")');
  expect(route).not.toMatch(/inviteUserByEmail|listUsers|deleteUser|updateUserById/);
});

test('keeps authenticated finalization and provider reporting as distinct grants', () => {
  expect(sql).toContain("COALESCE(auth.role(), '') <> 'authenticated'");
  expect(sql).toContain("PERFORM public.assert_capability_v1('users.manage', 'tenant', v_actor.organization_id)");
  expect(sql).toContain("public.user_has_capability_v1(v_cap, p_scope_type, v_scope_id), FALSE");
  expect(sql).toContain("public.user_has_permission_v1(v_permission.value, v_actor.organization_id), FALSE");
  expect(sql).toContain('assigned_by_user_id');
  expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
  expect(sql).toContain("provider_state = 'unknown', dispatched_at = now()");
  expect(sql).toContain('CREATE TRIGGER audit_row_change');
  expect(sql).not.toMatch(/DELETE FROM (?:auth\.users|public\.users)|UPDATE auth\.users/);
});

test('requires this invitation mailbox proof rather than an existing email confirmation flag', () => {
  const prepare = sql.slice(sql.indexOf('CREATE FUNCTION public.tenant_user_invite_prepare_v1'),
    sql.indexOf('CREATE FUNCTION public.tenant_user_invite_dispatch_v1'));
  const finalize = sql.slice(sql.indexOf('CREATE FUNCTION public.tenant_user_invite_finalize_v1'),
    sql.indexOf('CREATE FUNCTION public.tenant_user_invite_options_v1'));
  expect(prepare).not.toMatch(/email_confirmed_at|not_required/);
  expect(sql).not.toContain("'not_required'");
  expect(finalize).toContain('v_row.mailbox_accepted_at IS NOT NULL');
  expect(finalize).not.toContain("'user_id', v_row.auth_user_id");
  expect(sql).toContain('p_created_auth_user_id');
  expect(route).toContain('p_created_auth_user_id');
  expect(route).toContain('randomBytes(32).toString("hex")');
  expect(route).toContain('p_token_hash: createHash("sha256").update(token).digest("hex")');
  expect(route).toContain('acceptance.searchParams.set("request_id", requestId)');
  expect(route).toContain('acceptance.hash = `token=${token}`');
  expect(route).not.toContain('acceptance.searchParams.set("token"');
  expect(route).toContain('resetPasswordForEmail(email, { redirectTo: acceptance.toString() })');
  expect(route).not.toMatch(/data:\s*\{[^}]*token|p_token:\s*token/);
});

test('mailbox issuance is private and token consumption binds new-account creation or the recipient session', () => {
  for (const name of ['issue', 'claim', 'accept']) {
    const start = sql.indexOf(`CREATE FUNCTION public.tenant_user_invite_mailbox_${name}_v1`);
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf('\n$$;', start));
    expect(body).toContain('FOR UPDATE');
  }
  const issue = sql.slice(sql.indexOf('CREATE FUNCTION public.tenant_user_invite_mailbox_issue_v1'),
    sql.indexOf('CREATE FUNCTION public.tenant_user_invite_mailbox_claim_v1'));
  expect(issue).toContain("auth.role() IS DISTINCT FROM 'service_role'");
  for (const mode of ['new_account', 'active_member', 'support_only']) expect(sql).toContain(`'${mode}'`);
  expect(sql).toContain("p_token_hash !~ '^[0-9a-f]{64}$'");
  expect(sql).toContain("mailbox_expires_at = clock_timestamp() + interval '1 hour'");
  expect(sql).toContain('p_token_hash IS DISTINCT FROM v_row.mailbox_token_hash');
  expect(sql).toContain('v_row.mailbox_expires_at <= clock_timestamp()');
  expect(sql).toContain('v_row.mailbox_claimed_at IS NOT NULL OR v_row.mailbox_accepted_at IS NOT NULL');
  expect(sql).toContain("auth.jwt()->>'session_id'");
  expect(sql).toContain('auth.sessions');
  expect(sql).toContain('auth.uid()');
});

test('does not write managed Auth internals or add global authorization quarantine', () => {
  expect(sql).not.toMatch(/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE)\s+auth\./i);
  expect(sql).not.toMatch(/ALTER ROLE authenticator|AS RESTRICTIVE|tenant_user_invite_pre_request_v1|tenant_user_invite_session_valid_v1/);
  const confirm = read('apps/console/app/auth/invite-confirm/route.ts');
  expect(confirm).not.toContain('.signOut(');
  expect(confirm).not.toContain('"global"');
});

test('password verification and native policy JSON retain their literal SQL semantics', () => {
  const pattern = sql.match(/COALESCE\(v_auth\.encrypted_password, ''\) !~ '([^']+)'/)?.[1];
  expect(pattern).toBeDefined();
  expect(new RegExp(pattern).test('$2a$10$' + 'a'.repeat(53))).toBe(true);
  const fixture = read('supabase/tests/pgtap/0zz_tenant_user_invite_v1.sql');
  // The audit mask is plain text, not a policy JSON value.
  const arrays = [...fixture.matchAll(/'(\[[^\r\n']*\])'/g)].filter(([, value]) => value !== '[REDACTED]');
  expect(arrays.length).toBeGreaterThan(0);
  for (const [, value] of arrays) expect(() => JSON.parse(value)).not.toThrow();
});

test('registers canonical lookup, timestamp, audit and full FK-prefix index contracts for the new receipt table', () => {
  const table = sql.slice(sql.indexOf('CREATE TABLE public.tenant_user_invite_requests'), sql.indexOf('CREATE INDEX'));
  expect(table).not.toMatch(/CHECK\s*\([^;]*\bIN\s*\(/i);
  expect(table).toContain("CHECK ((access_scope_type = 'tenant') = (access_scope_id IS NULL))");
  for (const [column, category, subset] of [
    ['action', 'tenant_user_invite_action', "ARRAY['invite', 'resend']::TEXT[]"],
    ['access_scope_type', 'scope_type', "ARRAY['tenant', 'client', 'sender']::TEXT[]"],
    ['provider_state', 'tenant_user_invite_provider_state', "ARRAY['ready', 'accepted', 'failed', 'unknown']::TEXT[]"],
    ['membership_state', 'tenant_user_invite_membership_state', "ARRAY['pending', 'applied']::TEXT[]"],
  ]) {
    expect(sql).toContain(`'tenant_user_invite_requests', '${column}', '${category}', FALSE`);
    expect(sql).toContain(subset);
  }
  expect(sql).not.toContain('public.apply_lookup_column_contracts(');
  expect(sql).toContain("'trg_lookup_contract_' || substr(md5('public.tenant_user_invite_requests'), 1, 12)");
  expect(sql).toContain('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF access_scope_type, action, membership_state, provider_state ON public.tenant_user_invite_requests');
  expect(sql).toContain('FOR EACH ROW EXECUTE FUNCTION public.enforce_lookup_column_contracts()');
  for (const column of ['organization_id', 'actor_user_id', 'role_id']) {
    expect(sql).toContain(`CREATE INDEX tenant_user_invite_requests_${column}_idx ON public.tenant_user_invite_requests(${column});`);
  }
  expect(sql).toMatch(/CREATE TRIGGER trg_tenant_user_invite_requests_set_updated_at\s+BEFORE UPDATE ON public\.tenant_user_invite_requests\s+FOR EACH ROW EXECUTE FUNCTION public\.set_updated_at\(\)/);
  expect(sql).toMatch(/CREATE TRIGGER audit_truncate_change AFTER TRUNCATE\s+ON public\.tenant_user_invite_requests FOR EACH STATEMENT EXECUTE FUNCTION public\.audit_capture_row_change\(\)/);
});

test('declares a service-only RLS policy in the new PR table migration without granting direct access or changing facade authority', () => {
  const policy = sql.match(/CREATE POLICY tenant_user_invite_requests_service_policy[^;]+;/)?.[0] || '';
  expect(sql).toMatch(/ALTER TABLE public\.tenant_user_invite_requests ENABLE ROW LEVEL SECURITY/);
  expect(policy).toMatch(/CREATE POLICY tenant_user_invite_requests_service_policy\s+ON public\.tenant_user_invite_requests\s+FOR ALL\s+TO service_role\s+USING \(TRUE\)\s+WITH CHECK \(TRUE\)/);
  expect(policy).not.toMatch(/\b(?:GRANT|REVOKE|DROP)\b|CREATE (?:OR REPLACE )?FUNCTION|DISABLE ROW LEVEL SECURITY/);
  expect(sql).toContain('REVOKE ALL ON public.tenant_user_invite_requests FROM PUBLIC, anon, authenticated, service_role;');
  const fixture = read('supabase/tests/pgtap/0zz_tenant_user_invite_v1.sql');
  expect(fixture).toContain("aclexplode(NULLIF(a.attacl, '{}'::aclitem[]))");
  for (const evidence of ['receipt retains RLS', 'sole policy is service-role-only', 'no direct table ACL',
    'anon cannot read', 'authenticated cannot read', 'service role cannot bypass the facade ACL']) {
    expect(fixture).toContain(evidence);
  }
});

test('native fixture covers real roles, explicit deny, cross-tenant, replay and partial readback', () => {
  const fixture = read('supabase/tests/pgtap/0zz_tenant_user_invite_v1.sql');
  for (const evidence of ['SET LOCAL ROLE authenticated', 'SET LOCAL ROLE service_role',
    'provider_outcome_pending', 'permission_escalation', 'capability_escalation',
    'scope_outside_tenant', 'incompatible_user_scope',
    'authority failure remains pending', 'effective deny']) {
    expect(fixture).toContain(evidence);
  }
  expect(fixture).toMatch(/SET user_type\s*=\s*'ops_admin',\s*status\s*=\s*'suspended'/);
  expect(fixture).toContain('suspended inviter cannot finalize');
});

test('native regressions cover orphan denial, creation attestation and same-tenant recipient proof', () => {
  const fixture = read('supabase/tests/pgtap/0zz_tenant_user_invite_v1.sql');
  expect(fixture).not.toContain('verified pre-registered identity reconciles the same request without resend');
  expect(fixture).not.toContain('confirmed nonanonymous identity reuse does not dispatch email');
  for (const mode of ['new_account', 'active_member', 'support_only']) expect(fixture).toContain(mode);
  expect(fixture).toMatch(/orphan/i);
  expect(fixture).toContain('createUser attestation');
});

test('English and Arabic invite messages have identical keys and preserve uncertainty wording', () => {
  const en = JSON.parse(read('packages/config/messages/en.json')).ui.tenantUsers;
  const ar = JSON.parse(read('packages/config/messages/ar.json')).ui.tenantUsers;
  expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort());
  expect(en.appliedUnknown).toContain('unknown');
  expect(en.checkOutcome).toContain('does not resend');
  expect(en.sent).toContain('not confirmed');
});

test('local recovery template carries the invite-bound RedirectTo only on canonical Console roots and preserves ordinary recovery', () => {
  const config = read('supabase/config.toml');
  const template = read('supabase/templates/recovery.html');
  expect(config).toMatch(/^\[auth\.email\.template\.recovery\]$/m);
  expect(config).toContain('content_path = "./supabase/templates/recovery.html"');
  expect(config).not.toContain('https://127.0.0.1:3000/auth/invite-confirm');
  for (const host of ['unjijvxjrwurjgsnokovrvom.example.invalid', 'vkhyghkwqoksmtxwrkgqyyxk.example.invalid', 'vtgspxqkvhurpwtxnnyvhjzw.example.invalid']) {
    expect(template).toContain(`https://${host}/auth/invite-confirm?request_id=`);
    expect(template).toContain(`https://${host}/auth/invite-confirm?support=1`);
  }
  const supportBranch = template.slice(0, template.indexOf('{{ else if'));
  expect(supportBranch).toContain('Contact your administrator or support');
  expect(supportBranch).not.toContain('.ConfirmationURL');
  const prefixes = [...template.matchAll(/printf "%\.([0-9]+)s" \.RedirectTo\) "([^"]+)"/g)];
  expect(prefixes).toHaveLength(3);
  for (const [, length, prefix] of prefixes) expect(Number(length)).toBe(prefix.length);
  expect(template).toContain('<a href="{{ .RedirectTo }}">');
  expect(template).toContain('<a href="{{ .ConfirmationURL }}">');
  expect(template).not.toMatch(/\.Data\.|\.SiteURL|\.TokenHash|token_hash=/);
  expect(route).toContain('normalizeAppBasePath(process.env.NEXT_PUBLIC_APP_BASE_PATH)');
  expect(route).toContain('}/auth/invite-confirm`, url.origin)');
  const confirm = read('apps/console/app/auth/invite-confirm/route.ts');
  const get = confirm.slice(confirm.indexOf('export async function GET'), confirm.indexOf('export async function POST'));
  expect(get).not.toMatch(/createServerClient|verifyOtp|provider\.rpc|createTenantUserInviteProviderClient/);
  expect(get).toContain('<form method="post"');
  expect(confirm).toContain('request.headers.get("origin") !== target.origin');
  expect(confirm).toContain('tenant_user_invite_mailbox_claim_v1');
  expect(confirm).toContain('tenant_user_invite_mailbox_accept_v1');
  expect(confirm).not.toContain('verifyOtp');
  expect(confirm).not.toMatch(/console\.(?:log|info|warn|error)|searchParams\.get\("next"\)/);
});
