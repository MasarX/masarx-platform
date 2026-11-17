const {
  buildSupabaseCliAsset,
  isLegacyVersion,
  normalizeArch,
  normalizePlatform,
  parseVersionTriplet,
} = require('../../../scripts/ops/ci/supabase-cli-asset');

describe('scripts/ops/ci/supabase-cli-asset', () => {
  test('builds the modern standalone release URL for linux amd64', () => {
    expect(
      buildSupabaseCliAsset({
        version: '2.67.3',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toEqual({
      version: '2.67.3',
      platform: 'linux',
      arch: 'amd64',
      asset_name: 'supabase_linux_amd64.tar.gz',
      binary_name: 'supabase',
      download_url: 'https://github.com/supabase/cli/releases/download/v2.67.3/supabase_linux_amd64.tar.gz',
    });
  });

  test('builds the legacy release URL for pre-1.28 versions', () => {
    expect(
      buildSupabaseCliAsset({
        version: '1.27.4',
        platform: 'linux',
        arch: 'amd64',
      }),
    ).toEqual({
      version: '1.27.4',
      platform: 'linux',
      arch: 'amd64',
      asset_name: 'supabase_linux_amd64.tar.gz',
      binary_name: 'supabase',
      download_url: 'https://github.com/supabase/cli/releases/download/v1.27.4/supabase_1.27.4_linux_amd64.tar.gz',
    });
  });

  test('builds the latest download URL without a pinned tag', () => {
    expect(
      buildSupabaseCliAsset({
        version: 'latest',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toEqual({
      version: 'latest',
      platform: 'linux',
      arch: 'amd64',
      asset_name: 'supabase_linux_amd64.tar.gz',
      binary_name: 'supabase',
      download_url: 'https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz',
    });
  });

  test('maps windows runner identifiers and emits the exe binary name', () => {
    expect(
      buildSupabaseCliAsset({
        version: '2.67.3',
        platform: 'Windows',
        arch: 'X64',
      }),
    ).toEqual({
      version: '2.67.3',
      platform: 'windows',
      arch: 'amd64',
      asset_name: 'supabase_windows_amd64.tar.gz',
      binary_name: 'supabase.exe',
      download_url: 'https://github.com/supabase/cli/releases/download/v2.67.3/supabase_windows_amd64.tar.gz',
    });
  });

  test('normalizes platform and arch aliases', () => {
    expect(normalizePlatform('macOS')).toBe('darwin');
    expect(normalizeArch('aarch64')).toBe('arm64');
  });

  test('parses semver-like triplets and detects the legacy cutoff', () => {
    expect(parseVersionTriplet('1.28.0')).toEqual({ major: 1, minor: 28, patch: 0 });
    expect(isLegacyVersion('1.27.9')).toBe(true);
    expect(isLegacyVersion('1.28.0')).toBe(false);
  });

  test('fails closed on unsupported platform values', () => {
    expect(() =>
      buildSupabaseCliAsset({
        version: '2.67.3',
        platform: 'freebsd',
        arch: 'x64',
      }),
    ).toThrow('[supabase-cli-asset] Unsupported platform "freebsd".');
  });
});
