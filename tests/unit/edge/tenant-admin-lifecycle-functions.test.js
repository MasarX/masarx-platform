const fs = require('fs');
const path = require('path');

describe('tenant admin lifecycle edge functions', () => {
  const orgProfilePath = path.join(
    __dirname,
    '../../../supabase/functions/organization-profile/index.ts',
  );
  const userInvitePath = path.join(
    __dirname,
    '../../../supabase/functions/tenant-user-invite/index.ts',
  );
  const consoleRequestPath = path.join(
    __dirname,
    '../../../supabase/functions/tenant-signup-console-request/index.ts',
  );
  const orgProfile = fs.readFileSync(orgProfilePath, 'utf8');
  const userInvite = fs.readFileSync(userInvitePath, 'utf8');
  const consoleRequest = fs.readFileSync(consoleRequestPath, 'utf8');

  test('organization-profile is browser-safe and writes only through canonical RPCs', () => {
    expect(orgProfile).toContain('if (req.method === "OPTIONS")');
    expect(orgProfile).toContain('allowedMethods: ["POST", "OPTIONS"]');
    expect(orgProfile).toContain('"organization_profile_read_v1"');
    expect(orgProfile).toContain('"ui_update_organization_profile_v1"');
    expect(orgProfile).toContain('"register_artifact_v1"');
    expect(orgProfile).toContain('label-render-assets');
    expect(orgProfile).toContain('db: { schema: "api" }');
    expect(orgProfile).not.toContain('.from("artifacts")');
    expect(orgProfile).toContain('invalid_logo_file');
    expect(orgProfile).toContain('invalid_logo_image');
    expect(orgProfile).not.toContain('"image/svg+xml"');
  });

  test('tenant-user-invite is browser-safe and uses service-only apply after user guard', () => {
    expect(userInvite).toContain('if (req.method === "OPTIONS")');
    expect(userInvite).toContain('"access-control-allow-methods": "POST, OPTIONS"');
    expect(userInvite).toContain('"tenant_user_invite_assert_operator_v1"');
    expect(userInvite).toContain('"tenant_user_invite_apply_v1"');
    expect(userInvite).toContain('preflight_only: true');
    expect(userInvite.indexOf('preflight_only: true')).toBeLessThan(userInvite.lastIndexOf('ensureAuthUser(serviceClient'));
    expect(userInvite).toContain('auth.admin.inviteUserByEmail');
    expect(userInvite).toContain('resend_existing_invite');
    expect(userInvite).toContain('sendInviteEmail && resendExistingInvite');
    expect(userInvite).toContain('"tenant_user_invite_resend_assert_v1"');
    expect(userInvite).toContain('invite_redirect_required');
    expect(userInvite).toContain('throw new Error(error?.message || "invite_user_failed")');
    expect(userInvite).toContain('send_invite_email_requested');
  });

  test('tenant-signup-console-request creates reviewed signup requests without bypassing approval', () => {
    expect(consoleRequest).toContain('if (req.method === "OPTIONS")');
    expect(consoleRequest).toContain('"tenant_signup_assert_reviewer_v1"');
    expect(consoleRequest).toContain('"tenant_signup_request_create_v1"');
    expect(consoleRequest).toContain('p_turnstile_verified: true');
    expect(consoleRequest).not.toContain('"tenant_signup_review_apply_v1"');
  });

  test('tenant admin functions support secret and service JWT credentials', () => {
    expect(orgProfile).toContain('const SERVICE_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [');
    expect(orgProfile).toContain('"SUPABASE_SERVICE_ROLE_KEY"');
    expect(orgProfile).toContain('createClient(URL_BASE, SERVICE_KEY');
    for (const source of [userInvite, consoleRequest]) {
      expect(source).toContain('const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [');
      expect(source).toContain('"SUPABASE_SECRET_KEY"');
      expect(source).toContain('const isJwtLike = (value: string): boolean');
      expect(source).toMatch(/const apiKeyHeader = (isJwtLike\(serviceKey\)|serviceKey)/);
      expect(source).toContain('apikey: apiKeyHeader');
    }
  });

  test('uses JWT-first credentials for tenant invites and secret-first credentials for marketplace review', () => {
    expect(userInvite).toContain(
      'const serviceKey = asString(SUPABASE_SERVICE_KEY) || asString(EDGE_SUPABASE_SECRET_KEY);',
    );
    expect(userInvite).toContain(
      '...(isJwtLike(serviceKey) ? { Authorization: `Bearer ${serviceKey}` } : {})',
    );
    expect(userInvite).toContain('const apiKeyHeader = serviceKey;');
    const marketplaceReview = fs.readFileSync(
      path.join(__dirname, '../../../supabase/functions/marketplace-participant-review/index.ts'),
      'utf8',
    );
    expect(marketplaceReview).toContain(
      'const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);',
    );
    expect(marketplaceReview).toContain('const apiKeyHeader = isJwtLike(serviceKey)');
    expect(marketplaceReview).toContain('createClient(SUPABASE_URL, serviceKey');
  });

  test('tenant-signup-review uses the edge secret and dynamic apikey pattern', () => {
    const review = fs.readFileSync(
      path.join(__dirname, '../../../supabase/functions/tenant-signup-review/index.ts'),
      'utf8',
    );
    expect(review).toContain(
      'const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);',
    );
    expect(review).toContain('const anonKey = asString(SUPABASE_ANON_KEY);');
    expect(review).toContain('const apiKeyHeader = isJwtLike(serviceKey)');
    expect(review).toContain('? (anonKey || serviceKey)');
    expect(review).toContain(': serviceKey;');
    expect(review).toContain('apikey: apiKeyHeader');
    expect(review).toContain('createClient(SUPABASE_URL, serviceKey');
  });
});
