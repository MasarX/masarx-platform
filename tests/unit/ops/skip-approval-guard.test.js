const {
  DEFAULT_ALLOWED_ACTORS,
  parseCsv,
  isTruthy,
  resolveAllowedActors,
  resolveSkipApprovalPolicy,
  formatOutputs,
} = require('../../../scripts/ops/ci/skip-approval-guard');

describe('skip-approval-guard', () => {
  test('parseCsv normalizes, dedupes, and lowercases values', () => {
    expect(parseCsv(' masarx-bot-app[bot],GitHub-Actions[bot],masarx-bot-app[bot] ')).toEqual([
      'masarx-bot-app[bot]',
      'github-actions[bot]',
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  test('isTruthy supports common boolean flags', () => {
    expect(isTruthy('1')).toBe(true);
    expect(isTruthy('true')).toBe(true);
    expect(isTruthy('yes')).toBe(true);
    expect(isTruthy('on')).toBe(true);
    expect(isTruthy('0')).toBe(false);
    expect(isTruthy('false')).toBe(false);
    expect(isTruthy('')).toBe(false);
  });

  test('resolveAllowedActors falls back to defaults when csv is empty', () => {
    expect(resolveAllowedActors('')).toEqual(DEFAULT_ALLOWED_ACTORS);
  });

  test('resolveSkipApprovalPolicy allows normal runs when skip_approval is false', () => {
    const policy = resolveSkipApprovalPolicy({
      eventName: 'workflow_dispatch',
      actor: 'someone',
      skipApproval: 'false',
      allowedActorsCsv: '',
    });
    expect(policy.ok).toBe(true);
    expect(policy.reason).toBe('skip_approval_not_requested');
  });

  test('resolveSkipApprovalPolicy denies skip_approval for non-workflow_dispatch events', () => {
    const policy = resolveSkipApprovalPolicy({
      eventName: 'push',
      actor: 'github-actions[bot]',
      skipApproval: 'true',
      allowedActorsCsv: 'github-actions[bot]',
    });
    expect(policy.ok).toBe(false);
    expect(policy.reason).toBe('skip_approval_only_allowed_on_workflow_dispatch');
  });

  test('resolveSkipApprovalPolicy denies actors outside the allowlist', () => {
    const policy = resolveSkipApprovalPolicy({
      eventName: 'workflow_dispatch',
      actor: 'human-user',
      skipApproval: '1',
      allowedActorsCsv: 'github-actions[bot],masarx-bot-app[bot]',
    });
    expect(policy.ok).toBe(false);
    expect(policy.reason).toBe('actor_not_allowed_for_skip_approval');
  });

  test('resolveSkipApprovalPolicy allows allowlisted actor on workflow_dispatch', () => {
    const policy = resolveSkipApprovalPolicy({
      eventName: 'workflow_dispatch',
      actor: 'MasarX-Bot-App[bot]',
      skipApproval: 'yes',
      allowedActorsCsv: 'github-actions[bot],masarx-bot-app[bot]',
    });
    expect(policy.ok).toBe(true);
    expect(policy.reason).toBe('actor_allowed_for_skip_approval');
  });

  test('formatOutputs returns GitHub output-compatible keys', () => {
    const out = formatOutputs({
      ok: true,
      reason: 'actor_allowed_for_skip_approval',
      actor: 'masarx-bot-app[bot]',
      eventName: 'workflow_dispatch',
      skipApproval: true,
      allowedActors: ['github-actions[bot]', 'masarx-bot-app[bot]'],
    });
    expect(out).toEqual({
      ok: '1',
      reason: 'actor_allowed_for_skip_approval',
      actor: 'masarx-bot-app[bot]',
      event_name: 'workflow_dispatch',
      skip_approval: '1',
      allowed_actors: 'github-actions[bot],masarx-bot-app[bot]',
    });
  });
});
