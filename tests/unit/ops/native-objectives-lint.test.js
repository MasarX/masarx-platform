jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('native changed-migration objectives lint', () => {
  const originalBaseRef = process.env.GITHUB_BASE_REF;
  const originalEventName = process.env.GITHUB_EVENT_NAME;
  const originalGitHubActions = process.env.GITHUB_ACTIONS;
  const originalGitHubRef = process.env.GITHUB_REF;
  const originalLocalGateBaseSha = process.env.LOCAL_GATE_BASE_SHA;

  afterEach(() => {
    spawnSync.mockReset();
    jest.resetModules();
    if (originalBaseRef === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = originalBaseRef;
    if (originalEventName === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = originalEventName;
    if (originalGitHubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGitHubActions;
    if (originalGitHubRef === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = originalGitHubRef;
    if (originalLocalGateBaseSha === undefined) delete process.env.LOCAL_GATE_BASE_SHA;
    else process.env.LOCAL_GATE_BASE_SHA = originalLocalGateBaseSha;
  });

  test('returns the exact changed-migration cohort from the local-gate base', () => {
    const baseSha = 'c'.repeat(40);
    process.env.LOCAL_GATE_BASE_SHA = baseSha;
    delete process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_REF;
    const migration = 'supabase/migrations/202608071930_webhook_api_edge_contract_v1.sql';
    spawnSync
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: `A\0${migration}\0`, stderr: '' });

    const { changedMigrations } = require('../../../scripts/ops/ci/native-objectives-lint');
    expect(changedMigrations()).toEqual([migration]);
    expect(spawnSync.mock.calls[0][1]).toEqual(['rev-parse', '--verify', baseSha]);
    expect(spawnSync.mock.calls[1][1]).toEqual([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      baseSha,
      'HEAD',
      '--',
      'supabase/migrations',
    ]);
  });

  test('enforces net-new policies without overriding reviewed historical entries', () => {
    const mainSpawnSync = require('child_process').spawnSync;
    const migration = 'supabase/migrations/202609060200_fieldops_reassignment_request_workflow_v1.sql';
    const previousPolicy = process.env.OBJECTIVES_ENFORCE_POLICY_MISSING;
    const previousMode = process.env.OBJECTIVES_LINT_NET_NEW_MODE;
    const previousExitCode = process.exitCode;
    process.env.LOCAL_GATE_BASE_SHA = 'c'.repeat(40);
    delete process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_REF;
    process.env.OBJECTIVES_ENFORCE_POLICY_MISSING = '1';
    process.env.OBJECTIVES_LINT_NET_NEW_MODE = 'warn';
    mainSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: `A\0${migration}\0`, stderr: '' })
      .mockReturnValueOnce({ status: 0 });
    try {
      require('../../../scripts/ops/ci/native-objectives-lint').main();
      expect(mainSpawnSync.mock.calls[2][2].env).toMatchObject({
        OBJECTIVES_ENFORCE_RLS_MISSING: '1',
        OBJECTIVES_ENFORCE_POLICY_MISSING: '0',
        OBJECTIVES_LINT_NET_NEW_MODE: 'error',
        OBJECTIVES_LINT_EXPECTED_FILES_JSON: JSON.stringify([migration]),
      });
      expect(process.exitCode).toBe(0);
    } finally {
      if (previousPolicy === undefined) delete process.env.OBJECTIVES_ENFORCE_POLICY_MISSING;
      else process.env.OBJECTIVES_ENFORCE_POLICY_MISSING = previousPolicy;
      if (previousMode === undefined) delete process.env.OBJECTIVES_LINT_NET_NEW_MODE;
      else process.env.OBJECTIVES_LINT_NET_NEW_MODE = previousMode;
      process.exitCode = previousExitCode;
    }
  });

  test('requires every scan-selected migration to be a regular candidate file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-objectives-'));
    const relative = 'supabase/migrations/202607310001_selected.sql';
    const absolute = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const {
      validateChangedMigrationFiles,
    } = require('../../../scripts/ops/ci/native-objectives-lint');
    const selection = [{
      status: 'M',
      oldPath: '',
      newPath: relative,
      scanPath: relative,
    }];
    try {
      expect(() => validateChangedMigrationFiles(selection, root)).toThrow(/absent/);
      fs.mkdirSync(absolute);
      expect(() => validateChangedMigrationFiles(selection, root)).toThrow(/not a regular file/);
      fs.rmSync(absolute, { recursive: true, force: true });
      fs.writeFileSync(absolute, 'select 1;\n', 'utf8');
      expect(validateChangedMigrationFiles(selection, root)).toEqual([relative]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when a scan-selected migration resolves to a symbolic link', () => {
    const {
      validateChangedMigrationFiles,
    } = require('../../../scripts/ops/ci/native-objectives-lint');
    const lstat = jest.spyOn(fs, 'lstatSync').mockReturnValue({
      isFile: () => true,
      isSymbolicLink: () => true,
    });
    try {
      expect(() => validateChangedMigrationFiles([{
        status: 'A',
        oldPath: '',
        newPath: 'supabase/migrations/202607310001_symlink.sql',
        scanPath: 'supabase/migrations/202607310001_symlink.sql',
      }], process.cwd())).toThrow(/not a regular file/);
    } finally {
      lstat.mockRestore();
    }
  });

  test('fails closed on a deleted migration with no current scan path', () => {
    const {
      validateChangedMigrationFiles,
    } = require('../../../scripts/ops/ci/native-objectives-lint');
    expect(() => validateChangedMigrationFiles([{
      status: 'D',
      oldPath: 'supabase/migrations/202607310001_deleted.sql',
      newPath: '',
      scanPath: '',
    }])).toThrow(/deletion or rename-away is not allowed/);
  });

  test('fails closed when a migration is renamed outside the canonical directory', () => {
    const {
      validateChangedMigrationFiles,
    } = require('../../../scripts/ops/ci/native-objectives-lint');
    expect(() => validateChangedMigrationFiles([{
      status: 'R100',
      oldPath: 'supabase/migrations/202607310001_old.sql',
      newPath: 'scripts/archive/202607310001_old.sql',
      scanPath: '',
    }])).toThrow(/deletion or rename-away is not allowed/);
  });

  test('scans the regular destination of a migration rename within the canonical directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-objectives-rename-'));
    const relative = 'supabase/migrations/202607310001_new.sql';
    const absolute = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'select 1;\n', 'utf8');
    const {
      validateChangedMigrationFiles,
    } = require('../../../scripts/ops/ci/native-objectives-lint');
    try {
      expect(validateChangedMigrationFiles([{
        status: 'R100',
        oldPath: 'supabase/migrations/202607310001_old.sql',
        newPath: relative,
        scanPath: relative,
      }], root)).toEqual([relative]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
