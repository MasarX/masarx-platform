const fs = require('fs');
const path = require('path');

describe('fileless cloud env script guards', () => {
  test('waybill variants worker env does not hardcode .env.cloud fallback', () => {
    const body = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'qa', 'generate-waybill-variants.js'),
      'utf8',
    );

    expect(body).toContain('const workerEnv = process.env.ENV_FILE');
    expect(body).toContain('env: workerEnv');
    expect(body).not.toContain("ENV_FILE: process.env.ENV_FILE || 'config/env/.env.cloud'");
  });
});
