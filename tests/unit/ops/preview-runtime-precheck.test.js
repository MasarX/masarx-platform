const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildProbeEnv,
  buildPreviewRuntimeReadinessReport,
  finalizePreviewRuntimeReadinessReport,
  main,
  shouldProbeAuth,
  shouldProbeDb,
} = require('../../../scripts/ops/preview/runtime-precheck');

describe('preview-runtime-precheck', () => {
  test('buildPreviewRuntimeReadinessReport returns ready contract metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-ready-'));
    const envFile = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgresql://preview.example/postgres\n', 'utf8');

    const report = buildPreviewRuntimeReadinessReport({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: envFile,
            db_ready: true,
            jwt_ready: true,
            rest_ready: true,
            runtime_ready: true,
            runtime_ready_at: '2026-03-18T00:00:00.000Z',
          },
        },
      },
    });

    expect(report).toEqual({
      ready: true,
      failure_class: '',
      env_file: envFile,
      runtime_ready_at: '2026-03-18T00:00:00.000Z',
      db_ready: '1',
      jwt_ready: '1',
      rest_ready: '1',
      db_probe_candidate: '',
      db_probe_duration_ms: 0,
      db_probe_attempts: 0,
      db_probe_error: '',
      auth_ready: '0',
      auth_probe_status: 0,
      auth_probe_error: '',
    });
  });

  test('main writes summary output and fails closed when preview runtime is unready', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-unready-'));
    const manifestPath = path.join(tempDir, 'manifest.json');
    const envFile = path.join(tempDir, 'preview.env');
    const reportPath = path.join(tempDir, 'runtime.json');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgresql://preview.example/postgres\n', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      surfaces: {
        db: {
          status: 'prewarmed',
          env_file: envFile,
          db_ready: true,
          jwt_ready: false,
          rest_ready: false,
          runtime_ready: false,
          readiness_failure_class: 'preview-jwt-unready',
        },
      },
    }, null, 2), 'utf8');

    await expect(main([
      '--manifest',
      manifestPath,
      '--report',
      reportPath,
    ])).rejects.toThrow(/Preview runtime readiness failed \(preview-jwt-unready\)/);

    const summary = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(summary).toMatchObject({
      ready: false,
      failure_class: 'preview-jwt-unready',
      env_file: envFile,
      db_ready: true,
      jwt_ready: false,
      rest_ready: false,
    });
  });

  test('buildProbeEnv loads the manifest env file as the active probe source', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-probe-env-'));
    const envFile = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgresql://preview.example/postgres\nSUPABASE_PROJECT_ID=46b364a4-da77-4f71-9e7b-f34b567e3dbe\n', 'utf8');

    const probeEnv = buildProbeEnv({
      envFile,
      env: {
        DATABASE_URL: 'postgresql://stale.example/postgres',
        ENV_FILE_OVERRIDE: '0',
      },
    });

    expect(probeEnv).toMatchObject({
      DATABASE_URL: 'postgresql://preview.example/postgres',
      SUPABASE_PROJECT_ID: '46b364a4-da77-4f71-9e7b-f34b567e3dbe',
      ENV_FILE: envFile,
      ENV_FILE_OVERRIDE: '1',
      PREVIEW_MODE: '1',
      CI_PREVIEW: '1',
      VERIFY_PREVIEW: '1',
    });
  });

  test('finalizePreviewRuntimeReadinessReport fails closed when the live DB probe fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-db-probe-'));
    const envFile = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgresql://preview.example/postgres\n', 'utf8');

    const report = {
      ready: true,
      failure_class: '',
      env_file: envFile,
      runtime_ready_at: '2026-03-18T00:00:00.000Z',
      db_ready: '1',
      jwt_ready: '1',
      rest_ready: '1',
    };

    await expect(finalizePreviewRuntimeReadinessReport({
      report,
      probeDb: true,
      options: {
        env: {},
        resolveDsnCandidatesImpl: jest.fn().mockResolvedValue([
          { name: 'DATABASE_URL', dsn: 'postgresql://preview.example/postgres' },
        ]),
        runConnectivitySmokeImpl: jest.fn().mockRejectedValue(
          new Error('(ENOTFOUND) tenant/user postgres.46b364a4-da77-4f71-9e7b-f34b567e3dbe not found'),
        ),
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      },
    })).resolves.toMatchObject({
      ready: false,
      failure_class: 'preview-db-unready',
      db_ready: '0',
      db_probe_error: '(ENOTFOUND) tenant/user postgres.46b364a4-da77-4f71-9e7b-f34b567e3dbe not found',
    });
  });

  test('main can require a live DB probe before reporting preview runtime ready', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-db-ready-'));
    const manifestPath = path.join(tempDir, 'manifest.json');
    const envFile = path.join(tempDir, 'preview.env');
    const reportPath = path.join(tempDir, 'runtime.json');
    const resolveDsnCandidatesImpl = jest.fn().mockResolvedValue([
      { name: 'DATABASE_URL', dsn: 'postgresql://preview.example/postgres' },
    ]);
    const runConnectivitySmokeImpl = jest.fn().mockResolvedValue({
      attempts: 2,
      durationMs: 3456,
      candidate: { name: 'DATABASE_URL' },
    });

    fs.writeFileSync(envFile, 'DATABASE_URL=postgresql://preview.example/postgres\n', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      surfaces: {
        db: {
          status: 'prewarmed',
          env_file: envFile,
          db_ready: true,
          jwt_ready: true,
          rest_ready: true,
          runtime_ready: true,
          runtime_ready_at: '2026-03-18T00:00:00.000Z',
        },
      },
    }, null, 2), 'utf8');

    await expect(main([
      '--manifest',
      manifestPath,
      '--report',
      reportPath,
      '--probe-db',
    ], {
      env: {},
      resolveDsnCandidatesImpl,
      runConnectivitySmokeImpl,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    })).resolves.toMatchObject({
      ready: true,
      db_probe_candidate: 'DATABASE_URL',
      db_probe_attempts: 2,
      db_probe_duration_ms: 3456,
    });

    expect(shouldProbeDb({ 'probe-db': '1' }, {})).toBe(true);
    const summary = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(summary).toMatchObject({
      ready: true,
      db_ready: true,
      db_probe_candidate: 'DATABASE_URL',
      db_probe_attempts: 2,
      db_probe_duration_ms: 3456,
    });
  });

  test('finalizePreviewRuntimeReadinessReport fails closed when the auth API key probe fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-auth-probe-'));
    const envFile = path.join(tempDir, 'preview.env');
    fs.writeFileSync(
      envFile,
      [
        'SUPABASE_URL=https://46b364a4-da77-4f71-9e7b-f34b567e3dbe.supabase.co',
        'SUPABASE_ANON_KEY=stale-preview-anon-key',
        'DATABASE_URL=postgresql://preview.example/postgres',
        '',
      ].join('\n'),
      'utf8',
    );

    const report = {
      ready: true,
      failure_class: '',
      env_file: envFile,
      runtime_ready_at: '2026-03-18T00:00:00.000Z',
      db_ready: '1',
      jwt_ready: '1',
      rest_ready: '1',
    };

    await expect(finalizePreviewRuntimeReadinessReport({
      report,
      probeAuth: true,
      options: {
        env: {},
        fetchImpl: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => '{"message":"Invalid API key"}',
        }),
      },
    })).resolves.toMatchObject({
      ready: false,
      failure_class: 'preview-auth-unready',
      rest_ready: '0',
      auth_ready: '0',
      auth_probe_status: 401,
      auth_probe_error: 'Preview auth API key probe failed ({"message":"Invalid API key"}).',
    });
  });

  test('main can require live DB and auth probes before reporting preview runtime ready', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-full-ready-'));
    const manifestPath = path.join(tempDir, 'manifest.json');
    const envFile = path.join(tempDir, 'preview.env');
    const reportPath = path.join(tempDir, 'runtime.json');
    const resolveDsnCandidatesImpl = jest.fn().mockResolvedValue([
      { name: 'DATABASE_URL', dsn: 'postgresql://preview.example/postgres' },
    ]);
    const runConnectivitySmokeImpl = jest.fn().mockResolvedValue({
      attempts: 1,
      durationMs: 123,
      candidate: { name: 'DATABASE_URL' },
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    });

    fs.writeFileSync(
      envFile,
      [
        'DATABASE_URL=postgresql://preview.example/postgres',
        'SUPABASE_URL=https://46b364a4-da77-4f71-9e7b-f34b567e3dbe.supabase.co',
        'SUPABASE_ANON_KEY=live-preview-anon-key',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(manifestPath, JSON.stringify({
      surfaces: {
        db: {
          status: 'prewarmed',
          env_file: envFile,
          db_ready: true,
          jwt_ready: true,
          rest_ready: true,
          runtime_ready: true,
          runtime_ready_at: '2026-03-18T00:00:00.000Z',
        },
      },
    }, null, 2), 'utf8');

    await expect(main([
      '--manifest',
      manifestPath,
      '--report',
      reportPath,
      '--probe-db',
      '--probe-auth',
    ], {
      env: {},
      resolveDsnCandidatesImpl,
      runConnectivitySmokeImpl,
      fetchImpl,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    })).resolves.toMatchObject({
      ready: true,
      auth_ready: '1',
      auth_probe_status: 200,
      db_probe_candidate: 'DATABASE_URL',
    });

    expect(shouldProbeAuth({ 'probe-auth': '1' }, {})).toBe(true);
    const summary = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(summary).toMatchObject({
      ready: true,
      auth_ready: true,
      auth_probe_status: 200,
    });
  });
});
