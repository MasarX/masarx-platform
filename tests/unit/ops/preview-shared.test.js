const { fixtureHost } = require('../../fixtures/builders/hosts');

const consoleHost = fixtureHost('console', 'vercel.app');
const portalHost = fixtureHost('portal', 'vercel.app');
const surfaceConsoleHost = fixtureHost('console-surface', 'vercel.app');
const rootConsoleHost = fixtureHost('console-root', 'vercel.app');

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createBaseManifest,
  ensureManifestShape,
  evaluateManifestFreshness,
  evaluateManifestRequiredSurfaceCoverage,
  evaluateManifestReuseHealth,
  evaluateManifestRuntimeReadiness,
  normalizeSurfaceUrlValue,
  parseLastJsonFromText,
  parseRequiredSurfaceIds,
  resolveSurfaceUrl,
  resolveTopologyIdentity,
  runNodeScript,
} = require('../../../scripts/ops/preview/shared');

describe('preview/shared', () => {
  test('parses the final nested JSON object after provider log output', () => {
    const payload = {
      ok: true,
      deployment_id: 'dpl_console123',
      preview_identity: { topology: 'pr', id: '3270', surface: 'console' },
    };
    expect(parseLastJsonFromText(`provider log\n${JSON.stringify(payload, null, 2)}\n`)).toEqual(payload);
    expect(parseLastJsonFromText('provider log without JSON')).toBeNull();
  });

  test('resolveTopologyIdentity builds deterministic topology keys', () => {
    const identity = resolveTopologyIdentity({
      args: {
        topology: 'worktree',
        id: 'worker-7',
        sha: 'abcdef1234567890',
        'worker-id': 'worker-7',
        'worktree-slug': 'portal-revamp',
      },
      cwd: '/tmp/portal-revamp',
      env: {},
    });
    expect(identity.topology).toBe('worktree');
    expect(identity.topologyKey).toBe('worktree:worker-7:portal-revamp:abcdef1234567890');
    expect(identity.topologyHash).toHaveLength(12);
  });

  test('evaluateManifestFreshness rejects stale and mismatched manifests', () => {
    const identity = {
      topology: 'pr',
      id: '101',
      sha: 'abcdef1234567',
    };
    const stale = evaluateManifestFreshness({
      identity,
      ttlHours: 1,
      manifest: {
        topology: 'pr',
        id: '101',
        sha: 'abcdef1234567',
        generated_at: new Date(Date.now() - (3 * 60 * 60 * 1000)).toISOString(),
      },
    });
    expect(stale.reusable).toBe(false);
    expect(stale.reason).toBe('manifest_stale');

    const mismatch = evaluateManifestFreshness({
      identity,
      ttlHours: 6,
      manifest: {
        topology: 'pr',
        id: '101',
        sha: 'deadbeef12345',
        generated_at: new Date().toISOString(),
      },
    });
    expect(mismatch.reusable).toBe(false);
    expect(mismatch.reason).toBe('sha_mismatch');
  });

  test('evaluateManifestFreshness accepts source_sha/head_sha provenance fields', () => {
    const identity = {
      topology: 'pr',
      id: '101',
      sha: 'abcdef1234567',
    };
    const res = evaluateManifestFreshness({
      identity,
      ttlHours: 6,
      manifest: {
        topology: 'pr',
        id: '101',
        sha: 'deadbeef12345',
        source_sha: 'abcdef1234567',
        head_sha: 'abcdef1234567',
        generated_at: new Date().toISOString(),
      },
    });
    expect(res.reusable).toBe(true);
    expect(res.reason).toBe('ok');
  });

  test('evaluateManifestFreshness accepts any matching manifest SHA provenance field', () => {
    const identity = {
      topology: 'pr',
      id: '101',
      sha: 'abcdef1234567',
    };
    const res = evaluateManifestFreshness({
      identity,
      ttlHours: 6,
      manifest: {
        topology: 'pr',
        id: '101',
        sha: 'deadbeef12345',
        source_sha: 'deadbeef12345',
        head_sha: 'abcdef1234567',
        merge_sha: '1111111111111',
        generated_at: new Date().toISOString(),
      },
    });
    expect(res.reusable).toBe(true);
    expect(res.reason).toBe('ok');
  });

  test('evaluateManifestReuseHealth requires a valid env file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shared-test-'));
    const envPath = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envPath, 'SUPABASE_URL=https://example.supabase.co\n', 'utf8');

    const ok = evaluateManifestReuseHealth({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: envPath,
          },
        },
      },
    });
    expect(ok.reusable).toBe(true);

    const missing = evaluateManifestReuseHealth({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: path.join(tempDir, 'missing.env'),
          },
        },
      },
    });
    expect(missing.reusable).toBe(false);
    expect(missing.reason).toBe('env_file_missing_on_disk');
  });

  test('evaluateManifestRequiredSurfaceCoverage fails closed when a required preview surface is missing', () => {
    const coverage = evaluateManifestRequiredSurfaceCoverage({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
          },
          console: {
            status: 'deployed',
          },
        },
      },
      requiredSurfaceIds: new Set(['db', 'console', 'portal']),
    });
    expect(coverage.reusable).toBe(false);
    expect(coverage.reason).toBe('required_surface_missing:portal');
  });

  test('evaluateManifestReuseHealth requires required non-db preview surfaces to be deployed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shared-surfaces-'));
    const envPath = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envPath, 'SUPABASE_URL=https://example.supabase.co\n', 'utf8');

    const blocked = evaluateManifestReuseHealth({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: envPath,
            db_ready: true,
            jwt_ready: true,
            rest_ready: true,
            runtime_ready: true,
          },
          console: {
            status: 'skipped',
            reason: 'not_required_for_run',
          },
        },
      },
      requiredSurfaceIds: new Set(['db', 'console']),
    });
    expect(blocked.reusable).toBe(false);
    expect(blocked.reason).toBe('required_surface_not_ready:console');
  });

  test('evaluateManifestRuntimeReadiness classifies JWT/runtime readiness failures', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shared-runtime-'));
    const envPath = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envPath, 'SUPABASE_URL=https://example.supabase.co\n', 'utf8');

    const jwtFailure = evaluateManifestRuntimeReadiness({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: envPath,
            db_ready: true,
            jwt_ready: false,
            runtime_ready: false,
          },
        },
      },
    });
    expect(jwtFailure.ready).toBe(false);
    expect(jwtFailure.failure_class).toBe('preview-jwt-unready');

    const restFailure = evaluateManifestRuntimeReadiness({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: envPath,
            db_ready: true,
            jwt_ready: true,
            rest_ready: false,
            runtime_ready: false,
            readiness_failure_class: 'preview-runtime-unready',
          },
        },
      },
    });
    expect(restFailure.ready).toBe(false);
    expect(restFailure.failure_class).toBe('preview-runtime-unready');

    const runtimeFailure = evaluateManifestRuntimeReadiness({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: envPath,
            db_ready: true,
            jwt_ready: true,
            runtime_ready: false,
            readiness_failure_class: 'preview-runtime-unready',
          },
        },
      },
    });
    expect(runtimeFailure.ready).toBe(false);
    expect(runtimeFailure.failure_class).toBe('preview-runtime-unready');

    const ok = evaluateManifestRuntimeReadiness({
      manifest: {
        surfaces: {
          db: {
            status: 'prewarmed',
            env_file: envPath,
            db_ready: true,
            jwt_ready: true,
            runtime_ready: true,
            runtime_ready_at: new Date().toISOString(),
          },
        },
      },
    });
    expect(ok.ready).toBe(true);
    expect(ok.failure_class).toBe('');
  });

  test('manifest reuse and runtime readiness reject failed DB push state', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shared-db-push-failed-'));
    const envPath = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envPath, 'SUPABASE_URL=https://example.supabase.co\n', 'utf8');
    const manifest = {
      surfaces: {
        db: {
          status: 'prewarmed',
          env_file: envPath,
          db_push: 'failed',
          db_push_failure_class: 'preview-db-drift',
          db_ready: true,
          jwt_ready: true,
          runtime_ready: true,
        },
      },
    };

    expect(evaluateManifestReuseHealth({ manifest })).toEqual({
      reusable: false,
      reason: 'db_push_failed',
    });
    expect(evaluateManifestRuntimeReadiness({ manifest })).toEqual({
      ready: false,
      failure_class: 'preview-db-drift',
      reason: 'db_push_failed',
    });
  });

  test('ensureManifestShape backfills legacy manifests without runtime containers', () => {
    const identity = {
      topology: 'pr',
      id: '101',
      sha: 'abcdef1234567',
      topologyKey: 'pr:101:abcdef1234567',
      topologyHash: '1234567890ab',
      workerId: '101',
      worktreeSlug: 'afe5',
    };

    const normalized = ensureManifestShape({
      manifest: {
        ...createBaseManifest({ identity, mode: 'deploy' }),
        surfaces: null,
        warnings: null,
        checks: null,
        teardown: null,
      },
      identity,
      mode: 'deploy',
    });

    expect(normalized.surfaces).toEqual({});
    expect(normalized.warnings).toEqual([]);
    expect(normalized.checks).toEqual({});
    expect(normalized.teardown).toEqual({});
  });

  test('ensureManifestShape rewrites stale artifact identity to the current run', () => {
    const identity = {
      topology: 'pr',
      id: '101',
      sha: 'abcdef1234567',
      topologyKey: 'pr:101:abcdef1234567',
      topologyHash: '1234567890ab',
      workerId: '101',
      worktreeSlug: 'afe5',
    };

    const normalized = ensureManifestShape({
      manifest: {
        generated_at: '2026-03-19T10:00:00.000Z',
        ready: true,
        manifest_path: '/tmp/preview-manifests/pr-101-deadbeef.json',
        topology: 'worktree',
        id: 'stale',
        sha: 'deadbeef1234567',
        source_sha: 'deadbeef1234567',
        head_sha: 'deadbeef1234567',
        topology_key: 'worktree:stale',
        topology_hash: 'deadbeefdead',
        merge_sha: 123,
        prewarm: null,
        surfaces: null,
        checks: null,
        warnings: null,
        teardown: null,
      },
      identity,
      mode: 'deploy',
    });

    expect(normalized.topology).toBe('pr');
    expect(normalized.id).toBe('101');
    expect(normalized.sha).toBe('abcdef1234567');
    expect(normalized.source_sha).toBe('abcdef1234567');
    expect(normalized.head_sha).toBe('abcdef1234567');
    expect(normalized.topology_key).toBe('pr:101:abcdef1234567');
    expect(normalized.topology_hash).toBe('1234567890ab');
    expect(normalized.worker_id).toBe('101');
    expect(normalized.worktree_slug).toBe('afe5');
    expect(normalized.merge_sha).toBe('123');
    expect(normalized.prewarm).toEqual({});
  });

  test('runNodeScript enforces optional timeout', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shared-timeout-'));
    const scriptPath = path.join(tempDir, 'sleep.js');
    fs.writeFileSync(
      scriptPath,
      "setTimeout(() => { process.stdout.write('done\\n'); }, 5000);",
      'utf8',
    );

    await expect(runNodeScript({
      scriptPath,
      timeoutMs: 50,
      label: 'sleep-script',
      heartbeatIntervalMs: 0,
    })).rejects.toThrow(/timed out/i);
  });

  test('runNodeScript preserves child output on non-zero exit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shared-output-error-'));
    const scriptPath = path.join(tempDir, 'fail.js');
    fs.writeFileSync(
      scriptPath,
      [
        "process.stdout.write('stdout evidence\\n');",
        "process.stderr.write('stderr evidence\\n');",
        'process.exit(7);',
      ].join('\n'),
      'utf8',
    );

    await expect(runNodeScript({
      scriptPath,
      timeoutMs: 5000,
      label: 'fail-script',
      heartbeatIntervalMs: 0,
    })).rejects.toMatchObject({
      status: 7,
      stdout: expect.stringContaining('stdout evidence'),
      stderr: expect.stringContaining('stderr evidence'),
      output: expect.stringContaining('stderr evidence'),
    });
  });

  test('runNodeScript emits keepalive output while child script is quiet', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shared-heartbeat-'));
    const scriptPath = path.join(tempDir, 'quiet.js');
    fs.writeFileSync(
      scriptPath,
      [
        "setTimeout(() => {",
        "  process.stdout.write('done\\\\n');",
        "}, 80);",
      ].join('\n'),
      'utf8',
    );

    const originalWrite = process.stdout.write;
    const writes = [];
    process.stdout.write = ((chunk, encoding, callback) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''));
      if (typeof callback === 'function') callback();
      return true;
    });

    try {
      const result = await runNodeScript({
        scriptPath,
        label: 'quiet-script',
        heartbeatIntervalMs: 20,
      });
      expect(result.stdout).toContain('done');
      expect(writes.join('')).toContain('[preview-child] quiet-script still running');
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('parseRequiredSurfaceIds returns null for wildcard selectors', () => {
    const compiledRegistry = {
      surfaces: [{ surface_id: 'db' }, { surface_id: 'landing' }],
    };
    expect(parseRequiredSurfaceIds({ raw: '', compiledRegistry })).toBeNull();
    expect(parseRequiredSurfaceIds({ raw: 'all', compiledRegistry })).toBeNull();
    expect(parseRequiredSurfaceIds({ raw: '*', compiledRegistry })).toBeNull();
  });

  test('parseRequiredSurfaceIds validates and normalizes requested surfaces', () => {
    const compiledRegistry = {
      surfaces: [{ surface_id: 'db' }, { surface_id: 'landing' }, { surface_id: 'portal' }],
    };
    const required = parseRequiredSurfaceIds({
      raw: ' DB, landing ',
      compiledRegistry,
    });
    expect(required).toEqual(new Set(['db', 'landing']));

    expect(() => parseRequiredSurfaceIds({
      raw: 'db,unknown_surface',
      compiledRegistry,
    })).toThrow(/Unknown required preview surface/i);
  });

  test('normalizeSurfaceUrlValue normalizes bare preview hosts', () => {
    expect(normalizeSurfaceUrlValue(consoleHost)).toBe(`https://${consoleHost}`);
    expect(normalizeSurfaceUrlValue(`https://${portalHost}`)).toBe(`https://${portalHost}`);
    expect(normalizeSurfaceUrlValue('not a host')).toBe('');
  });

  test('resolveSurfaceUrl prefers deployed surface rows over legacy top-level aliases', () => {
    const manifest = {
      surfaces: {
        console: {
          deployment_url: `https://${surfaceConsoleHost}`,
        },
      },
      console_url: `https://${rootConsoleHost}`,
    };

    expect(resolveSurfaceUrl({
      manifest,
      surfaceId: 'console',
      includeEnvFallback: false,
    })).toBe(`https://${surfaceConsoleHost}`);
  });

  test('resolveSurfaceUrl falls back to matching compound surface ids and env keys only when allowed', () => {
    const manifest = {
      surfaces: {
        mobile_fieldops: {
          host: 'fieldops-preview.example.com',
        },
      },
    };

    expect(resolveSurfaceUrl({
      manifest,
      surfaceId: 'mobile',
      envKey: 'MOBILE_BASE_URL',
      env: { MOBILE_BASE_URL: 'https://yzriwrupzuvumpytlvyimxzh.example.invalid' },
      includeEnvFallback: false,
    })).toBe('https://fieldops-preview.example.com');

    expect(resolveSurfaceUrl({
      manifest: {},
      surfaceId: 'docs',
      envKey: 'DOCS_BASE_URL',
      env: { DOCS_BASE_URL: 'lzkrgrqxkkgiwugzyiyqgrvo.example.invalid' },
      includeEnvFallback: true,
    })).toBe('https://lzkrgrqxkkgiwugzyiyqgrvo.example.invalid');
  });
});
