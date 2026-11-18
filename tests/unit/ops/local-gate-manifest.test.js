const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EMPTY_STATUS_SHA256,
  sha256,
  loadLocalGateManifestPolicy,
  addLocalGateManifestContract,
  digestManifest,
  validateLocalGateManifest,
  validateLocalGateAttestationState,
  resolveSafeLocalGateManifestPath,
  writeLocalGateManifestAtomic,
  readLocalGateManifestFile,
  evaluateLocalGatePolicyTransition,
  resolveAcceptedCandidatePolicy,
  loadCandidatePolicyFromGithub,
  evaluateBootstrapPolicy,
} = require('../../../scripts/ops/ci/local-gate-manifest');

const HEAD_SHA = 'a'.repeat(40);
const POLICY_SHA256 = sha256(loadLocalGateManifestPolicy());
const BASE_SHA = 'b'.repeat(40);
const CHANGED_FILES = ['apps/console/page.tsx'];
const SELECTION = {
  impactedSurfaceIds: ['console'],
  selectedSuites: ['lint_structure', 'test_unit'],
};
const COMMANDS = [
  {
    command_id: 'lint_structure',
    suite_ids: ['lint_structure'],
    surface_ids: [],
    command: 'npm',
    args: ['run', 'lint:structure'],
    env: {},
  },
  {
    command_id: 'test_unit',
    suite_ids: ['test_unit'],
    surface_ids: ['console'],
    command: 'npm',
    args: ['run', 'test:unit'],
    env: {},
  },
];

function manifest(overrides = {}) {
  const value = addLocalGateManifestContract({
    sha: HEAD_SHA,
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
    generated_at: '2026-07-16T10:00:00.000Z',
    manifest_path: `.tmp/local-gate/${HEAD_SHA}.json`,
    changed_files: CHANGED_FILES,
    surface_ids: SELECTION.impactedSurfaceIds,
    suite_ids: SELECTION.selectedSuites,
    impact_surfaces: ['console'],
    planned_commands: COMMANDS,
    commands: COMMANDS.map((entry) => ({ ...entry, status: 'passed', duration_ms: 10 })),
    local_mode: 'impact',
    strict_mode: false,
    risk_reasons: [],
    status: 'passed',
    duration_ms: 20,
    ...overrides,
  });
  value.manifest_sha256 = digestManifest(value);
  return value;
}

function validate(value, overrides = {}) {
  return validateLocalGateManifest(value, {
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    changedFiles: CHANGED_FILES,
    expectedSelection: SELECTION,
    expectedCommands: COMMANDS,
    requiredMode: 'impact',
    currentStatus: '',
    nowMs: Date.parse('2026-07-16T11:00:00.000Z'),
    ...overrides,
  });
}

describe('local-gate-manifest', () => {
  test('accepts an exact, fresh, clean, fully passed proof', () => {
    const value = manifest();
    expect(value.repository_status_sha256).toBe(EMPTY_STATUS_SHA256);
    expect(validate(value)).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });

  test('accepts only the exact managed functions-runtime recovery contract', () => {
    const localStart = {
      command_id: 'local_start',
      suite_ids: ['test_unit'],
      surface_ids: ['console'],
      command: 'npm',
      args: ['run', 'local:start'],
      env: {
        WORKSPACE_LOCAL_START_FRESH: '1',
        WORKSPACE_LOCAL_START_RUN_MIGRATE_LOCAL: '1',
      },
    };
    const localVerify = {
      command_id: 'local_verify',
      suite_ids: ['test_unit'],
      surface_ids: ['console'],
      command: 'npm',
      args: ['run', 'local:verify'],
      env: {
        LOCAL_VERIFY_SKIP_DB_RESET: '1',
      },
    };
    const localStopRecovery = {
      command_id: 'local_stop_recovery',
      suite_ids: ['test_unit'],
      surface_ids: ['console'],
      command: 'npm',
      args: ['run', 'local:stop'],
      env: {},
    };
    const localStartRecovery = {
      command_id: 'local_start_recovery',
      suite_ids: ['test_unit'],
      surface_ids: ['console'],
      command: 'npm',
      args: ['run', 'local:start'],
      env: {
        WORKSPACE_LOCAL_START_FRESH: '1',
        WORKSPACE_LOCAL_START_RUN_MIGRATE_LOCAL: '1',
      },
    };
    const plannedCommands = [localStart, localVerify];
    const commandResults = [
      localStart,
      localStopRecovery,
      localStartRecovery,
      localVerify,
    ].map((entry) => ({ ...entry, status: 'passed', duration_ms: 10 }));
    const recovered = manifest({
      planned_commands: plannedCommands,
      commands: commandResults,
      duration_ms: 40,
    });
    expect(validate(recovered, { expectedCommands: plannedCommands })).toEqual(
      expect.objectContaining({ ok: true, errors: [] }),
    );

    const skippedManagedRuntime = manifest({
      planned_commands: plannedCommands,
      commands: commandResults.map((entry) => (
        entry.command_id === 'local_start_recovery'
          ? {
              ...entry,
              env: { ...entry.env, WORKSPACE_LOCAL_START_SKIP_FUNCTIONS_RUNTIME: '1' },
            }
          : entry
      )),
      duration_ms: 40,
    });
    expect(validate(skippedManagedRuntime, { expectedCommands: plannedCommands }).errors)
      .toContain('local_start_recovery_invalid');
  });

  test.each([
    ['head', { headSha: 'c'.repeat(40) }, 'head_sha_mismatch'],
    ['base', { baseSha: 'd'.repeat(40) }, 'base_sha_mismatch'],
    ['changed files', { changedFiles: ['apps/portal/page.tsx'] }, 'changed_files_mismatch'],
    ['surfaces', { expectedSelection: { ...SELECTION, impactedSurfaceIds: ['portal'] } }, 'surface_ids_mismatch'],
    ['suites', { expectedSelection: { ...SELECTION, selectedSuites: ['test_unit'] } }, 'suite_ids_mismatch'],
    ['commands', { expectedCommands: [COMMANDS[0]] }, 'command_plan_mismatch'],
    ['dirty state', { currentStatus: ' M tracked.js' }, 'current_repository_not_clean'],
  ])('rejects exact contract mismatch: %s', (_name, overrides, expectedError) => {
    expect(validate(manifest(), overrides).errors).toContain(expectedError);
  });

  test('rejects expired, failed, and tampered proofs', () => {
    const expired = manifest({ generated_at: '2026-07-15T00:00:00.000Z' });
    expired.manifest_sha256 = digestManifest(expired);
    expect(validate(expired).errors).toContain('manifest_expired');

    const failed = manifest();
    failed.commands[0].status = 'failed';
    failed.manifest_sha256 = digestManifest(failed);
    expect(validate(failed).errors).toContain('command_status_not_passed');

    const tampered = manifest();
    tampered.suite_ids.push('test_ui');
    expect(validate(tampered).errors).toEqual(expect.arrayContaining([
      'suite_ids_digest_mismatch',
      'suite_ids_mismatch',
      'manifest_digest_mismatch',
    ]));
  });

  test('rejects missing and legacy manifest contracts', () => {
    expect(validateLocalGateManifest(null).errors).toEqual(['manifest_not_object']);
    const legacy = manifest();
    legacy.schema_version = 'local-gate-manifest.legacy';
    legacy.manifest_sha256 = digestManifest(legacy);
    expect(validate(legacy).errors).toContain('schema_version_mismatch');
  });

  test('strict proof satisfies impact while impact proof cannot satisfy strict', () => {
    const strict = manifest({ local_mode: 'strict', strict_mode: true });
    strict.manifest_sha256 = digestManifest(strict);
    expect(validate(strict).ok).toBe(true);
    expect(validate(manifest(), { requiredMode: 'strict' }).errors).toContain('strict_mode_required');
  });

  test('manual strict proof safely satisfies an auto-impact command and suite subset', () => {
    const strictCommands = [
      ...COMMANDS,
      {
        command_id: 'test_ui',
        suite_ids: ['test_ui'],
        surface_ids: ['console'],
        command: 'npm',
        args: ['run', 'test:ui'],
        env: {},
      },
    ];
    const strict = manifest({
      local_mode: 'strict',
      strict_mode: true,
      suite_ids: [...SELECTION.selectedSuites, 'test_ui'],
      planned_commands: strictCommands,
      commands: strictCommands.map((entry) => ({ ...entry, status: 'passed', duration_ms: 10 })),
      duration_ms: 30,
    });
    expect(validate(strict, {
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    })).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });

  test('portable strict command identity remains exact across repository roots', () => {
    const portableCommand = {
      command_id: 'test_unit',
      suite_ids: ['test_unit'],
      surface_ids: ['console'],
      command: 'node',
      args: [
        'scripts/ops/ci/nx-task-runner.js',
        '--mode',
        'run-many',
        '--targets',
        'test:unit',
      ],
      env: {},
    };
    const strict = manifest({
      local_mode: 'strict',
      strict_mode: true,
      suite_ids: ['test_unit'],
      planned_commands: [portableCommand],
      commands: [{ ...portableCommand, status: 'passed', duration_ms: 10 }],
      duration_ms: 10,
    });
    expect(validate(strict, {
      expectedSelection: { ...SELECTION, selectedSuites: ['test_unit'] },
      expectedCommands: [portableCommand],
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    })).toEqual(expect.objectContaining({ ok: true, errors: [] }));

    const changedPath = {
      ...portableCommand,
      args: ['C:/repo/scripts/ops/ci/nx-task-runner.js', ...portableCommand.args.slice(1)],
    };
    expect(validate(strict, {
      expectedSelection: { ...SELECTION, selectedSuites: ['test_unit'] },
      expectedCommands: [changedPath],
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    }).errors).toContain('command_plan_mismatch');

    const changedEnv = { ...portableCommand, env: { CI: '1' } };
    expect(validate(strict, {
      expectedSelection: { ...SELECTION, selectedSuites: ['test_unit'] },
      expectedCommands: [changedEnv],
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    }).errors).toContain('command_plan_mismatch');
  });

  test('strict superset reuse rejects missing expected coverage and changed surface or risk contracts', () => {
    const missingCommand = manifest({
      local_mode: 'strict',
      strict_mode: true,
      suite_ids: SELECTION.selectedSuites,
      planned_commands: [COMMANDS[0]],
      commands: [{ ...COMMANDS[0], status: 'passed', duration_ms: 10 }],
      duration_ms: 10,
    });
    expect(validate(missingCommand, {
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    }).errors).toContain('command_plan_mismatch');

    const changedSurface = manifest({
      local_mode: 'strict',
      strict_mode: true,
      surface_ids: ['portal'],
    });
    expect(validate(changedSurface, {
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    }).errors).toContain('surface_ids_mismatch');

    const changedRisk = manifest({
      local_mode: 'strict',
      strict_mode: true,
      risk_reasons: ['control_plane'],
    });
    expect(validate(changedRisk, {
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    }).errors).toContain('risk_reasons_mismatch');
  });

  test('auto-strict and impact-only validation retain exact suite and command semantics', () => {
    const extraCommand = {
      command_id: 'test_ui',
      suite_ids: ['test_ui'],
      surface_ids: ['console'],
      command: 'npm',
      args: ['run', 'test:ui'],
      env: {},
    };
    const strict = manifest({
      local_mode: 'strict',
      strict_mode: true,
      risk_reasons: ['control_plane'],
      suite_ids: [...SELECTION.selectedSuites, 'test_ui'],
      planned_commands: [...COMMANDS, extraCommand],
      commands: [...COMMANDS, extraCommand].map((entry) => ({ ...entry, status: 'passed', duration_ms: 10 })),
      duration_ms: 30,
    });
    expect(validate(strict, {
      expectedGatePolicy: { mode: 'strict', strictMode: true, riskReasons: ['control_plane'] },
    }).errors).toEqual(expect.arrayContaining(['suite_ids_mismatch', 'command_plan_mismatch']));

    const impact = manifest({
      suite_ids: [...SELECTION.selectedSuites, 'test_ui'],
      planned_commands: [...COMMANDS, extraCommand],
      commands: [...COMMANDS, extraCommand].map((entry) => ({ ...entry, status: 'passed', duration_ms: 10 })),
      duration_ms: 30,
    });
    expect(validate(impact, {
      expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
    }).errors).toEqual(expect.arrayContaining(['suite_ids_mismatch', 'command_plan_mismatch']));
  });

  test('queue attestation validation requires every digest and enforces freshness', () => {
    const value = manifest();
    const state = {
      manifest_contract_version: value.schema_version,
      policy_sha256: POLICY_SHA256,
      manifest_sha256: value.manifest_sha256,
      changed_files_sha256: value.changed_files_sha256,
      surface_ids_sha256: value.surface_ids_sha256,
      suite_ids_sha256: value.suite_ids_sha256,
      command_plan_sha256: value.command_plan_sha256,
      command_results_sha256: value.command_results_sha256,
      repository_clean: true,
      generated_at: value.generated_at,
    };
    expect(validateLocalGateAttestationState(state, {
      nowMs: Date.parse('2026-07-16T11:00:00.000Z'),
    }).ok).toBe(true);
    expect(validateLocalGateAttestationState({ ...state, command_plan_sha256: '' }, {
      nowMs: Date.parse('2026-07-16T11:00:00.000Z'),
    }).errors).toContain('command_plan_digest_invalid');
    expect(validateLocalGateAttestationState(state, {
      nowMs: Date.parse('2026-07-17T11:00:00.000Z'),
    }).errors).toContain('proof_expired');
  });

  test('manifest path resolution rejects repository escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-gate-safe-root-'));
    try {
      expect(() => resolveSafeLocalGateManifestPath({
        cwd: root,
        manifestDir: '..',
        headSha: HEAD_SHA,
        createDirectory: true,
      })).toThrow('local_gate_manifest_dir_outside_repository');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('manifest path resolution rejects symlink or junction components and targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-gate-reparse-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-gate-reparse-outside-'));
    try {
      const linkedDir = path.join(root, 'linked');
      fs.symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => resolveSafeLocalGateManifestPath({
        cwd: root,
        manifestDir: 'linked/proofs',
        headSha: HEAD_SHA,
        createDirectory: true,
      })).toThrow('local_gate_manifest_reparse_forbidden');

      const safe = resolveSafeLocalGateManifestPath({
        cwd: root,
        manifestDir: 'proofs',
        headSha: HEAD_SHA,
        createDirectory: true,
      });
      fs.symlinkSync(outside, safe.manifestPath, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => resolveSafeLocalGateManifestPath({
        cwd: root,
        manifestDir: 'proofs',
        headSha: HEAD_SHA,
      })).toThrow('local_gate_manifest_reparse_forbidden');
      expect(() => readLocalGateManifestFile(safe.manifestPath)).toThrow('local_gate_manifest_reparse_forbidden');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('manifest writes use exclusive temporary files and atomically publish regular JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-gate-atomic-root-'));
    try {
      const safe = resolveSafeLocalGateManifestPath({
        cwd: root,
        manifestDir: 'proofs',
        headSha: HEAD_SHA,
        createDirectory: true,
      });
      writeLocalGateManifestAtomic(safe.manifestPath, { version: 1 });
      writeLocalGateManifestAtomic(safe.manifestPath, { version: 2 });
      expect(writeLocalGateManifestAtomic.toString()).not.toContain('unlinkSync(targetPath)');
      expect(JSON.parse(readLocalGateManifestFile(safe.manifestPath))).toEqual({ version: 2 });
      expect(fs.lstatSync(safe.manifestPath).isFile()).toBe(true);
      expect(fs.readdirSync(safe.manifestDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('candidate policy transition accepts equal and bounded tightening with exact hashes', () => {
    const base = loadLocalGateManifestPolicy();
    const equal = evaluateLocalGatePolicyTransition(base, structuredClone(base));
    const tighterPolicy = {
      ...structuredClone(base),
      max_age_minutes: 240,
      strict_satisfies_impact: false,
    };
    const tighter = evaluateLocalGatePolicyTransition(base, tighterPolicy);
    expect(equal).toEqual(expect.objectContaining({ ok: true, policy_sha256: sha256(base) }));
    expect(tighter).toEqual(expect.objectContaining({ ok: true, policy_sha256: sha256(tighterPolicy) }));
  });

  test('candidate policy loader binds GitHub contents lookup to the exact head SHA', async () => {
    const policy = loadLocalGateManifestPolicy();
    const getContent = jest.fn().mockResolvedValue({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(policy)).toString('base64'),
      },
    });
    await expect(loadCandidatePolicyFromGithub({
      github: { rest: { repos: { getContent } } },
      owner: 'MasarX',
      repo: 'MasarX',
      headSha: HEAD_SHA,
    })).resolves.toEqual(policy);
    expect(getContent).toHaveBeenCalledWith({
      owner: 'MasarX',
      repo: 'MasarX',
      path: 'config/ci/local-gate-manifest-policy.json',
      ref: HEAD_SHA,
    });
  });

  test('candidate policy transition rejects weakening', () => {
    const base = loadLocalGateManifestPolicy();
    const weakened = evaluateLocalGatePolicyTransition(base, {
      ...structuredClone(base),
      max_age_minutes: base.max_age_minutes + 1,
    });
    expect(weakened.ok).toBe(false);
    expect(weakened.errors).toContain('max_age_weakened');
  });

  test('candidate policy resolution fails closed for missing and malformed content', async () => {
    const missing = await resolveAcceptedCandidatePolicy({
      headSha: HEAD_SHA,
      loadCandidatePolicyImpl: async () => { throw new Error('404 Not Found'); },
    });
    const malformed = await resolveAcceptedCandidatePolicy({
      headSha: HEAD_SHA,
      loadCandidatePolicyImpl: async () => { throw new Error('candidate_policy_json_invalid'); },
    });
    expect(missing).toEqual(expect.objectContaining({ ok: false, reason: 'candidate_policy_missing' }));
    expect(malformed).toEqual(expect.objectContaining({ ok: false, reason: 'candidate_policy_malformed' }));
  });

  test('candidate policy transition rejects deadlocking freshness bounds', async () => {
    const deadlock = await resolveAcceptedCandidatePolicy({
      headSha: HEAD_SHA,
      basePolicy: loadLocalGateManifestPolicy(),
      loadCandidatePolicyImpl: async () => ({
        ...structuredClone(loadLocalGateManifestPolicy()),
        max_age_minutes: 1,
      }),
    });
    expect(deadlock).toEqual(expect.objectContaining({ ok: false, reason: 'candidate_policy_deadlock' }));
  });

  test('bootstrap policy requires exact external head and policy-hash anchors', () => {
    const policy = loadLocalGateManifestPolicy();
    const exact = evaluateBootstrapPolicy({
      candidateHeadSha: HEAD_SHA,
      candidatePolicy: policy,
      expectedHeadSha: HEAD_SHA,
      expectedPolicySha256: sha256(policy),
    });
    const missing = evaluateBootstrapPolicy({ candidateHeadSha: HEAD_SHA, candidatePolicy: policy });
    const mismatch = evaluateBootstrapPolicy({
      candidateHeadSha: HEAD_SHA,
      candidatePolicy: policy,
      expectedHeadSha: 'c'.repeat(40),
      expectedPolicySha256: 'd'.repeat(64),
    });
    expect(exact.ok).toBe(true);
    expect(missing.ok).toBe(false);
    expect(missing.errors).toEqual(expect.arrayContaining([
      'bootstrap_expected_head_sha_missing',
      'bootstrap_expected_policy_sha256_missing',
    ]));
    expect(mismatch.errors).toEqual(expect.arrayContaining([
      'bootstrap_expected_head_sha_mismatch',
      'bootstrap_expected_policy_sha256_mismatch',
    ]));
  });

  test('risk reasons must be a normalized unique string array even when canonical risk is empty', () => {
    for (const malformed of ['not-an-array', { reason: 'x' }, [1], ['', '']]) {
      const value = manifest({ risk_reasons: malformed });
      value.risk_reasons = malformed;
      value.manifest_sha256 = digestManifest(value);
      expect(validate(value, {
        expectedGatePolicy: { mode: 'impact', strictMode: false, riskReasons: [] },
      }).errors).toContain('risk_reasons_invalid');
    }
  });
});
