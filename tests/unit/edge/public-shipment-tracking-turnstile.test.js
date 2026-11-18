const fs = require('fs');
const path = require('path');

describe('public shipment tracking Turnstile test contract', () => {
  const functionPath = path.join(
    __dirname,
    '../../../supabase/functions/public-shipment-tracking/index.ts',
  );
  const source = fs.readFileSync(functionPath, 'utf8');

  test('short-circuits only local requests that use the official testing secret', () => {
    const localShortCircuit = 'if (localContext && secret === LOCAL_TRACKING_TURNSTILE_SECRET_KEY)';
    const siteverifyCall = 'fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify"';

    expect(source).toContain('const LOCAL_TRACKING_TURNSTILE_SECRET_KEY = "EXAMPLE_PASSWORD";');
    expect(source).toContain('const LOCAL_TRACKING_TURNSTILE_TEST_TOKEN = "1x00000000000000000000AA";');
    expect(source).toContain(localShortCircuit);
    expect(source).toContain('const success = token === LOCAL_TRACKING_TURNSTILE_TEST_TOKEN;');
    expect(source).not.toContain('|| token.length > 0');
    expect(source).toContain('usedTestingKey: true');
    expect(source.indexOf(localShortCircuit)).toBeGreaterThan(-1);
    expect(source.indexOf(localShortCircuit)).toBeLessThan(source.indexOf(siteverifyCall));
  });

});
