const {
  splitChecks,
  buildReleaseProofs,
} = require('../../../scripts/ops/ci/mobile-release-proof');

describe('mobile-release-proof', () => {
  test('splitChecks separates screenshot checks from store metadata checks', () => {
    const { screenshotChecks, storeChecks } = splitChecks([
      { name: 'screenshots.native.manifest.freshness', pass: true, required: true },
      { name: 'fieldops.eas_project_id.format', pass: true, required: true },
    ]);

    expect(screenshotChecks).toHaveLength(1);
    expect(storeChecks).toHaveLength(1);
  });

  test('buildReleaseProofs skips release-only proofs outside release profile', () => {
    const proofs = buildReleaseProofs({
      profile: 'ci',
      checks: [
        { name: 'screenshots.native.manifest.freshness', pass: false, required: true },
        { name: 'fieldops.eas_project_id.format', pass: false, required: true },
      ],
    });

    expect(proofs.storeProof).toMatchObject({
      status: 'skipped',
      skipped_reason: 'release-only-proof-not-required',
    });
    expect(proofs.screenshotProof).toMatchObject({
      status: 'skipped',
      skipped_reason: 'release-only-proof-not-required',
    });
  });

  test('buildReleaseProofs fails screenshot freshness separately from store metadata proof', () => {
    const proofs = buildReleaseProofs({
      profile: 'release',
      checks: [
        { name: 'fieldops.eas_project_id.format', pass: true, required: true },
        { name: 'screenshots.native.manifest.freshness', pass: false, required: true },
      ],
    });

    expect(proofs.storeProof).toMatchObject({
      phase: 'store_metadata_proof',
      status: 'passed',
      failure_class: '',
    });
    expect(proofs.screenshotProof).toMatchObject({
      phase: 'screenshot_freshness_proof',
      status: 'failed',
      failure_class: 'screenshots-native-manifest-freshness',
      failed_required_checks_total: 1,
    });
  });
});
