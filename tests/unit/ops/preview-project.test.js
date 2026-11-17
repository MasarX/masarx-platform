const {
  extractPrNumber,
  extractPrNumberFromMergeGroupHeadRef,
  resolvePreviewJwtSeed,
  resolvePreviewJwtFallback,
  shouldPreservePlatformApiKeysForPreview,
  decodeJwtPayload,
  isLikelyProjectRef,
  buildSupabaseProjectUrl,
  extractProjectRefFromIssuer,
  extractProjectRefFromSupabaseUrl,
  resolvePreviewWorkspaceApiKeys,
  resolveProjectRefFromStaticApiKeys,
  resolveDegradedFallbackProjectRef,
  resolvePreviewSupabaseUrl,
  buildFallbackEdgeDbJwtBundle,
  resolvePoolerHost,
  applyAutoFallbackToProjectState,
  resolveAutoFallbackProjectRef,
  shouldAllowStaticApiKeyFallback,
  shouldSyncDerivedPreviewJwtSecret,
  shouldFailClosedOnMissingPreviewJwtSecret,
  resolveProjectRefForProjectMode,
  shouldRebuildProjectOnDnsFailure,
  resolvePreviewDnsTimeoutMs,
  isDirectPreviewDnsOnlyFailure,
  isManagementApiForbiddenError,
  buildRecoveryProjectName,
  shouldSkipAuthDriftRebuild,
  shouldRecoverWithFreshProjectSibling,
  shouldRejectRecreatedPreviewProjectReuse,
  buildRecreatedPreviewProjectReuseError,
  isRecreatedPreviewProjectReuseError,
  shouldRotateRecoverySibling,
  resolveReusedPreviewRecoveryWaitBudget,
  resolveRecreatedPreviewRecoveryWaitBudget,
  maybeRecoverReusedPreviewPoolerAuth,
  waitForDns,
  isProjectNameAlreadyExistsError,
  isProjectCreateInconclusiveError,
  isRetryableProjectCreateError,
  shouldUseParentProjectFallback,
  createProjectWithNameConflictRecovery,
  findCompatiblePreviewFamilyProject,
  isDbAuthConnectivityError,
  shouldSyncPreviewDbPasswordOnAuthError,
  waitForPoolerUsableWithAuthLagRecovery,
  buildPreviewPoolerDbCandidates,
  buildPreviewEnvPayload,
  checkDbConnectivityCandidates,
  parseConnectionTarget,
  waitForDbReady,
  waitForDbReadyCandidates,
  resolvePreviewProjectCommandTimeoutMs,
} = require('../../../scripts/ops/workspace/preview-project');
const { buildDbConnectionCandidates } = require('../../../scripts/utils/pg-candidates');

function buildPreviewPoolerCandidatesDeterministically(rawCandidates, options = {}) {
  return buildDbConnectionCandidates(rawCandidates, {
    ...options,
    ensureHostaddrFn: async (dsn) => dsn,
    ensureIpv4HostnameFn: async (dsn) => dsn,
  });
}

function buildJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload || {})).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('preview-project merge_group compatibility', () => {
  test('resolvePoolerHost prefers existing region for reused projects', () => {
    expect(resolvePoolerHost({
      configuredPoolerHost: '',
      configuredRegion: 'me-central-1',
      existingRegion: 'eu-west-1',
    })).toEqual({
      poolerHost: 'aws-1-eu-west-1.pooler.supabase.com',
      effectiveRegion: 'eu-west-1',
    });
  });

  test('resolvePoolerHost falls back to configured region', () => {
    expect(resolvePoolerHost({
      configuredPoolerHost: '',
      configuredRegion: 'me-central-1',
      existingRegion: '',
    })).toEqual({
      poolerHost: 'aws-1-me-central-1.pooler.supabase.com',
      effectiveRegion: 'me-central-1',
    });
  });

  test('resolvePoolerHost uses explicit pooler host when set', () => {
    expect(resolvePoolerHost({
      configuredPoolerHost: 'custom.pooler.example',
      configuredRegion: 'me-central-1',
      existingRegion: 'eu-west-1',
    })).toEqual({
      poolerHost: 'custom.pooler.example',
      effectiveRegion: 'eu-west-1',
    });
  });

  test('applyAutoFallbackToProjectState resets branch-derived creation state and preserves fallback project ref', () => {
    expect(applyAutoFallbackToProjectState({
      workspaceMode: 'branch',
      projectRef: '5fd7e30a-80df-483b-955c-7a633c6ba9d6',
      fallbackProjectRef: 'parent-ref',
      branchId: 'branch-1',
      existingBranch: { branch_id: 'branch-1' },
      projectWasCreated: true,
      untouched: 'keep-me',
    })).toEqual({
      workspaceMode: 'project',
      projectRef: 'parent-ref',
      branchId: '',
      existingBranch: null,
      projectWasCreated: false,
      fallbackProjectRef: 'parent-ref',
      untouched: 'keep-me',
    });
  });

  test('resolveProjectRefForProjectMode prefers existing fallback project ref', () => {
    expect(
      resolveProjectRefForProjectMode({
        projectRef: 'parent-ref',
        envProjectRef: 'env-ref',
      })
    ).toBe('parent-ref');
  });

  test('resolveProjectRefForProjectMode uses env project ref when no fallback project ref', () => {
    expect(
      resolveProjectRefForProjectMode({
        projectRef: '',
        envProjectRef: 'env-ref',
      })
    ).toBe('env-ref');
  });

  test('resolveAutoFallbackProjectRef keeps branch project ref for branch auth-probe fallback', () => {
    expect(resolveAutoFallbackProjectRef({
      err: { status: 422, message: 'Branch DB auth probe failed: password authentication failed for user "postgres"' },
      branchProjectRef: '5fd7e30a-80df-483b-955c-7a633c6ba9d6',
      staticProjectRef: '',
      selectedBranchParentRef: 'parent-ref',
      envProjectRef: 'env-ref',
      branchParentCandidates: ['candidate-a', 'candidate-b'],
    })).toBe('5fd7e30a-80df-483b-955c-7a633c6ba9d6');
  });

  test('resolveAutoFallbackProjectRef keeps branch project ref even when static fallback exists for branch auth-probe errors', () => {
    expect(resolveAutoFallbackProjectRef({
      err: { status: 422, message: 'Branch DB auth probe failed: password authentication failed for user "postgres"' },
      branchProjectRef: '5fd7e30a-80df-483b-955c-7a633c6ba9d6',
      staticProjectRef: 'static-ref',
      selectedBranchParentRef: 'parent-ref',
      envProjectRef: 'env-ref',
      branchParentCandidates: ['candidate-a', 'candidate-b'],
    })).toBe('5fd7e30a-80df-483b-955c-7a633c6ba9d6');
  });

  test('resolveAutoFallbackProjectRef keeps degraded static fallback for non-branch auth errors', () => {
    expect(resolveAutoFallbackProjectRef({
      err: { status: 422, message: 'Tenant or user not found' },
      branchProjectRef: '5fd7e30a-80df-483b-955c-7a633c6ba9d6',
      staticProjectRef: 'static-ref',
      selectedBranchParentRef: 'parent-ref',
      envProjectRef: 'env-ref',
      branchParentCandidates: ['candidate-a', 'candidate-b'],
    })).toBe('static-ref');
  });

  test('resolveAutoFallbackProjectRef drops removed branch parents so auto mode can create a fresh project', () => {
    expect(resolveAutoFallbackProjectRef({
      err: { status: 400, message: 'Resource has been removed' },
      branchProjectRef: '',
      staticProjectRef: '',
      selectedBranchParentRef: 'dead-parent-ref',
      envProjectRef: '',
      branchParentCandidates: ['dead-parent-ref', 'dead-parent-ref-2'],
    })).toBe('');
  });

  test('resolveAutoFallbackProjectRef still prefers explicit static or env project refs for removed branch parents', () => {
    expect(resolveAutoFallbackProjectRef({
      err: { status: 400, message: 'Resource has been removed' },
      branchProjectRef: '',
      staticProjectRef: 'static-ref',
      selectedBranchParentRef: 'dead-parent-ref',
      envProjectRef: 'env-ref',
      branchParentCandidates: ['dead-parent-ref'],
    })).toBe('static-ref');
  });

  test('resolveAutoFallbackProjectRef keeps branch project ref for non-fallback errors', () => {
    expect(resolveAutoFallbackProjectRef({
      err: { status: 400, message: 'validation error' },
      branchProjectRef: '5fd7e30a-80df-483b-955c-7a633c6ba9d6',
      staticProjectRef: 'static-ref',
      selectedBranchParentRef: 'parent-ref',
      envProjectRef: 'env-ref',
      branchParentCandidates: ['candidate-a', 'candidate-b'],
    })).toBe('5fd7e30a-80df-483b-955c-7a633c6ba9d6');
  });

  test('shouldAllowStaticApiKeyFallback allows static keys in EDGE_REQUIRE_DB_JWT=0 mode', () => {
    expect(shouldAllowStaticApiKeyFallback({
      allowStaticKeys: true,
      staticAnon: 'anon-key',
      staticService: 'service-key',
      jwtSource: '',
      usedMgmtApiBypassFallback: false,
      previewJwtSeed: 'explicit-jwt-seed',
      edgeRequireDbJwt: '0',
    })).toBe(true);
  });

  test('shouldAllowStaticApiKeyFallback allows static keys in degraded management mode even with jwt seed', () => {
    expect(shouldAllowStaticApiKeyFallback({
      allowStaticKeys: true,
      staticAnon: 'anon-key',
      staticService: 'service-key',
      staticProjectRef: 'abcdefghijklmnopqrst',
      projectRef: 'abcdefghijklmnopqrst',
      jwtSource: '',
      usedMgmtApiBypassFallback: true,
      previewJwtSeed: 'explicit-jwt-seed',
      edgeRequireDbJwt: '1',
    })).toBe(true);
  });

  test('shouldAllowStaticApiKeyFallback rejects static keys when static key ref mismatches preview project ref', () => {
    expect(shouldAllowStaticApiKeyFallback({
      allowStaticKeys: true,
      staticAnon: 'anon-key',
      staticService: 'service-key',
      staticProjectRef: 'abcdefghijklmnopqrst',
      projectRef: 'rttvgmzysswxrnspvotr',
      jwtSource: '',
      usedMgmtApiBypassFallback: true,
      previewJwtSeed: 'explicit-jwt-seed',
      edgeRequireDbJwt: '0',
    })).toBe(false);
  });

  test('shouldAllowStaticApiKeyFallback rejects static keys in strict jwt mode without bypass', () => {
    expect(shouldAllowStaticApiKeyFallback({
      allowStaticKeys: true,
      staticAnon: 'anon-key',
      staticService: 'service-key',
      jwtSource: '',
      usedMgmtApiBypassFallback: false,
      previewJwtSeed: 'explicit-jwt-seed',
      edgeRequireDbJwt: '1',
    })).toBe(false);
  });

  test('shouldSyncDerivedPreviewJwtSecret enables deterministic preview JWT sync for auto-generated preview projects', () => {
    expect(shouldSyncDerivedPreviewJwtSecret({
      edgeRequireDbJwt: '0',
      previewJwtSeed: 'preview-seed',
      jwtSeed: 'preview-seed',
      usedMgmtApiBypassFallback: false,
      envProjectName: '',
      envProjectRef: '',
      projectRef: 'abcdefghijklmnopqrst',
    })).toBe(true);
  });

  test('shouldSyncDerivedPreviewJwtSecret accepts derived stable seeds when explicit preview seed is unavailable', () => {
    expect(shouldSyncDerivedPreviewJwtSecret({
      edgeRequireDbJwt: '0',
      previewJwtSeed: '',
      jwtSeed: 'derived-stable-seed',
      usedMgmtApiBypassFallback: false,
      envProjectName: '',
      envProjectRef: '',
      projectRef: 'abcdefghijklmnopqrst',
    })).toBe(true);
  });

  test('shouldSyncDerivedPreviewJwtSecret avoids rotating pinned or degraded preview targets in EDGE_REQUIRE_DB_JWT=0 mode', () => {
    expect(shouldSyncDerivedPreviewJwtSecret({
      edgeRequireDbJwt: '0',
      previewJwtSeed: 'preview-seed',
      jwtSeed: 'preview-seed',
      usedMgmtApiBypassFallback: true,
      envProjectName: '',
      envProjectRef: '',
      projectRef: 'abcdefghijklmnopqrst',
    })).toBe(false);

    expect(shouldSyncDerivedPreviewJwtSecret({
      edgeRequireDbJwt: '0',
      previewJwtSeed: 'preview-seed',
      jwtSeed: 'preview-seed',
      usedMgmtApiBypassFallback: false,
      envProjectName: 'shared-preview',
      envProjectRef: '',
      projectRef: 'abcdefghijklmnopqrst',
    })).toBe(false);

    expect(shouldSyncDerivedPreviewJwtSecret({
      edgeRequireDbJwt: '0',
      previewJwtSeed: 'preview-seed',
      jwtSeed: 'preview-seed',
      usedMgmtApiBypassFallback: false,
      envProjectName: '',
      envProjectRef: 'abcdefghijklmnopqrst',
      projectRef: 'abcdefghijklmnopqrst',
    })).toBe(false);
  });

  test('shouldFailClosedOnMissingPreviewJwtSecret only fails closed in strict EDGE_REQUIRE_DB_JWT mode', () => {
    expect(shouldFailClosedOnMissingPreviewJwtSecret({
      edgeRequireDbJwt: '0',
      jwtSecret: '',
    })).toBe(false);

    expect(shouldFailClosedOnMissingPreviewJwtSecret({
      edgeRequireDbJwt: '1',
      jwtSecret: '',
    })).toBe(true);

    expect(shouldFailClosedOnMissingPreviewJwtSecret({
      edgeRequireDbJwt: '1',
      jwtSecret: 'derived-secret',
    })).toBe(false);
  });

  test('shouldRebuildProjectOnDnsFailure returns true for reused project mode workspaces', () => {
    expect(
      shouldRebuildProjectOnDnsFailure({
        workspaceMode: 'project',
        projectWasCreated: false,
        projectName: 'wk-demo-pr-1',
        projectRef: 'abc123',
      })
    ).toBe(true);
  });

  test('shouldRebuildProjectOnDnsFailure returns false for non-reusable states', () => {
    expect(
      shouldRebuildProjectOnDnsFailure({
        workspaceMode: 'branch',
        projectWasCreated: false,
        projectName: 'wk-demo-pr-1',
        projectRef: 'abc123',
      })
    ).toBe(false);
    expect(
      shouldRebuildProjectOnDnsFailure({
        workspaceMode: 'project',
        projectWasCreated: true,
        projectName: 'wk-demo-pr-1',
        projectRef: 'abc123',
      })
    ).toBe(false);
    expect(
      shouldRebuildProjectOnDnsFailure({
        workspaceMode: 'project',
        projectWasCreated: false,
        projectName: '',
        projectRef: 'abc123',
      })
    ).toBe(false);
  });

  test('resolvePreviewDnsTimeoutMs caps reused project direct-DNS waits so rebuild recovery starts sooner', () => {
    expect(
      resolvePreviewDnsTimeoutMs({
        configuredTimeoutMs: 20 * 60 * 1000,
        usedMgmtApiBypassFallback: false,
        workspaceMode: 'project',
        projectWasCreated: false,
        projectName: 'wk-demo-pr-1',
        projectRef: 'abcdefghijklmnopqrst',
        env: {},
      })
    ).toBe(5 * 60 * 1000);
  });

  test('resolvePreviewDnsTimeoutMs preserves tighter degraded-management caps and created-project defaults', () => {
    expect(
      resolvePreviewDnsTimeoutMs({
        configuredTimeoutMs: 20 * 60 * 1000,
        usedMgmtApiBypassFallback: true,
        workspaceMode: 'project',
        projectWasCreated: false,
        projectName: 'wk-demo-pr-1',
        projectRef: 'abcdefghijklmnopqrst',
        env: {},
      })
    ).toBe(120000);

    expect(
      resolvePreviewDnsTimeoutMs({
        configuredTimeoutMs: 20 * 60 * 1000,
        usedMgmtApiBypassFallback: false,
        workspaceMode: 'project',
        projectWasCreated: true,
        projectName: 'wk-demo-pr-1',
        projectRef: 'abcdefghijklmnopqrst',
        env: {},
      })
    ).toBe(20 * 60 * 1000);
  });

  test('isDirectPreviewDnsOnlyFailure detects direct-host-only reuse failures', () => {
    expect(
      isDirectPreviewDnsOnlyFailure({
        error: new Error(
          'DNS not ready (timeout_ms=1200000): db.ygtxxokvvtwxsqtmvzxw.supabase.co: getaddrinfo ENOTFOUND db.ygtxxokvvtwxsqtmvzxw.supabase.co'
        ),
        projectRef: 'ygtxxokvvtwxsqtmvzxw',
        poolerHost: 'aws-1-eu-west-1.pooler.supabase.com',
      })
    ).toBe(true);

    expect(
      isDirectPreviewDnsOnlyFailure({
        error: new Error(
          'DNS not ready (timeout_ms=1200000): db.ygtxxokvvtwxsqtmvzxw.supabase.co: getaddrinfo ENOTFOUND db.ygtxxokvvtwxsqtmvzxw.supabase.co; aws-1-eu-west-1.pooler.supabase.com: getaddrinfo ENOTFOUND aws-1-eu-west-1.pooler.supabase.com'
        ),
        projectRef: 'ygtxxokvvtwxsqtmvzxw',
        poolerHost: 'aws-1-eu-west-1.pooler.supabase.com',
      })
    ).toBe(false);
  });

  test('isManagementApiForbiddenError matches 401/403 management API failures', () => {
    expect(isManagementApiForbiddenError({ status: 403, message: 'Forbidden resource' })).toBe(true);
    expect(isManagementApiForbiddenError({ status: 401, message: 'Unauthorized' })).toBe(true);
    expect(isManagementApiForbiddenError(new Error('HTTP 403 DELETE /v1/projects/abc: Forbidden resource'))).toBe(true);
    expect(isManagementApiForbiddenError({ status: 422, message: 'validation failed' })).toBe(false);
  });

  test('buildRecoveryProjectName produces deterministic bounded fallback names', () => {
    const recovered = buildRecoveryProjectName('wk-masarx-pr-1617', {
      nowMs: 1700000000000,
      sha: '4781a335c70e6a14393c5b9e7b33c0ce277cfaa7',
    });
    expect(recovered).toMatch(/^wk-masarx-pr-1617-r-4781a33[a-z0-9]{4}$/);
    expect(recovered.length).toBeLessThanOrEqual(60);

    expect(buildRecoveryProjectName('X'.repeat(100), {
      nowMs: 1700000000000,
      sha: '',
    }).length).toBeLessThanOrEqual(60);
  });

  test('recreated preview project reuse is classified as delete-incomplete drift', () => {
    expect(
      shouldRejectRecreatedPreviewProjectReuse({
        previousProjectRef: 'vjmivumroxwoqhohxsyi',
        nextProjectRef: 'vjmivumroxwoqhohxsyi',
      }),
    ).toBe(true);
    expect(
      shouldRejectRecreatedPreviewProjectReuse({
        previousProjectRef: 'vjmivumroxwoqhohxsyi',
        nextProjectRef: 'newpreviewprojectref1',
      }),
    ).toBe(false);

    const err = buildRecreatedPreviewProjectReuseError({
      projectName: 'wk-masarx-pr-2876',
      projectRef: 'vjmivumroxwoqhohxsyi',
    });
    expect(isRecreatedPreviewProjectReuseError(err)).toBe(true);
    expect(err.status).toBe(409);
  });

  test('shouldSkipAuthDriftRebuild does not skip rebuild for auto-generated PR workspaces', () => {
    expect(
      shouldSkipAuthDriftRebuild({
        authConnectivityFailure: true,
        managementApiAuthBlocked: true,
        usedMgmtApiBypassFallback: false,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
      }),
    ).toBe(false);
  });

  test('shouldSkipAuthDriftRebuild skips rebuild for pinned preview workspaces', () => {
    expect(
      shouldSkipAuthDriftRebuild({
        authConnectivityFailure: true,
        managementApiAuthBlocked: false,
        usedMgmtApiBypassFallback: true,
        requestedWorkspaceMode: 'auto',
        envProjectName: 'shared-preview',
        envProjectRef: '',
      }),
    ).toBe(true);
    expect(
      shouldSkipAuthDriftRebuild({
        authConnectivityFailure: true,
        managementApiAuthBlocked: true,
        usedMgmtApiBypassFallback: false,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: 'abcdefghijklmnopqrst',
      }),
    ).toBe(true);
  });

  test('shouldSkipAuthDriftRebuild skips rebuild for non-auto requested modes under degraded management', () => {
    expect(
      shouldSkipAuthDriftRebuild({
        authConnectivityFailure: true,
        managementApiAuthBlocked: true,
        usedMgmtApiBypassFallback: false,
        requestedWorkspaceMode: 'project',
        envProjectName: '',
        envProjectRef: '',
      }),
    ).toBe(true);
  });

  test('shouldRecoverWithFreshProjectSibling allows auto-generated previews to recover from degraded rebuild failures', () => {
    const sameRefRecreate = buildRecreatedPreviewProjectReuseError({
      projectName: 'wk-masarx-pr-2876',
      projectRef: 'vjmivumroxwoqhohxsyi',
    });
    expect(
      shouldRecoverWithFreshProjectSibling({
        rebuildError: { status: 0, message: 'fetch failed (DELETE /v1/projects/abc): socket hang up' },
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        projectName: 'wk-masarx-pr-2301',
      }),
    ).toBe(true);
    expect(
      shouldRecoverWithFreshProjectSibling({
        rebuildError: { status: 403, message: 'Forbidden resource' },
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        projectName: 'wk-masarx-pr-2301',
      }),
    ).toBe(true);
    expect(
      shouldRecoverWithFreshProjectSibling({
        rebuildError: sameRefRecreate,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        projectName: 'wk-masarx-pr-2876',
      }),
    ).toBe(true);
  });

  test('shouldRecoverWithFreshProjectSibling stays fail-closed for pinned or empty preview targets', () => {
    expect(
      shouldRecoverWithFreshProjectSibling({
        rebuildError: { status: 0, message: 'fetch failed' },
        requestedWorkspaceMode: 'auto',
        envProjectName: 'shared-preview',
        envProjectRef: '',
        projectName: 'wk-masarx-pr-2301',
      }),
    ).toBe(false);
    expect(
      shouldRecoverWithFreshProjectSibling({
        rebuildError: { status: 0, message: 'fetch failed' },
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        projectName: '',
      }),
    ).toBe(false);
  });

  test('shouldRotateRecoverySibling requires an existing recovery path and a still-retryable rebuild error', () => {
    expect(
      shouldRotateRecoverySibling({
        rebuildError: { status: 0, message: 'fetch failed' },
        recoveryReason: 'degraded_rebuild_recovery_sibling',
        rotationAttempted: false,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        projectName: 'wk-masarx-pr-2301',
      }),
    ).toBe(true);
    expect(
      shouldRotateRecoverySibling({
        rebuildError: { status: 0, message: 'fetch failed' },
        recoveryReason: '',
        rotationAttempted: false,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        projectName: 'wk-masarx-pr-2301',
      }),
    ).toBe(false);
    expect(
      shouldRotateRecoverySibling({
        rebuildError: { status: 0, message: 'fetch failed' },
        recoveryReason: 'degraded_rebuild_recovery_sibling',
        rotationAttempted: true,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        projectName: 'wk-masarx-pr-2301',
      }),
    ).toBe(false);
  });

  test('resolveReusedPreviewRecoveryWaitBudget caps degraded wait for auto-generated previews', () => {
    expect(
      resolveReusedPreviewRecoveryWaitBudget({
        maxWaitMs: 720000,
        authErrorExtraMs: 480000,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        cappedMaxWaitMs: 180000,
        cappedAuthExtraMs: 60000,
      }),
    ).toEqual({
      maxWaitMs: 180000,
      authErrorExtraMs: 60000,
      capped: true,
    });
  });

  test('resolveReusedPreviewRecoveryWaitBudget preserves full wait for pinned previews', () => {
    expect(
      resolveReusedPreviewRecoveryWaitBudget({
        maxWaitMs: 720000,
        authErrorExtraMs: 480000,
        requestedWorkspaceMode: 'auto',
        envProjectName: 'wk-masarx-pr-1911',
        envProjectRef: '',
        cappedMaxWaitMs: 180000,
        cappedAuthExtraMs: 60000,
      }),
    ).toEqual({
      maxWaitMs: 720000,
      authErrorExtraMs: 480000,
      capped: false,
    });
  });

  test('resolveRecreatedPreviewRecoveryWaitBudget caps auth lag for auto-generated previews', () => {
    expect(
      resolveRecreatedPreviewRecoveryWaitBudget({
        maxWaitMs: 720000,
        authErrorExtraMs: 480000,
        requestedWorkspaceMode: 'auto',
        envProjectName: '',
        envProjectRef: '',
        cappedMaxWaitMs: 600000,
        cappedAuthExtraMs: 300000,
      }),
    ).toEqual({
      maxWaitMs: 600000,
      authErrorExtraMs: 300000,
      capped: true,
    });
  });

  test('maybeRecoverReusedPreviewPoolerAuth waits for reused preview auth recovery when management recovery is unavailable', async () => {
    const waitForPoolerUsableFn = jest.fn().mockResolvedValue(undefined);
    const logger = { warn: jest.fn(), log: jest.fn() };

    const result = await maybeRecoverReusedPreviewPoolerAuth({
      probe: { ok: false, error: new Error('Tenant or user not found') },
      managementApiAuthBlocked: true,
      usedMgmtApiBypassFallback: false,
      waitForPoolerUsableFn,
      maxWaitMs: 1234,
      authErrorExtraMs: 5678,
      logger,
    });

    expect(waitForPoolerUsableFn).toHaveBeenCalledWith('pooler reused auth wait', {
      maxWaitMs: 10000,
      authErrorExtraMs: 5678,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('waiting for pooler readiness before rebuild'),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('recovered after degraded-mode auth wait'),
    );
    expect(result).toEqual({
      recovered: true,
      probe: { ok: true },
    });
  });

  test('maybeRecoverReusedPreviewPoolerAuth prefers a healthy direct-capable DB wait when available', async () => {
    const waitForPoolerUsableFn = jest.fn();
    const waitForPreferredDbUsableFn = jest.fn().mockResolvedValue(undefined);
    const logger = { warn: jest.fn(), log: jest.fn() };

    const result = await maybeRecoverReusedPreviewPoolerAuth({
      probe: { ok: false, error: new Error('Tenant or user not found') },
      managementApiAuthBlocked: true,
      usedMgmtApiBypassFallback: false,
      waitForPoolerUsableFn,
      waitForPreferredDbUsableFn,
      maxWaitMs: 4321,
      authErrorExtraMs: 8765,
      logger,
    });

    expect(waitForPreferredDbUsableFn).toHaveBeenCalledWith('preview db reused auth wait', {
      maxWaitMs: 10000,
      authErrorExtraMs: 8765,
    });
    expect(waitForPoolerUsableFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('waiting for a healthy preview DB candidate before rebuild'),
    );
    expect(result).toEqual({
      recovered: true,
      probe: { ok: true },
    });
  });

  test('maybeRecoverReusedPreviewPoolerAuth preserves failure when degraded-mode wait does not recover the preview', async () => {
    const waitErr = new Error('DB not ready after degraded wait');
    const waitForPoolerUsableFn = jest.fn().mockRejectedValue(waitErr);
    const logger = { warn: jest.fn(), log: jest.fn() };
    const probe = { ok: false, error: new Error('Tenant or user not found') };

    const result = await maybeRecoverReusedPreviewPoolerAuth({
      probe,
      managementApiAuthBlocked: false,
      usedMgmtApiBypassFallback: true,
      waitForPoolerUsableFn,
      maxWaitMs: 2500,
      authErrorExtraMs: 0,
      logger,
    });

    expect(waitForPoolerUsableFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not recover during degraded-mode auth wait'),
    );
    expect(logger.log).not.toHaveBeenCalled();
    expect(result.recovered).toBe(false);
    expect(result.probe.ok).toBe(false);
    expect(result.probe.error).toBe(waitErr);
  });

  test('maybeRecoverReusedPreviewPoolerAuth does not wait for non-auth failures or healthy probes', async () => {
    const waitForPoolerUsableFn = jest.fn();
    const logger = { warn: jest.fn(), log: jest.fn() };

    const nonAuth = await maybeRecoverReusedPreviewPoolerAuth({
      probe: { ok: false, error: new Error('connect ETIMEDOUT') },
      managementApiAuthBlocked: true,
      usedMgmtApiBypassFallback: false,
      waitForPoolerUsableFn,
      logger,
    });
    const healthy = await maybeRecoverReusedPreviewPoolerAuth({
      probe: { ok: true },
      managementApiAuthBlocked: true,
      usedMgmtApiBypassFallback: true,
      waitForPoolerUsableFn,
      logger,
    });

    expect(waitForPoolerUsableFn).not.toHaveBeenCalled();
    expect(nonAuth).toEqual({
      recovered: false,
      probe: { ok: false, error: expect.any(Error) },
    });
    expect(String(nonAuth.probe.error.message)).toBe('connect ETIMEDOUT');
    expect(healthy).toEqual({
      recovered: false,
      probe: { ok: true },
    });
  });

  test('extractPrNumber supports pull_request event', () => {
    expect(extractPrNumber({ pull_request: { number: 123 } })).toBe('123');
  });

  test('extractPrNumber supports merge_group.head_ref', () => {
    expect(extractPrNumber({ merge_group: { head_ref: 'gh-readonly-queue/main/pr-354-deadbeef' } })).toBe('354');
    expect(extractPrNumber({ merge_group: { head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-acde' } })).toBe('7');
  });

  test('extractPrNumberFromMergeGroupHeadRef returns empty on unknown input', () => {
    expect(extractPrNumberFromMergeGroupHeadRef('')).toBe('');
    expect(extractPrNumberFromMergeGroupHeadRef('gh-readonly-queue/main/nope')).toBe('');
  });

  test('resolvePreviewJwtSeed prioritizes explicit seed then service key then token', () => {
    expect(resolvePreviewJwtSeed({ explicitSeed: 'explicit', serviceKey: 'svc', accessToken: 'tok' }))
      .toEqual({ seed: 'explicit', source: 'explicit' });
    expect(resolvePreviewJwtSeed({ explicitSeed: '', serviceKey: 'svc', accessToken: 'tok' }))
      .toEqual({ seed: 'svc', source: 'service_role' });
    expect(resolvePreviewJwtSeed({ explicitSeed: '', serviceKey: '', accessToken: 'tok' }))
      .toEqual({ seed: 'tok', source: 'access_token' });
    expect(resolvePreviewJwtSeed({ explicitSeed: '', serviceKey: '', accessToken: '' }))
      .toEqual({ seed: '', source: '' });
  });

  test('decodeJwtPayload returns payload object for JWT-like tokens', () => {
    const token = buildJwt({ iss: 'https://abcdefghijklmnopqrst.supabase.co/auth/v1' });
    expect(decodeJwtPayload(token)).toEqual(
      expect.objectContaining({ iss: 'https://abcdefghijklmnopqrst.supabase.co/auth/v1' }),
    );
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
  });

  test('project ref helpers derive canonical ref from issuer/static keys', () => {
    expect(isLikelyProjectRef('abcdefghijklmnopqrst')).toBe(true);
    expect(isLikelyProjectRef('invalid-ref')).toBe(false);
    expect(buildSupabaseProjectUrl('abcdefghijklmnopqrst')).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(extractProjectRefFromIssuer('https://abcdefghijklmnopqrst.supabase.co/auth/v1')).toBe('abcdefghijklmnopqrst');
    expect(extractProjectRefFromSupabaseUrl('https://abcdefghijklmnopqrst.supabase.co')).toBe('abcdefghijklmnopqrst');

    const serviceKey = buildJwt({ iss: 'https://abcdefghijklmnopqrst.supabase.co/auth/v1' });
    expect(resolveProjectRefFromStaticApiKeys({ serviceKey, anonKey: '' })).toBe('abcdefghijklmnopqrst');

    const anonKey = buildJwt({ ref: 'rttvgmzysswxrnspvotr' });
    expect(resolveProjectRefFromStaticApiKeys({ serviceKey: '', anonKey })).toBe('rttvgmzysswxrnspvotr');
  });

  test('resolvePreviewSupabaseUrl preserves matching configured preview URL', () => {
    expect(resolvePreviewSupabaseUrl({
      envSupabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      projectRef: 'abcdefghijklmnopqrst',
    })).toEqual({
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      source: 'configured',
      configuredProjectRef: 'abcdefghijklmnopqrst',
    });
  });

  test('resolvePreviewSupabaseUrl rebuilds canonical URL when configured preview URL targets a stale project', () => {
    expect(resolvePreviewSupabaseUrl({
      envSupabaseUrl: 'https://rttvgmzysswxrnspvotr.supabase.co',
      projectRef: 'abcdefghijklmnopqrst',
    })).toEqual({
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      source: 'constructed_mismatch',
      configuredProjectRef: 'rttvgmzysswxrnspvotr',
    });
  });

  test('resolvePreviewWorkspaceApiKeys prefers modern management keys for preview env overlays', async () => {
    const getApiKeysFn = jest.fn().mockResolvedValue({
      anon: 'sb_publishable_preview_modern',
      service: 'sb_secret_preview_modern',
    });

    await expect(resolvePreviewWorkspaceApiKeys({
      allowStaticFallback: false,
      projectRef: 'abcdefghijklmnopqrst',
      token: 'EXAMPLE_PASSWORD',
      getApiKeysFn,
    })).resolves.toEqual({
      anon: 'sb_publishable_preview_modern',
      service: 'sb_secret_preview_modern',
    });

    expect(getApiKeysFn).toHaveBeenCalledTimes(1);
    expect(getApiKeysFn).toHaveBeenCalledWith('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      preferModern: true,
    });
  });

  test('resolvePreviewWorkspaceApiKeys preserves allowed static preview keys and backfills only missing values', async () => {
    const getApiKeysFn = jest.fn().mockResolvedValue({
      anon: 'sb_publishable_preview_modern',
      service: 'sb_secret_preview_modern',
    });

    await expect(resolvePreviewWorkspaceApiKeys({
      allowStaticFallback: true,
      staticAnon: 'sb_publishable_static_preview',
      staticService: '',
      projectRef: 'abcdefghijklmnopqrst',
      token: 'EXAMPLE_PASSWORD',
      getApiKeysFn,
    })).resolves.toEqual({
      anon: 'sb_publishable_static_preview',
      service: 'sb_secret_preview_modern',
    });

    expect(getApiKeysFn).toHaveBeenCalledTimes(1);
    expect(getApiKeysFn).toHaveBeenCalledWith('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      preferModern: true,
    });
  });

  test('preview platform API keys stay separate from edge DB JWT signing keys', () => {
    expect(shouldPreservePlatformApiKeysForPreview({
      jwtSecret: 'edge-db-jwt-secret',
      keys: {
        anon: 'sb_publishable_preview_modern',
        service: 'sb_secret_preview_modern',
      },
      keysMatchSecret: false,
    })).toBe(true);

    expect(shouldPreservePlatformApiKeysForPreview({
      jwtSecret: 'edge-db-jwt-secret',
      keys: {
        anon: 'sb_publishable_preview_modern',
        service: 'sb_secret_preview_modern',
      },
      keysMatchSecret: true,
    })).toBe(false);
  });

  test('resolveDegradedFallbackProjectRef prefers branch parent over static key ref', () => {
    expect(resolveDegradedFallbackProjectRef({
      branchParentRef: 'mnopqrstabcdefghijk1',
      staticProjectRef: 'abcdefghijklmnopqrst',
    })).toEqual({
      projectRef: 'mnopqrstabcdefghijk1',
      source: 'branch_parent_ref',
    });

    expect(resolveDegradedFallbackProjectRef({
      branchParentRef: '',
      staticProjectRef: 'abcdefghijklmnopqrst',
    })).toEqual({
      projectRef: 'abcdefghijklmnopqrst',
      source: 'static_api_key',
    });
  });

  test('resolvePreviewJwtFallback downgrades on storage auth timeout after mint', () => {
    const fallback = resolvePreviewJwtFallback({
      edgeRequireDbJwt: '1',
      didMintKeys: true,
      apiKeys: { anon: 'anon-key', service: 'service-key' },
      err: new Error('Timeout waiting for storage auth after 5 attempts'),
    });
    expect(fallback).toEqual(
      expect.objectContaining({
        edgeRequireDbJwt: '0',
        jwtSecret: '',
        jwtSource: '',
        keys: { anon: 'anon-key', service: 'service-key' },
      })
    );
  });

  test('resolvePreviewJwtFallback returns null when not eligible', () => {
    expect(resolvePreviewJwtFallback({
      edgeRequireDbJwt: '0',
      didMintKeys: true,
      apiKeys: { anon: 'anon-key', service: 'service-key' },
      err: new Error('Timeout waiting for storage auth after 5 attempts'),
    })).toBeNull();
    expect(resolvePreviewJwtFallback({
      edgeRequireDbJwt: '1',
      didMintKeys: false,
      apiKeys: { anon: 'anon-key', service: 'service-key' },
      err: new Error('Timeout waiting for storage auth after 5 attempts'),
    })).toBeNull();
    expect(resolvePreviewJwtFallback({
      edgeRequireDbJwt: '1',
      didMintKeys: true,
      apiKeys: { anon: 'anon-key', service: 'service-key' },
      err: new Error('Other error'),
    })).toBeNull();
  });

  test('buildFallbackEdgeDbJwtBundle returns null when service key is empty', () => {
    expect(buildFallbackEdgeDbJwtBundle('')).toBeNull();
  });

  test('buildFallbackEdgeDbJwtBundle maps service key into per-function tokens', () => {
    const bundle = buildFallbackEdgeDbJwtBundle('service-key');
    expect(bundle).toEqual({
      webhook_db_jwt: 'service-key',
      api_caller_db_jwt: 'service-key',
      api_gateway_db_jwt: 'service-key',
      label_renderer_db_jwt: 'service-key',
    });
  });

  test('waitForDns resolves once all targets resolve', async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms) => {
      t += ms;
    };
    let dbAttempts = 0;
    const lookup = async (host) => {
      if (String(host).startsWith('db.')) {
        dbAttempts += 1;
        if (dbAttempts < 3) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      }
      return { address: '127.0.0.1', family: 4 };
    };

    await waitForDns({
      projectRef: 'abc',
      poolerHost: 'pooler.example',
      timeoutMs: 20,
      pollMs: 1,
      lookup,
      now,
      sleep,
    });

    expect(dbAttempts).toBe(3);
  });

  test('waitForDns times out with host summary', async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms) => {
      t += ms;
    };
    const lookup = async (host) => {
      if (String(host).startsWith('db.')) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      return { address: '127.0.0.1', family: 4 };
    };

    await expect(waitForDns({
      projectRef: 'abc',
      poolerHost: 'pooler.example',
      timeoutMs: 5,
      pollMs: 1,
      lookup,
      now,
      sleep,
    })).rejects.toThrow('db.abc.supabase.co');
  });

  test('waitForDns supports pooler-only mode', async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms) => {
      t += ms;
    };
    const hosts = [];
    const lookup = async (host) => {
      hosts.push(String(host));
      return { address: '127.0.0.1', family: 4 };
    };

    await expect(waitForDns({
      projectRef: 'abc',
      poolerHost: 'pooler.example',
      includeDirectHost: false,
      timeoutMs: 5,
      pollMs: 1,
      lookup,
      now,
      sleep,
    })).resolves.toBeUndefined();

    expect(hosts).toEqual(['pooler.example']);
  });

  test('isDbAuthConnectivityError detects auth-related pooler failures', () => {
    expect(isDbAuthConnectivityError(new Error('password authentication failed for user "postgres"'))).toBe(true);
    expect(isDbAuthConnectivityError(new Error('Tenant or user not found'))).toBe(true);
    expect(isDbAuthConnectivityError(new Error('Circuit breaker open: Too many authentication errors'))).toBe(true);
    expect(isDbAuthConnectivityError(new Error('connection timeout'))).toBe(false);
  });

  test('isProjectNameAlreadyExistsError detects Supabase project name conflicts', () => {
    expect(isProjectNameAlreadyExistsError(new Error('HTTP 400 POST /v1/projects: Project with name "wk-x" already exists in your organization.'))).toBe(true);
    expect(isProjectNameAlreadyExistsError(new Error('HTTP 401 Unauthorized'))).toBe(false);
  });

  test('project create helpers classify inconclusive insert failures as retryable recovery candidates', () => {
    const err = Object.assign(new Error('HTTP 404 POST /v1/projects: Failed to insert project'), {
      status: 404,
    });
    expect(isProjectCreateInconclusiveError(err)).toBe(true);
    expect(isRetryableProjectCreateError(err)).toBe(true);
  });

  test('shouldUseParentProjectFallback allows degraded parent-ref reuse on auth/transient failures', () => {
    expect(shouldUseParentProjectFallback({ status: 401, message: 'JWT could not be decoded' })).toBe(true);
    expect(shouldUseParentProjectFallback({ status: 403, message: 'forbidden' })).toBe(true);
    expect(shouldUseParentProjectFallback({ status: 429, message: 'rate limited' })).toBe(true);
    expect(shouldUseParentProjectFallback({ status: 503, message: 'service unavailable' })).toBe(true);
    expect(shouldUseParentProjectFallback({ status: 0, message: 'fetch failed ECONNRESET' })).toBe(true);
    expect(shouldUseParentProjectFallback({ status: 422, message: 'Branch DB auth probe failed: password authentication failed for user "postgres"' })).toBe(true);
    expect(shouldUseParentProjectFallback({ status: 422, message: 'Tenant or user not found' })).toBe(true);
    expect(shouldUseParentProjectFallback({ status: 400, message: 'Resource has been removed' })).toBe(false);
    expect(shouldUseParentProjectFallback({ status: 400, message: 'validation error' })).toBe(false);
  });

  test('createProjectWithNameConflictRecovery reuses existing project on name conflict', async () => {
    const createProjectFn = jest
      .fn()
      .mockRejectedValue(new Error('HTTP 400 POST /v1/projects: Project with name "wk-x" already exists in your organization.'));
    const findProjectByNameFn = jest
      .fn()
      .mockResolvedValue({ project_ref: 'reused-ref', region: 'us-east-1' });

    const result = await createProjectWithNameConflictRecovery({
      token: 'tok',
      organizationId: 'org',
      name: 'wk-x',
      region: 'us-east-1',
      plan: 'free',
      dbPass: 'secret',
      createProjectFn,
      findProjectByNameFn,
      logger: { warn: jest.fn() },
    });

    expect(createProjectFn).toHaveBeenCalledTimes(1);
    expect(findProjectByNameFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      project: { project_ref: 'reused-ref' },
      reusedExisting: true,
      existingProject: { project_ref: 'reused-ref', region: 'us-east-1' },
      effectiveName: 'wk-x',
    });
  });

  test('createProjectWithNameConflictRecovery rethrows when conflict has no reusable project', async () => {
    const err = new Error('HTTP 400 POST /v1/projects: Project with name "wk-x" already exists in your organization.');
    const createProjectFn = jest.fn().mockRejectedValue(err);
    const findProjectByNameFn = jest.fn().mockResolvedValue(null);

    await expect(createProjectWithNameConflictRecovery({
      token: 'tok',
      organizationId: 'org',
      name: 'wk-x',
      region: 'us-east-1',
      plan: 'free',
      dbPass: 'secret',
      createProjectFn,
      findProjectByNameFn,
      logger: { warn: jest.fn() },
    })).rejects.toBe(err);
  });

  test('createProjectWithNameConflictRecovery reuses existing project when create returns failed-to-insert but project is discoverable', async () => {
    const err = Object.assign(new Error('HTTP 404 POST /v1/projects: Failed to insert project'), {
      status: 404,
    });
    const createProjectFn = jest.fn().mockRejectedValue(err);
    const findProjectByNameFn = jest
      .fn()
      .mockResolvedValue({ project_ref: 'reused-after-insert-failure', region: 'us-east-1' });

    const result = await createProjectWithNameConflictRecovery({
      token: 'tok',
      organizationId: 'org',
      name: 'wk-x-r-abc1234',
      region: 'us-east-1',
      plan: 'free',
      dbPass: 'secret',
      createProjectFn,
      findProjectByNameFn,
      logger: { warn: jest.fn() },
    });

    expect(createProjectFn).toHaveBeenCalledTimes(1);
    expect(findProjectByNameFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      project: { project_ref: 'reused-after-insert-failure' },
      reusedExisting: true,
      existingProject: { project_ref: 'reused-after-insert-failure', region: 'us-east-1' },
      effectiveName: 'wk-x-r-abc1234',
    });
  });

  test('createProjectWithNameConflictRecovery retries once after failed-to-insert create errors when no project is discoverable yet', async () => {
    const err = Object.assign(new Error('HTTP 404 POST /v1/projects: Failed to insert project'), {
      status: 404,
    });
    const createProjectFn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ project_ref: 'created-on-retry', region: 'us-east-1' });
    const findProjectByNameFn = jest.fn().mockResolvedValue(null);
    const logger = { warn: jest.fn() };

    const result = await createProjectWithNameConflictRecovery({
      token: 'tok',
      organizationId: 'org',
      name: 'wk-x-r-abc1234',
      region: 'us-east-1',
      plan: 'free',
      dbPass: 'secret',
      createProjectFn,
      findProjectByNameFn,
      logger,
      retryDelayMs: 1,
    });

    expect(createProjectFn).toHaveBeenCalledTimes(2);
    expect(findProjectByNameFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying create-by-name recovery"),
    );
    expect(result).toEqual({
      project: { project_ref: 'created-on-retry', region: 'us-east-1' },
      reusedExisting: false,
      existingProject: null,
      effectiveName: 'wk-x-r-abc1234',
    });
  });

  test('createProjectWithNameConflictRecovery rotates the recovery project name on retry when retryNameFn returns a new compatible name', async () => {
    const err = Object.assign(new Error('HTTP 404 POST /v1/projects: Failed to insert project'), {
      status: 404,
    });
    const createProjectFn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ project_ref: 'created-on-rotated-retry', region: 'us-east-1' });
    const findProjectByNameFn = jest.fn().mockResolvedValue(null);
    const logger = { warn: jest.fn() };
    const retryNameFn = jest.fn().mockReturnValueOnce('wk-x-r-rotated123');

    const result = await createProjectWithNameConflictRecovery({
      token: 'tok',
      organizationId: 'org',
      name: 'wk-x-r-abc1234',
      region: 'us-east-1',
      plan: 'free',
      dbPass: 'secret',
      createProjectFn,
      findProjectByNameFn,
      logger,
      retryDelayMs: 1,
      retryNameFn,
    });

    expect(retryNameFn).toHaveBeenCalledWith('wk-x-r-abc1234', 1, err);
    expect(createProjectFn).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'wk-x-r-abc1234' }));
    expect(createProjectFn).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'wk-x-r-rotated123' }));
    expect(findProjectByNameFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying create-by-name recovery with 'wk-x-r-rotated123'"),
    );
    expect(result).toEqual({
      project: { project_ref: 'created-on-rotated-retry', region: 'us-east-1' },
      reusedExisting: false,
      existingProject: null,
      effectiveName: 'wk-x-r-rotated123',
    });
  });

  test('createProjectWithNameConflictRecovery reuses a delayed family project after repeated inconclusive create responses', async () => {
    const err = Object.assign(new Error('HTTP 404 POST /v1/projects: Failed to insert project'), {
      status: 404,
    });
    const createProjectFn = jest.fn().mockRejectedValue(err);
    const findProjectByNameFn = jest.fn().mockResolvedValue(null);
    const findCompatibleProjectFn = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ project_ref: 'family-created-ref', name: 'wk-x-r-familyready', region: 'us-east-1' });
    const logger = { warn: jest.fn() };

    const result = await createProjectWithNameConflictRecovery({
      token: 'tok',
      organizationId: 'org',
      name: 'wk-x-r-abc1234',
      region: 'us-east-1',
      plan: 'free',
      dbPass: 'secret',
      createProjectFn,
      findProjectByNameFn,
      findCompatibleProjectFn,
      logger,
      retryDelayMs: 1,
      finalResolveMaxWaitMs: 5,
      finalResolveRetryDelayMs: 1,
      maxCreateAttempts: 2,
    });

    expect(createProjectFn).toHaveBeenCalledTimes(2);
    expect(findProjectByNameFn).toHaveBeenCalledTimes(3);
    expect(findCompatibleProjectFn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("waiting up to 5ms for preview-family visibility"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Create stabilized after delayed family requery for 'wk-x-r-familyready'"),
    );
    expect(result).toEqual({
      project: { project_ref: 'family-created-ref' },
      reusedExisting: true,
      existingProject: { project_ref: 'family-created-ref', name: 'wk-x-r-familyready', region: 'us-east-1' },
      effectiveName: 'wk-x-r-familyready',
    });
  });

  test('findCompatiblePreviewFamilyProject can restrict recovery reuse to the current preferred sibling names', async () => {
    const listProjectsFn = jest.fn().mockResolvedValue([
      {
        ref: 'older-family-ref',
        name: 'wk-masarx-pr-1926-r-older',
        region: 'us-east-1',
        created_at: '2026-03-13T10:00:00.000Z',
      },
      {
        ref: 'preferred-family-ref',
        name: 'wk-masarx-pr-1926-r-current',
        region: 'us-east-1',
        created_at: '2026-03-13T10:05:00.000Z',
      },
    ]);

    await expect(findCompatiblePreviewFamilyProject({
      token: 'tok',
      organizationId: 'org',
      familyName: 'wk-masarx-pr-1926-r-current',
      preferredNames: ['wk-masarx-pr-1926-r-current'],
      restrictToPreferredNames: true,
      listProjectsFn,
    })).resolves.toEqual({
      project_ref: 'preferred-family-ref',
      name: 'wk-masarx-pr-1926-r-current',
      region: 'us-east-1',
      raw: expect.objectContaining({
        ref: 'preferred-family-ref',
        name: 'wk-masarx-pr-1926-r-current',
      }),
    });

    await expect(findCompatiblePreviewFamilyProject({
      token: 'tok',
      organizationId: 'org',
      familyName: 'wk-masarx-pr-1926-r-current',
      preferredNames: ['wk-masarx-pr-1926-r-missing'],
      restrictToPreferredNames: true,
      listProjectsFn,
    })).resolves.toBeNull();
  });

  test('shouldSyncPreviewDbPasswordOnAuthError defaults to enabled', () => {
    expect(shouldSyncPreviewDbPasswordOnAuthError()).toBe(true);
    expect(shouldSyncPreviewDbPasswordOnAuthError('')).toBe(true);
  });

  test('shouldSyncPreviewDbPasswordOnAuthError honors explicit disable values', () => {
    expect(shouldSyncPreviewDbPasswordOnAuthError('0')).toBe(false);
    expect(shouldSyncPreviewDbPasswordOnAuthError('false')).toBe(false);
    expect(shouldSyncPreviewDbPasswordOnAuthError('no')).toBe(false);
    expect(shouldSyncPreviewDbPasswordOnAuthError('1')).toBe(true);
  });

  test('waitForPoolerUsableWithAuthLagRecovery refreshes password and retries once on auth lag', async () => {
    let nowMs = 0;
    const nowFn = jest.fn(() => nowMs);
    const waitForPoolerUsableFn = jest.fn()
      .mockImplementationOnce(async () => {
        nowMs = 240000;
        throw new Error('Tenant or user not found');
      })
      .mockResolvedValueOnce(undefined);
    const refreshProjectDbPasswordFn = jest.fn().mockResolvedValue(true);

    await expect(waitForPoolerUsableWithAuthLagRecovery({
      label: 'pooler after recreate',
      waitForPoolerUsableFn,
      projectRef: 'abcdefghijklmnopqrst',
      token: 'token-1',
      dbPass: 'secret',
      traceContext: null,
      maxWaitMs: 720000,
      authErrorExtraMs: 480000,
      previewDbPasswordSyncMaxWaitMs: 120000,
      previewDbPasswordSyncRetryDelayMs: 10000,
      shouldSyncDbPasswordOnAuthErrorFn: () => true,
      refreshProjectDbPasswordFn,
      logger: { warn: jest.fn(), log: jest.fn() },
      nowFn,
    })).resolves.toBeUndefined();

    expect(refreshProjectDbPasswordFn).toHaveBeenCalledWith(expect.objectContaining({
      projectRef: 'abcdefghijklmnopqrst',
      token: 'token-1',
      dbPass: 'secret',
      label: 'pooler after recreate auth-lag retry',
      maxWaitMs: 120000,
      retryDelayMs: 10000,
    }));
    expect(waitForPoolerUsableFn).toHaveBeenNthCalledWith(1, 'pooler after recreate', {
      maxWaitMs: 720000,
      authErrorExtraMs: 480000,
    });
    expect(waitForPoolerUsableFn).toHaveBeenNthCalledWith(2, 'pooler after recreate retry', {
      maxWaitMs: 720000,
      authErrorExtraMs: 240000,
    });
  });

  test('waitForPoolerUsableWithAuthLagRecovery fails closed when no retry budget remains', async () => {
    let nowMs = 0;
    const nowFn = jest.fn(() => nowMs);
    const waitForPoolerUsableFn = jest.fn().mockImplementationOnce(async () => {
      nowMs = 1_195_001;
      throw new Error('Tenant or user not found');
    });

    await expect(waitForPoolerUsableWithAuthLagRecovery({
      label: 'pooler after recreate',
      waitForPoolerUsableFn,
      projectRef: 'abcdefghijklmnopqrst',
      token: 'token-1',
      dbPass: 'secret',
      traceContext: null,
      maxWaitMs: 720000,
      authErrorExtraMs: 480000,
      previewDbPasswordSyncMaxWaitMs: 120000,
      previewDbPasswordSyncRetryDelayMs: 10000,
      shouldSyncDbPasswordOnAuthErrorFn: () => false,
      refreshProjectDbPasswordFn: jest.fn(),
      logger: { warn: jest.fn(), log: jest.fn() },
      nowFn,
    })).rejects.toThrow(/auth-lag recovery budget exhausted/i);

    expect(waitForPoolerUsableFn).toHaveBeenCalledTimes(1);
  });

  test('waitForPoolerUsableWithAuthLagRecovery honors the external recovery deadline across password sync and retry', async () => {
    let nowMs = 0;
    const nowFn = jest.fn(() => nowMs);
    const waitForPoolerUsableFn = jest.fn()
      .mockImplementationOnce(async () => {
        nowMs = 860000;
        throw new Error('Tenant or user not found');
      })
      .mockResolvedValueOnce(undefined);
    const refreshProjectDbPasswordFn = jest.fn().mockImplementation(async ({ maxWaitMs }) => {
      expect(maxWaitMs).toBe(40000);
      nowMs = 880000;
      return true;
    });

    await expect(waitForPoolerUsableWithAuthLagRecovery({
      label: 'pooler after recreate',
      waitForPoolerUsableFn,
      projectRef: 'abcdefghijklmnopqrst',
      token: 'token-1',
      dbPass: 'secret',
      traceContext: null,
      maxWaitMs: 720000,
      authErrorExtraMs: 480000,
      previewDbPasswordSyncMaxWaitMs: 120000,
      previewDbPasswordSyncRetryDelayMs: 10000,
      shouldSyncDbPasswordOnAuthErrorFn: () => true,
      refreshProjectDbPasswordFn,
      logger: { warn: jest.fn(), log: jest.fn() },
      nowFn,
      recoveryDeadlineMs: 900000,
    })).resolves.toBeUndefined();

    expect(waitForPoolerUsableFn).toHaveBeenNthCalledWith(1, 'pooler after recreate', {
      maxWaitMs: 720000,
      authErrorExtraMs: 180000,
    });
    expect(waitForPoolerUsableFn).toHaveBeenNthCalledWith(2, 'pooler after recreate retry', {
      maxWaitMs: 20000,
      authErrorExtraMs: 0,
    });
  });

  test('waitForPoolerUsableWithAuthLagRecovery rethrows non-auth pooler failures', async () => {
    const waitForPoolerUsableFn = jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT'));
    const refreshProjectDbPasswordFn = jest.fn();

    await expect(waitForPoolerUsableWithAuthLagRecovery({
      label: 'pooler after recreate',
      waitForPoolerUsableFn,
      projectRef: 'abcdefghijklmnopqrst',
      token: 'token-1',
      dbPass: 'secret',
      traceContext: null,
      maxWaitMs: 720000,
      authErrorExtraMs: 480000,
      previewDbPasswordSyncMaxWaitMs: 120000,
      previewDbPasswordSyncRetryDelayMs: 10000,
      shouldSyncDbPasswordOnAuthErrorFn: () => true,
      refreshProjectDbPasswordFn,
      logger: { warn: jest.fn(), log: jest.fn() },
    })).rejects.toThrow('connect ETIMEDOUT');

    expect(refreshProjectDbPasswordFn).not.toHaveBeenCalled();
    expect(waitForPoolerUsableFn).toHaveBeenCalledTimes(1);
  });

  test('buildPreviewPoolerDbCandidates expands Supabase pooler host and port variants', async () => {
    const candidates = await buildPreviewPoolerDbCandidates({
      projectRef: 'abcdefghijklmnopqrst',
      dbPass: 'secret',
      poolerHost: 'aws-1-me-central-1.pooler.supabase.com',
      poolerPort: '5432',
      buildCandidatesFn: buildPreviewPoolerCandidatesDeterministically,
    });

    const dsns = candidates.map((candidate) => candidate.dsn);
    expect(dsns.some((dsn) => dsn.includes('aws-0-me-central-1.pooler.supabase.com'))).toBe(true);
    expect(dsns.some((dsn) => dsn.includes(':6543/'))).toBe(true);
    expect(dsns.some((dsn) => dsn.includes('db.abcdefghijklmnopqrst.supabase.co:5432'))).toBe(true);
  });

  test('buildPreviewPoolerDbCandidates can exclude direct preview DB fallbacks for pooler-only readiness probes', async () => {
    const candidates = await buildPreviewPoolerDbCandidates({
      projectRef: 'abcdefghijklmnopqrst',
      dbPass: 'secret',
      poolerHost: 'aws-1-me-central-1.pooler.supabase.com',
      poolerPort: '5432',
      includeDirect: false,
      buildCandidatesFn: buildPreviewPoolerCandidatesDeterministically,
    });

    const dsns = candidates.map((candidate) => candidate.dsn);
    expect(dsns.some((dsn) => dsn.includes('aws-0-me-central-1.pooler.supabase.com'))).toBe(true);
    expect(dsns.some((dsn) => dsn.includes('db.abcdefghijklmnopqrst.supabase.co:5432'))).toBe(false);
  });

  test('checkDbConnectivityCandidates selects the first working variant in the candidate ladder', async () => {
    const res = await checkDbConnectivityCandidates({
      candidates: [
        { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'yxoixiplvmrsyzlsiynnvkjp',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_POOLER+poolerhost:aws-0', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
      ],
      checkFn: async ({ connectionString }) => (
        connectionString.includes('aws-0-')
          ? { ok: true }
          : { ok: false, error: new Error('Tenant or user not found') }
      ),
    });

    expect(res).toEqual({
      ok: true,
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0',
      connectionString: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    });
  });

  test('checkDbConnectivityCandidates reports the last attempted candidate on failure', async () => {
    const res = await checkDbConnectivityCandidates({
      candidates: [
        { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'yxoixiplvmrsyzlsiynnvkjp',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_DIRECT', dsn: (['postgresql',":","/","/",'postgres',":",'jxnqutgioznjmhgkmyrqlttw',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
      ],
      checkFn: async ({ connectionString }) => ({
        ok: false,
        error: new Error(connectionString.includes('@db.') ? 'direct timeout' : 'pooler auth lag'),
      }),
    });

    expect(res.ok).toBe(false);
    expect(String(res.error?.message || '')).toBe('direct timeout');
    expect(res.candidateName).toBe('DATABASE_URL_DIRECT');
    expect(res.connectionString).toContain('db.abcdefghijklmnopqrst.supabase.co:5432');
  });

  test('checkDbConnectivityCandidates preserves retryable auth failures over later direct fallback errors', async () => {
    const res = await checkDbConnectivityCandidates({
      candidates: [
        { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'yxoixiplvmrsyzlsiynnvkjp',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_DIRECT', dsn: (['postgresql',":","/","/",'postgres',":",'jxnqutgioznjmhgkmyrqlttw',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
      ],
      checkFn: async ({ connectionString }) => ({
        ok: false,
        error: new Error(
          connectionString.includes('@db.')
            ? 'connect ENETUNREACH 2a05:d016:571:a42d:a0e5:5e7:42ac:92d:5432'
            : 'Tenant or user not found',
        ),
      }),
    });

    expect(res.ok).toBe(false);
    expect(String(res.error?.message || '')).toBe('Tenant or user not found');
    expect(res.candidateName).toBe('DATABASE_URL_POOLER');
    expect(res.connectionString).toContain('aws-1-me-central-1.pooler.supabase.com:5432');
  });

  test('parseConnectionTarget extracts pooler host, port, and username', () => {
    expect(
      parseConnectionTarget((['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'6543',"/",'postgres'].join(""))),
    ).toEqual({
      connectionString: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'6543',"/",'postgres'].join("")),
      host: 'aws-0-me-central-1.pooler.supabase.com',
      port: '6543',
      username: 'postgres.abcdefghijklmnopqrst',
      kind: 'pooler',
    });
  });

  test('buildPreviewEnvPayload persists the selected preview DB candidate contract', () => {
    expect(
      buildPreviewEnvPayload({
        projectRef: 'abcdefghijklmnopqrst',
        supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
        directDbUrl: (['postgresql',":","/","/",'postgres',":",'jxnqutgioznjmhgkmyrqlttw',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
        preferredDatabaseUrl:
          (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'secret',"@",'192.0.2.10',":",'6543',"/",'postgres'].join("")),
        workspaceMode: 'project',
        keys: { anon: 'anon-key', service: 'service-key' },
        jwtSecret: 'jwt-secret',
        edgeInternalCallerRoles:
          'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role,service_role',
        edgeRequireDbJwt: '0',
        effectiveRegion: 'eu-central-1',
        configuredRegion: 'eu-central-1',
        poolerHost: 'aws-1-eu-central-1.pooler.supabase.com',
        poolerPort: '6543',
        selectedPoolerTarget: {
          connectionString:
            (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'secret',"@",'192.0.2.10',":",'6543',"/",'postgres'].join("")),
          host: '192.0.2.10',
          port: '6543',
          username: 'postgres.abcdefghijklmnopqrst',
          kind: '',
        },
        selectedPoolerCandidateName: 'DATABASE_URL_POOLER+ipv4host',
        orgId: 'org-1',
        token: 'token-1',
        dbPass: 'secret',
        edgeDbJwtBundle: { webhook_db_jwt: 'service-key' },
        githubToken: 'gh-token',
      }),
    ).toEqual(
      expect.objectContaining({
        preferred_database_url:
          (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'secret',"@",'192.0.2.10',":",'6543',"/",'postgres'].join("")),
        db_ready_candidate_name: 'DATABASE_URL_POOLER+ipv4host',
        pooler_port: '6543',
        pooler_user: 'postgres.abcdefghijklmnopqrst',
      }),
    );
  });

  test('waitForDbReady extends deadline for auth-lag errors and eventually succeeds', async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const sleepFn = async (ms) => {
      nowMs += ms;
    };
    let probes = 0;
    const checkFn = async () => {
      probes += 1;
      if (probes < 4) {
        return { ok: false, error: new Error('Tenant or user not found') };
      }
      return { ok: true };
    };

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(waitForDbReady({
      label: 'pooler',
      connectionString: 'postgresql://test',
      attempts: 2,
      // Use a large interval so the base deadline is crossed between iterations unless the
      // auth-extra window is applied before sleeping.
      intervalMs: 8000,
      connectionTimeoutMillis: 5,
      maxWaitMs: 12_000,
      authErrorExtraMs: 20_000,
      checkFn,
      sleepFn,
      now,
    })).resolves.toBeUndefined();
    expect(warn.mock.calls.some((call) => String(call?.[0] || '').includes('Extending DB readiness window for auth lag'))).toBe(true);
    warn.mockRestore();
  });

  test('waitForDbReady fails after max wait when errors persist', async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const sleepFn = async (ms) => {
      nowMs += ms;
    };
    const checkFn = async () => ({ ok: false, error: new Error('connection timeout') });

    await expect(waitForDbReady({
      label: 'pooler',
      connectionString: 'postgresql://test',
      attempts: 2,
      intervalMs: 1000,
      connectionTimeoutMillis: 5,
      maxWaitMs: 12_000,
      authErrorExtraMs: 0,
      checkFn,
      sleepFn,
      now,
    })).rejects.toThrow(/DB not ready \(pooler\)/i);
  });

  test('waitForDbReadyCandidates returns the working candidate and extends auth-lag deadline', async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const sleepFn = async (ms) => {
      nowMs += ms;
    };
    let probes = 0;
    const checkFn = async ({ candidates }) => {
      probes += 1;
      const fallback = candidates.find((candidate) => candidate.name.includes('aws-0'));
      if (probes < 3) {
        return { ok: false, error: new Error('Tenant or user not found') };
      }
      return {
        ok: true,
        candidateName: fallback.name,
        connectionString: fallback.dsn,
      };
    };

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(waitForDbReadyCandidates({
      label: 'pooler after recreate',
      candidates: [
        { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'yxoixiplvmrsyzlsiynnvkjp',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_POOLER+poolerhost:aws-0', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
      ],
      intervalMs: 8000,
      connectionTimeoutMillis: 5,
      maxWaitMs: 12_000,
      authErrorExtraMs: 20_000,
      checkFn,
      sleepFn,
      now,
    })).resolves.toEqual({
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0',
      connectionString: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    });
    expect(warn.mock.calls.some((call) => String(call?.[0] || '').includes('Extending DB readiness window for auth lag'))).toBe(true);
    warn.mockRestore();
  });

  test('waitForDbReadyCandidates models the full candidate ladder when projecting auth-lag extension', async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const sleepFn = async (ms) => {
      nowMs += ms;
    };
    const checkFn = jest.fn()
      .mockResolvedValueOnce({ ok: false, error: new Error('Tenant or user not found') })
      .mockResolvedValueOnce({
        ok: true,
        candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0',
        connectionString: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(waitForDbReadyCandidates({
      label: 'pooler after recreate',
      candidates: [
        { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'yxoixiplvmrsyzlsiynnvkjp',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_POOLER+poolerhost:aws-0', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_POOLER+poolerhost:aws-2', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'jvlghtjxsykqmqszltrovuht',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
      ],
      intervalMs: 1000,
      connectionTimeoutMillis: 5000,
      maxWaitMs: 12_000,
      authErrorExtraMs: 20_000,
      checkFn,
      sleepFn,
      now,
    })).resolves.toEqual({
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0',
      connectionString: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'ogjkuwxokwrshmihrqrrmnyh',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    });
    expect(warn.mock.calls.some((call) => String(call?.[0] || '').includes('Extending DB readiness window for auth lag'))).toBe(true);
    warn.mockRestore();
  });

  test('waitForDbReadyCandidates can fall back from pooler auth lag to direct preview DB connectivity', async () => {
    const checkFn = async ({ candidates }) => {
      const direct = candidates.find((candidate) => candidate.name.includes('DATABASE_URL_DIRECT'));
      return {
        ok: true,
        candidateName: direct.name,
        connectionString: direct.dsn,
      };
    };

    await expect(waitForDbReadyCandidates({
      label: 'pooler after recreate',
      candidates: [
        { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'yxoixiplvmrsyzlsiynnvkjp',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_DIRECT', dsn: (['postgresql',":","/","/",'postgres',":",'jxnqutgioznjmhgkmyrqlttw',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
      ],
      intervalMs: 1000,
      connectionTimeoutMillis: 5,
      maxWaitMs: 10_000,
      authErrorExtraMs: 0,
      checkFn,
      sleepFn: async () => {},
      now: () => 0,
    })).resolves.toEqual({
      candidateName: 'DATABASE_URL_DIRECT',
      connectionString: (['postgresql',":","/","/",'postgres',":",'jxnqutgioznjmhgkmyrqlttw',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    });
  });

  test('resolvePreviewProjectCommandTimeoutMs covers both DB auth recovery windows by default', () => {
    expect(resolvePreviewProjectCommandTimeoutMs({ env: {} })).toBe(3_300_000);
  });

  test('resolvePreviewProjectCommandTimeoutMs does not allow caller overrides below the derived recovery budget', () => {
    expect(resolvePreviewProjectCommandTimeoutMs({
      env: {
        PREVIEW_SUPABASE_DB_READY_TIMEOUT_MS: '600000',
        PREVIEW_SUPABASE_DB_READY_AUTH_EXTRA_MS: '180000',
        PREVIEW_PROJECT_COMMAND_TIMEOUT_BUFFER_MS: '300000',
      },
      requestedTimeoutMs: 180000,
      minimumTimeoutMs: 1_500_000,
    })).toBe(1_860_000);
  });
});
