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

  test('requires configured browser origin authority before native status lookup', () => {
    expect(statusSource).toContain('hostedAllowedOrigins: DRIVER_SIGNUP_CORS_ALLOW_ORIGINS');
    expect(statusSource).toContain('if (!cors.ok) return json(cors.status, cors.body, cors.headers);');
    expect(statusSource.indexOf('if (!cors.ok)')).toBeLessThan(statusSource.indexOf('await serviceClient.rpc'));
  });

  test('both browser entrypoints gate local origins on explicit local QA configuration', () => {
    for (const [source, methods] of [[signupSource, 'POST, OPTIONS'], [statusSource, 'GET, POST, OPTIONS']]) {
      expect(source).toContain('resolveBrowserCorsPolicy(req, {');
      expect(source).toContain('localAllowedOrigins: readEnv("PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS")');
      expect(source).toContain('localQaEnabled: readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1"');
      expect(source).toContain(`allowedMethods: "${methods}"`);
    }
  });
});
