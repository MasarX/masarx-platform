const {
  DEFAULT_FULL_ON_PR_ACTIONS,
  DEFAULT_FULL_MODE_EVENTS,
  isTruthy,
  parseActionsCsv,
  resolveFullOnPrActions,
  resolveFullModeEvents,
  resolvePrGateMode,
  formatOutputs,
} = require('../../../scripts/ops/ci/pr-gate-mode');

describe('pr-gate-mode', () => {
  describe('isTruthy', () => {
    test('handles common truthy values', () => {
      expect(isTruthy('1')).toBe(true);
      expect(isTruthy('true')).toBe(true);
      expect(isTruthy('YES')).toBe(true);
    });

    test('returns false for empty/false values', () => {
      expect(isTruthy('')).toBe(false);
      expect(isTruthy('0')).toBe(false);
      expect(isTruthy('false')).toBe(false);
    });
  });

  describe('actions parsing', () => {
    test('normalizes and deduplicates CSV actions', () => {
      expect(parseActionsCsv(' opened, synchronize,opened ,READY_FOR_REVIEW ')).toEqual([
        'opened',
        'synchronize',
        'ready_for_review',
      ]);
    });

    test('falls back to default full-on-pr actions when unset', () => {
      expect(resolveFullOnPrActions('')).toEqual(DEFAULT_FULL_ON_PR_ACTIONS);
    });

    test('falls back to default full-mode events when unset', () => {
      expect(resolveFullModeEvents('')).toEqual(DEFAULT_FULL_MODE_EVENTS);
    });
  });

  describe('resolvePrGateMode', () => {
    test('always enables full mode for merge_group', () => {
      const mode = resolvePrGateMode({ eventName: 'merge_group' });
      expect(mode.runFull).toBe(true);
      expect(mode.mode).toBe('merge-group');
      expect(mode.reason).toBe('merge_group');
    });

    test('enables full mode for workflow_dispatch', () => {
      const mode = resolvePrGateMode({ eventName: 'workflow_dispatch' });
      expect(mode.runFull).toBe(true);
      expect(mode.mode).toBe('full');
      expect(mode.reason).toBe('workflow_dispatch');
    });

    test('PR_GATE_CI respects PR_GATE_CI_EVENTS', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'synchronize',
        prGateCi: '1',
        prGateCiEvents: 'merge_group,workflow_dispatch',
      });
      expect(mode.runFull).toBe(false);
      expect(mode.reason).toBe('default_verify_only');
    });

    test('PR_GATE_CI can enable pull_request full mode when configured', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'synchronize',
        prGateCi: '1',
        prGateCiEvents: 'pull_request,merge_group',
      });
      expect(mode.runFull).toBe(true);
      expect(mode.mode).toBe('full');
      expect(mode.reason).toBe('pr_gate_ci:pull_request');
    });

    test('keeps draft pull requests in verify-only mode', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        prGateCi: '1',
        prGateCiEvents: 'pull_request',
        prIsDraft: '1',
      });
      expect(mode.runFull).toBe(false);
      expect(mode.mode).toBe('verify-only-draft');
      expect(mode.reason).toBe('draft_pr');
    });

    test('enables full mode for allowed PR actions when PR_GATE_FULL_ON_PR=1', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'opened',
        prGateFullOnPr: '1',
        sameRepoPr: '1',
      });
      expect(mode.runFull).toBe(true);
      expect(mode.mode).toBe('full-on-pr');
      expect(mode.reason).toBe('pr_gate_full_on_pr:opened');
    });

    test('keeps synchronize verify-only by default with PR_GATE_FULL_ON_PR=1', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'synchronize',
        prGateFullOnPr: '1',
        sameRepoPr: '1',
      });
      expect(mode.runFull).toBe(false);
      expect(mode.mode).toBe('verify-only');
      expect(mode.reason).toBe('pr_gate_full_on_pr_action_filtered:synchronize');
    });

    test('supports action override through PR_GATE_FULL_ON_PR_ACTIONS', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'synchronize',
        prGateFullOnPr: '1',
        prGateFullOnPrActions: 'opened,synchronize',
        sameRepoPr: '1',
      });
      expect(mode.runFull).toBe(true);
      expect(mode.reason).toBe('pr_gate_full_on_pr:synchronize');
    });

    test('forces verify-only for fork pull requests', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'opened',
        prGateFullOnPr: '1',
        sameRepoPr: '0',
      });
      expect(mode.runFull).toBe(false);
      expect(mode.reason).toBe('fork_pr');
    });

    test('returns default verify-only when no full trigger is active', () => {
      const mode = resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'opened',
        prGateFullOnPr: '0',
      });
      expect(mode.runFull).toBe(false);
      expect(mode.reason).toBe('default_verify_only');
    });
  });

  describe('formatOutputs', () => {
    test('serializes mode decision to workflow outputs', () => {
      const outputs = formatOutputs(resolvePrGateMode({
        eventName: 'pull_request',
        eventAction: 'opened',
        prGateFullOnPr: '1',
        sameRepoPr: '1',
      }));
      expect(outputs.run_full).toBe('1');
      expect(outputs.mode).toBe('full-on-pr');
      expect(outputs.full_on_pr_actions).toBe(DEFAULT_FULL_ON_PR_ACTIONS.join(','));
      expect(outputs.full_on_pr_action_allowed).toBe('1');
      expect(outputs.full_mode_events).toBe(DEFAULT_FULL_MODE_EVENTS.join(','));
      expect(outputs.full_mode_event_allowed).toBe('0');
    });
  });
});
