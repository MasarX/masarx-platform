const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  resolvePreviewEasProfile,
} = require('../../../scripts/ops/mobile/preview-build');

describe('mobile preview build profile', () => {
  let appCwd;

  beforeEach(() => {
    appCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-mobile-preview-'));
    fs.writeFileSync(path.join(appCwd, 'eas.json'), JSON.stringify({
      build: {
        development: {},
        stg: {},
        production: {},
      },
    }), 'utf8');
  });

  afterEach(() => {
    fs.rmSync(appCwd, { recursive: true, force: true });
  });

  test('defaults preview orchestration to the current development profile', () => {
    expect(resolvePreviewEasProfile({ appCwd })).toBe('development');
  });

  test('rejects every release-capable or legacy profile', () => {
    expect(() => resolvePreviewEasProfile({ appCwd, requestedProfile: 'stg' })).toThrow(
      /permits only the 'development' EAS profile/,
    );
    expect(() => resolvePreviewEasProfile({ appCwd, requestedProfile: 'production' })).toThrow(
      /permits only the 'development' EAS profile/,
    );
    expect(() => resolvePreviewEasProfile({ appCwd, requestedProfile: 'preview' })).toThrow(
      /permits only the 'development' EAS profile/,
    );
  });

  test('CLI rejects a release-capable profile even when EXPO_TOKEN is absent', () => {
    const envFile = path.join(appCwd, 'empty.env');
    fs.writeFileSync(envFile, '', 'utf8');
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'mobile', 'preview-build.js')],
      {
        cwd: path.join(__dirname, '..', '..', '..'),
        env: {
          ...process.env,
          ENV_FILE: envFile,
          EXPO_TOKEN: '',
          PREVIEW_MOBILE_EAS_PROFILE: 'production',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("permits only the 'development' EAS profile");
  });
});
