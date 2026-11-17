const fs = require('fs');
const path = require('path');

describe('verify-cloud-core deterministic toggle defaults', () => {
  test('forces optional live/extended suites off unless explicitly allowed', () => {
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain('VERIFY_CORE_ALLOW_EXTENDED_SUITES');
    expect(body).toContain("RUN_LIVE_GEOCODING_TESTS: 'false'");
    expect(body).toContain("RUN_LIVE_WEBHOOK_TESTS: 'false'");
    expect(body).toContain("RUN_LABELS_WEBHOOK_TESTS: 'false'");
    expect(body).toContain("RUN_EDGE_E2E: 'false'");
    expect(body).toContain("RUN_RLS_INTEGRATION_TESTS: 'false'");
    expect(body).toContain("RUN_MATRIX_E2E: 'false'");
    expect(body).toContain("RUN_LIVE_COMMS_TESTS: 'false'");
    expect(body).toContain("RUN_LIVE_3PL_TESTS: 'false'");
  });
});
