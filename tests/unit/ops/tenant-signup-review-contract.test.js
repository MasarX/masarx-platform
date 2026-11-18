const fs = require('fs');
const path = require('path');

describe('tenant-signup-review hosted redirect contract', () => {
  test('edge handler validates invite_redirect_to as hosted URL', () => {
    const file = path.join(
      process.cwd(),
      'supabase',
      'functions',
      'tenant-signup-review',
      'index.ts',
    );
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain('normalizeInviteRedirectUrl');
    expect(body).toContain('invalid_invite_redirect_to');
    expect(body).toContain('invite_redirect_to must be a hosted non-localhost http/https URL');
    expect(body).toContain('WORKSPACE_LOCAL_AUTH_REDIRECT_ORIGINS');
    expect(body).toContain('const allowLocalInviteRedirect =');
    expect(body).toContain('isLocalRequest(req) && localInviteRedirectOrigins.length > 0');
  });

  test('shared tenant signup helper enforces redirect requirement with a narrow Example Person allowance', () => {
    const file = path.join(
      process.cwd(),
      'supabase',
      'functions',
      '_shared',
      'tenant_signup.ts',
    );
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain('normalized === "localhost"');
    expect(body).toContain('normalized.endsWith(".local")');
    expect(body).toContain('normalizeLocalInviteRedirectUrl');
    expect(body).toContain('parsed.pathname !== "/auth/callback"');
    expect(body).toContain('allowed.size === 0 || !allowed.has(parsed.origin)');
    expect(body).toContain('allowLocalInviteRedirect: params.allowLocalInviteRedirect === true');
    expect(body).toContain('throw new Error("invite_redirect_required")');
    expect(body).toContain('Invite redirect must be a hosted non-localhost http/https URL.');
  });
});

