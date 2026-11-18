const fs = require('fs');
const path = require('path');

describe('driver application status edge runtime', () => {
  const statusFunctionPath = path.join(
    __dirname,
    '../../../supabase/functions/driver-application-status/index.ts',
  );
  const signupFunctionPath = path.join(
    __dirname,
    '../../../supabase/functions/driver-signup-intake/index.ts',
  );
  const statusSource = fs.readFileSync(statusFunctionPath, 'utf8');
  const signupSource = fs.readFileSync(signupFunctionPath, 'utf8');

  test('allows native Mobile V2 local status checks when CORS env is absent', () => {
    expect(statusSource).toContain('const LOCAL_DRIVER_STATUS_ORIGINS = new Set([');
    expect(statusSource).toContain('const requestIsLocal = isLocalRequest(req);');
    expect(statusSource).toContain('const localOriginAllowed = requestIsLocal && Boolean(origin && isLocalOrigin(origin));');
    expect(statusSource).toContain('? ALLOWED_ORIGINS');
    expect(statusSource).toContain(': (requestIsLocal ? LOCAL_DRIVER_STATUS_ORIGINS : new Set<string>())');
    expect(statusSource).toContain('if (!effectiveConfigured)');
    expect(statusSource).toContain('if (!effectiveOrigins.has(origin) && !localOriginAllowed)');
  });

  test('keeps signup and status loopback origin coverage dynamic for native proof', () => {
    for (const source of [signupSource, statusSource]) {
      expect(source).toContain('"http://127.0.0.1:3333"');
      expect(source).toContain('"http://localhost:3333"');
      expect(source).toContain('"http://192.0.2.10:3333"');
      expect(source).toContain('"http://rvzwwjlztwwisjthghnipgjr.example.invalid:3333"');
      expect(source).toContain('normalized === "192.0.2.10"');
      expect(source).toContain('const requestIsLocal = isLocalRequest(req);');
      expect(source).toContain('const localOriginAllowed = requestIsLocal && Boolean(origin && isLocalOrigin(origin));');
      expect(source).toContain('if (!effectiveOrigins.has(origin) && !localOriginAllowed)');
      expect(source).not.toContain('"http://192.0.2.10:58429"');
    }
  });
});
