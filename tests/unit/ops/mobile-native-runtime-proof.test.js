const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildNativeRuntimeProof,
  verifyNativeRuntimeProof,
} = require('../../../scripts/ops/ci/mobile-native-runtime-proof');

const SHA = 'a'.repeat(40);
const AVD = 'MasarX_FieldOps_API34_release';

function writeFixture(root, overrides = {}) {
  const screenshot = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('proof'),
  ]);
  fs.writeFileSync(path.join(root, 'C-android-driver-tasks.png'), screenshot);
  const manifest = {
    captured_at: '2026-07-29T12:00:00.000Z',
    capture_mode: 'native_runtime',
    platforms: ['android'],
    devices: { android: { serial: 'emulator-5554' }, ios: null },
    selftests: [{ platform: 'android', status: 'pass', steps: ['OK'] }],
    scenarios: [{
      name: 'C-android-driver-tasks',
      file: 'C-android-driver-tasks.png',
      platform: 'android',
      capture_source: 'adb',
    }],
    ...overrides,
  };
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'fieldops-app.png'), screenshot);
  const appRuntimePath = path.join(root, 'app-runtime.json');
  fs.writeFileSync(appRuntimePath, `${JSON.stringify({
    status: 'passed',
    package_name: 'com.masarx.fieldops.runtimeproof',
    android_serial: 'emulator-5554',
    pid: 4321,
    resumed_activity: 'com.masarx.fieldops.runtimeproof/.MainActivity',
    ui_ready_marker: 'Sign in to continue',
    configuration_error_absent: true,
    apk_sha256: 'b'.repeat(64),
    screenshot: 'fieldops-app.png',
  }, null, 2)}\n`);
  return { manifestPath, appRuntimePath };
}

describe('mobile-native-runtime-proof', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-mobile-native-proof-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('builds and verifies exact same-run Android candidate evidence', () => {
    const { manifestPath, appRuntimePath } = writeFixture(root);
    const proof = buildNativeRuntimeProof({
      manifestPath,
      appRuntimePath,
      candidateSha: SHA,
      avdName: AVD,
      serial: 'emulator-5554',
      workflowRunId: '123',
      workflowRunAttempt: '2',
      now: new Date('2026-07-29T12:01:00.000Z'),
    });
    const proofPath = path.join(root, 'proof.json');
    fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);

    expect(proof).toMatchObject({
      status: 'passed',
      candidate_sha: SHA,
      avd_name: AVD,
      android_serial: 'emulator-5554',
      workflow_run_id: 123,
      workflow_run_attempt: 2,
      scenario_count: 1,
    });
    expect(proof.manifest_sha256).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),
    );
    expect(verifyNativeRuntimeProof({
      proofPath,
      manifestPath,
      appRuntimePath,
      expectedCandidateSha: SHA,
      expectedAvdName: AVD,
      expectedWorkflowRunId: '123',
      expectedWorkflowRunAttempt: '2',
    })).toEqual(proof);
  });

  test('rejects non-Android or non-passing runtime manifests', () => {
    const { manifestPath, appRuntimePath } = writeFixture(root, {
      platforms: ['android', 'ios'],
      selftests: [{ platform: 'android', status: 'fail' }],
    });
    expect(() => buildNativeRuntimeProof({
      manifestPath,
      appRuntimePath,
      candidateSha: SHA,
      avdName: AVD,
      serial: 'emulator-5554',
      workflowRunId: '123',
      workflowRunAttempt: '1',
    })).toThrow(/exactly the Android platform/);
  });

  test('verifies unchanged artifacts after download into a different workspace directory', () => {
    const producer = path.join(root, 'producer');
    const consumer = path.join(root, 'downloaded');
    fs.mkdirSync(producer);
    const files = writeFixture(producer);
    const proof = buildNativeRuntimeProof({ ...files, candidateSha: SHA, avdName: AVD,
      serial: 'emulator-5554', workflowRunId: '123', workflowRunAttempt: '2' });
    fs.writeFileSync(path.join(producer, 'proof.json'), JSON.stringify(proof));
    fs.cpSync(producer, consumer, { recursive: true });
    expect(proof.app_runtime).not.toHaveProperty('resolved');
    expect(verifyNativeRuntimeProof({
      proofPath: path.join(consumer, 'proof.json'), manifestPath: path.join(consumer, 'manifest.json'),
      appRuntimePath: path.join(consumer, 'app-runtime.json'), expectedCandidateSha: SHA,
      expectedAvdName: AVD, expectedWorkflowRunId: '123', expectedWorkflowRunAttempt: '2',
    })).toEqual(proof);
  });

  test.each(['123junk', '1e3', '1.5', '0', '-1', '9007199254740992'])(
    'rejects noncanonical workflow identity %s', value => {
      const files = writeFixture(root);
      for (const field of ['workflowRunId', 'workflowRunAttempt']) {
        expect(() => buildNativeRuntimeProof({ ...files, candidateSha: SHA, avdName: AVD,
          serial: 'emulator-5554', workflowRunId: '123', workflowRunAttempt: '2', [field]: value }))
          .toThrow(/positive integer/);
      }
    },
  );

  test('fails closed when the proof, manifest, workflow, or screenshot set drifts', () => {
    const { manifestPath, appRuntimePath } = writeFixture(root);
    const proof = buildNativeRuntimeProof({
      manifestPath,
      appRuntimePath,
      candidateSha: SHA,
      avdName: AVD,
      serial: 'emulator-5554',
      workflowRunId: '123',
      workflowRunAttempt: '1',
    });
    const proofPath = path.join(root, 'proof.json');
    fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    fs.appendFileSync(path.join(root, 'C-android-driver-tasks.png'), 'tampered');

    expect(() => verifyNativeRuntimeProof({
      proofPath,
      manifestPath,
      appRuntimePath,
      expectedCandidateSha: SHA,
      expectedAvdName: AVD,
      expectedWorkflowRunId: '123',
      expectedWorkflowRunAttempt: '1',
    })).toThrow(/screenshot digest set mismatch/);
    expect(() => verifyNativeRuntimeProof({
      proofPath,
      manifestPath,
      appRuntimePath,
      expectedCandidateSha: SHA,
      expectedAvdName: AVD,
      expectedWorkflowRunId: '999',
      expectedWorkflowRunAttempt: '1',
    })).toThrow(/workflow identity mismatch/);
  });

  test('rejects unsafe AVD names and manifest file traversal', () => {
    const { manifestPath: safeManifestPath, appRuntimePath } = writeFixture(root);
    expect(() => buildNativeRuntimeProof({
      manifestPath: safeManifestPath,
      appRuntimePath,
      candidateSha: SHA,
      avdName: 'Pixel_6',
      serial: 'emulator-5554',
      workflowRunId: '123',
      workflowRunAttempt: '1',
    })).toThrow(/canonical MasarX FieldOps API 34 namespace/);

    const { manifestPath } = writeFixture(root, {
      scenarios: [{
        name: 'C-android-driver-tasks',
        file: '../outside.png',
        platform: 'android',
        capture_source: 'adb',
      }],
    });
    expect(() => buildNativeRuntimeProof({
      manifestPath,
      appRuntimePath,
      candidateSha: SHA,
      avdName: AVD,
      serial: 'emulator-5554',
      workflowRunId: '123',
      workflowRunAttempt: '1',
    })).toThrow(/unsafe screenshot file name/);
  });
});
