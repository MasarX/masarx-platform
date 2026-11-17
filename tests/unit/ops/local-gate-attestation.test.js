const {
  LOCAL_GATE_MARKER,
  createLocalGateState,
  parseLocalGateCommentState,
  buildLocalGateCommentBody,
  commentHasExactMarker,
  findCommentByMarker,
  resolveLocalGateAttestation,
} = require('../../../scripts/ops/ci/local-gate-attestation');

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
    const attestation = await resolveLocalGateAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: {
        findCommentByMarker: async () => ({
          body: buildLocalGateCommentBody({
            prNumber: 2301,
            state: createLocalGateState({
              status: 'passed',
              head_sha: 'a'.repeat(40),
              base_sha: 'b'.repeat(40),
            }),
          }),
        }),
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
      body: buildLocalGateCommentBody({
        prNumber: 2301,
        state: createLocalGateState({
          status: 'passed',
          head_sha: 'a'.repeat(40),
          base_sha: 'b'.repeat(40),
        }),
      }),
    };

    const staleHead = await resolveLocalGateAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'c'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: { findCommentByMarker: async () => comment },
    });
    const staleBase = await resolveLocalGateAttestation({
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
    const missing = await resolveLocalGateAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: { findCommentByMarker: async () => null },
    });
    const invalid = await resolveLocalGateAttestation({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      prNumber: 2301,
      currentHeadSha: 'a'.repeat(40),
      currentBaseSha: 'b'.repeat(40),
      helpers: {
        findCommentByMarker: async () => ({
          body: `${LOCAL_GATE_MARKER}\nState: {"status":"passed"}`,
        }),
      },
    });

    expect(missing.reason).toBe('missing');
    expect(invalid.reason).toBe('invalid');
  });

  test('commentHasExactMarker only matches a standalone marker line', () => {
    expect(commentHasExactMarker(`${LOCAL_GATE_MARKER}\nState: {}`)).toBe(true);
    expect(commentHasExactMarker(`status note with \`${LOCAL_GATE_MARKER}\` in prose`)).toBe(false);
    expect(commentHasExactMarker(`prefix${LOCAL_GATE_MARKER}suffix`)).toBe(false);
  });

  test('findCommentByMarker ignores newer narrative comments that only mention the marker', async () => {
    const attestationComment = {
      id: 10,
      updated_at: '2026-04-13T10:40:00Z',
      body: buildLocalGateCommentBody({
        prNumber: 2301,
        state: createLocalGateState({
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
    });

    expect(selected).toBe(attestationComment);
  });
});
