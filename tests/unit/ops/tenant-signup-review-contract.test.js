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

    expect(body).toContain('normalizeHostedRedirectUrl');
    expect(body).toContain('invalid_invite_redirect_to');
    expect(body).toContain('invite_redirect_to must be a hosted non-localhost HTTPS URL');
  });

  test('shared tenant signup helper enforces redirect requirement for invite email flow', () => {
    const file = path.join(
      process.cwd(),
      'supabase',
      'functions',
      '_shared',
      'tenant_signup.ts',
    );
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain('isLoopbackHostname(normalized)');
    expect(body).toContain('normalized.endsWith(".local")');
    expect(body).toContain('throw new Error("invite_redirect_required")');
    expect(body).toContain('Invite redirect must be a hosted non-localhost HTTPS URL.');
  });
});

