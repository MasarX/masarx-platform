const {
  LOCAL_GATE_MARKER,
  createLocalGateState,
  parseLocalGateCommentState,
  buildLocalGateCommentBody,
  commentHasExactMarker,
  commentHasAuthorizedAuthor,
  findCommentByMarker,
  resolveLocalGateAttestation,
} = require('../../../scripts/ops/ci/local-gate-attestation');
const {
  sha256,
  loadLocalGateManifestPolicy,
} = require('../../../scripts/ops/ci/local-gate-manifest');

const POLICY_SHA256 = sha256(loadLocalGateManifestPolicy());
const EXPECTED_AUTHOR = 'pr-author';

function authorizedComment(body, login = EXPECTED_AUTHOR, type = 'User') {
  return { body, user: { login, type } };
}

function resolveAttestation(input = {}) {
  return resolveLocalGateAttestation({
    expectedAuthorLogin: EXPECTED_AUTHOR,
    ...input,
    helpers: {
      loadBasePolicyFromGithub: async () => structuredClone(loadLocalGateManifestPolicy()),
      loadCandidatePolicyFromGithub: async () => structuredClone(loadLocalGateManifestPolicy()),
      ...(input.helpers || {}),
    },
  });
}

function validContractState(input = {}) {
  return createLocalGateState({
    manifest_contract_version: 'local-gate-manifest.v1',
    policy_sha256: POLICY_SHA256,
    manifest_sha256: '1'.repeat(64),
    changed_files_sha256: '2'.repeat(64),
    surface_ids_sha256: '3'.repeat(64),
    suite_ids_sha256: '4'.repeat(64),
    command_plan_sha256: '5'.repeat(64),
    command_results_sha256: '6'.repeat(64),
    repository_clean: true,
    generated_at: new Date().toISOString(),
    ...input,
  });
}

describe('local-gate-attestation', () => {
  test('builds and parses local gate comment state', () => {
    const body = buildLocalGateCommentBody({
      prNumber: 2301,
      state: {
        status: 'passed',
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
        manifest_path: '.tmp/local-gate.json',
        surface_ids: ['db', 'console'],
        suite_ids: ['test_unit'],
      },
    });

    expect(body).toContain(LOCAL_GATE_MARKER);
    expect(parseLocalGateCommentState(body)).toEqual(
      expect.objectContaining({
        status: 'passed',
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
        manifest_path: '.tmp/local-gate.json',
        surface_ids: ['db', 'console'],
        suite_ids: ['test_unit'],
      }),
    );
  });

  test('resolveLocalGateAttestation returns fresh for matching head and base', async () => {
    const attestation = await resolveAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: {
        findCommentByMarker: async () => authorizedComment(
          buildLocalGateCommentBody({
            prNumber: 2301,
            state: validContractState({
              status: 'passed',
              head_sha: 'a'.repeat(40),
              base_sha: 'b'.repeat(40),
            }),
          }),
        ),
      },
    });

    expect(attestation).toEqual(
      expect.objectContaining({
        present: true,
        fresh: true,
        reason: 'fresh',
      }),
    );
  });

  test('resolveLocalGateAttestation reports stale head and stale base separately', async () => {
    const comment = {
      user: { login: EXPECTED_AUTHOR, type: 'User' },
      body: buildLocalGateCommentBody({
        prNumber: 2301,
        state: validContractState({
          status: 'passed',
          head_sha: 'a'.repeat(40),
          base_sha: 'b'.repeat(40),
        }),
      }),
    };

    const staleHead = await resolveAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'c'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: { findCommentByMarker: async () => comment },
    });
    const staleBase = await resolveAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'd'.repeat(40),
      helpers: { findCommentByMarker: async () => comment },
    });

    expect(staleHead.reason).toBe('stale_head');
    expect(staleBase.reason).toBe('stale_base');
  });

  test('resolveLocalGateAttestation reports invalid or missing markers fail closed', async () => {
    const missing = await resolveAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: { findCommentByMarker: async () => null },
    });
    const invalid = await resolveAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: {
        findCommentByMarker: async () => authorizedComment(`${LOCAL_GATE_MARKER}\nState: {"status":"passed"}`),
      },
    });

    expect(missing.reason).toBe('missing');
    expect(invalid.reason).toBe('invalid');
  });

  test('resolveLocalGateAttestation rejects missing and expired manifest contracts', async () => {
    const exact = {
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
    };
    const missingContract = await resolveAttestation({
      ...exact,
      helpers: {
        findCommentByMarker: async () => authorizedComment(buildLocalGateCommentBody({
            prNumber: 2301,
            state: createLocalGateState({
              head_sha: 'a'.repeat(40),
              base_sha: 'b'.repeat(40),
            }),
          })),
      },
    });
    const expiredState = validContractState({
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      generated_at: '2026-07-15T00:00:00.000Z',
    });
    const expired = await resolveAttestation({
      ...exact,
      nowMs: Date.parse('2026-07-16T12:00:00.000Z'),
      helpers: {
        findCommentByMarker: async () => authorizedComment(
          buildLocalGateCommentBody({ prNumber: 2301, state: expiredState }),
        ),
      },
    });

    expect(missingContract.reason).toBe('invalid_contract');
    expect(expired.reason).toBe('expired');
  });

  test('commentHasExactMarker only matches a standalone marker line', () => {
    expect(commentHasExactMarker(`${LOCAL_GATE_MARKER}\nState: {}`)).toBe(true);
    expect(commentHasExactMarker(`status note with \`${LOCAL_GATE_MARKER}\` in prose`)).toBe(false);
    expect(commentHasExactMarker(`prefix${LOCAL_GATE_MARKER}suffix`)).toBe(false);
  });

  test('findCommentByMarker ignores newer narrative comments that only mention the marker', async () => {
    const attestationComment = {
      id: 10,
      user: { login: EXPECTED_AUTHOR, type: 'User' },
      updated_at: '2026-04-13T10:40:00Z',
      body: buildLocalGateCommentBody({
        prNumber: 2301,
        state: validContractState({
          status: 'passed',
          head_sha: 'a'.repeat(40),
          base_sha: 'b'.repeat(40),
        }),
      }),
    };
    const narrativeComment = {
      id: 11,
      updated_at: '2026-04-13T10:50:00Z',
      body: `Release note referencing \`${LOCAL_GATE_MARKER}\` for context only.`,
    };
    const github = {
      paginate: jest.fn().mockResolvedValue([attestationComment, narrativeComment]),
      rest: {
        issues: {
          listComments: jest.fn(),
        },
      },
    };

    const selected = await findCommentByMarker({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      issueNumber: 2301,
      expectedAuthorLogin: EXPECTED_AUTHOR,
    });

    expect(selected).toBe(attestationComment);
  });

  test('foreign marker cannot shadow an older authorized author marker', async () => {
    const authorized = authorizedComment(
      buildLocalGateCommentBody({
        prNumber: 2301,
        state: validContractState({ head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) }),
      }),
    );
    authorized.id = 10;
    authorized.updated_at = '2026-07-16T10:00:00Z';
    const spoof = authorizedComment(authorized.body, 'attacker');
    spoof.id = 11;
    spoof.updated_at = '2026-07-16T10:01:00Z';
    const github = {
      paginate: jest.fn().mockResolvedValue([authorized, spoof]),
      rest: { issues: { listComments: jest.fn() } },
    };
    const selected = await findCommentByMarker({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      issueNumber: 2301,
      expectedAuthorLogin: EXPECTED_AUTHOR,
    });
    expect(selected).toBe(authorized);
  });

  test('resolver rejects a spoof returned by a non-filtering helper and fails without PR author', async () => {
    const body = buildLocalGateCommentBody({
      prNumber: 2301,
      state: validContractState({ head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) }),
    });
    const spoof = await resolveAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: { findCommentByMarker: async () => authorizedComment(body, 'attacker') },
    });
    const missingAuthor = await resolveLocalGateAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
    });
    expect(spoof.reason).toBe('unauthorized_author');
    expect(missingAuthor.reason).toBe('missing_expected_author');
  });

  test('Bot and App identities fail closed even when login text matches PR author', () => {
    expect(commentHasAuthorizedAuthor(
      { user: { login: EXPECTED_AUTHOR, type: 'Bot' } },
      { expectedAuthorLogin: EXPECTED_AUTHOR },
    )).toBe(false);
    expect(commentHasAuthorizedAuthor(
      { user: { login: 'trusted-app[bot]', type: 'User' } },
      { expectedAuthorLogin: EXPECTED_AUTHOR },
    )).toBe(false);
    expect(commentHasAuthorizedAuthor(
      { user: { login: EXPECTED_AUTHOR } },
      { expectedAuthorLogin: EXPECTED_AUTHOR },
    )).toBe(false);
    expect(commentHasAuthorizedAuthor(
      { user: { login: EXPECTED_AUTHOR, type: 'Unknown' } },
      { expectedAuthorLogin: EXPECTED_AUTHOR },
    )).toBe(false);
  });

  test('candidate policy is fetched from the exact PR head before attestation acceptance', async () => {
    const loadCandidatePolicyFromGithub = jest.fn(async () => structuredClone(loadLocalGateManifestPolicy()));
    const body = buildLocalGateCommentBody({
      prNumber: 2301,
      state: validContractState({ head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) }),
    });
    const result = await resolveAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: {
        loadCandidatePolicyFromGithub,
        findCommentByMarker: async () => authorizedComment(body),
      },
    });
    expect(result.fresh).toBe(true);
    expect(loadCandidatePolicyFromGithub).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'MasarX',
      repo: 'MasarX',
      headSha: 'a'.repeat(40),
    }));
  });

  test('exact-base policy rejects weaker candidate even when candidate checkout policy could self-accept', async () => {
    const basePolicy = structuredClone(loadLocalGateManifestPolicy());
    const weakerCandidate = {
      ...structuredClone(basePolicy),
      max_age_minutes: basePolicy.max_age_minutes + 1,
    };
    const loadBasePolicyFromGithub = jest.fn(async () => basePolicy);
    const loadCandidatePolicyFromGithub = jest.fn(async () => weakerCandidate);
    const result = await resolveLocalGateAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      expectedAuthorLogin: EXPECTED_AUTHOR,
      helpers: {
        loadBasePolicyFromGithub,
        loadCandidatePolicyFromGithub,
        findCommentByMarker: async () => null,
      },
    });
    expect(result.reason).toBe('candidate_policy_weakened');
    expect(loadBasePolicyFromGithub).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'b'.repeat(40) }));
    expect(loadCandidatePolicyFromGithub).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'a'.repeat(40) }));
  });

  test('missing base policy bootstraps only with exact external head and policy hash anchors', async () => {
    const policy = structuredClone(loadLocalGateManifestPolicy());
    const body = buildLocalGateCommentBody({
      prNumber: 2301,
      state: validContractState({ head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) }),
    });
    const common = {
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      expectedAuthorLogin: EXPECTED_AUTHOR,
      helpers: {
        loadBasePolicyFromGithub: async () => { throw new Error('404 Not Found'); },
        loadCandidatePolicyFromGithub: async () => policy,
        findCommentByMarker: async () => authorizedComment(body),
      },
    };
    const missingAnchors = await resolveLocalGateAttestation(common);
    const exact = await resolveLocalGateAttestation({
      ...common,
      bootstrapHeadSha: 'a'.repeat(40),
      bootstrapPolicySha256: sha256(policy),
    });
    expect(missingAnchors.reason).toBe('base_policy_missing');
    expect(exact).toEqual(expect.objectContaining({
      fresh: true,
      policy_bootstrap: true,
      policy_sha256: sha256(policy),
    }));
  });
});
