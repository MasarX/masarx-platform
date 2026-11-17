const {
  classifyUiStateId,
  classifyHostedUiFailure,
  classifyHostedUiRetryPolicy,
  buildHostedUiGateSummary,
  isInfrastructureRetryableText,
} = require('../../../scripts/ops/gates/hosted-ui-state');

describe('hosted-ui-state', () => {
  test('classifyUiStateId maps known hosted surface states', () => {
    expect(classifyUiStateId('portal-auth-required')).toBe('auth-required');
    expect(classifyUiStateId('console-context-unavailable')).toBe('wrong-tenant');
    expect(classifyUiStateId('portal-missing-env')).toBe('callback-mismatch');
    expect(classifyUiStateId('console-resource-error')).toBe('resource-unavailable');
    expect(classifyUiStateId('console-resource-ready')).toBe('ready');
  });

  test('classifyHostedUiFailure recognizes auth, tenant, callback, demo-account, and resource failures', () => {
    expect(classifyHostedUiFailure('Expected portal resource ready state, got portal-auth-required').failure_class).toBe('auth-required');
    expect(classifyHostedUiFailure('UI context unavailable while expecting user@example.com to be signed in.').failure_class).toBe('wrong-tenant');
    expect(classifyHostedUiFailure('Sign-in failed: POST /auth/v1/token responded 400 Bad Request (redirect_to is not allowed)').failure_class).toBe('callback-mismatch');
    expect(classifyHostedUiFailure('Demo accounts missing for strict E2E: manifest missing').failure_class).toBe('demo-account-missing');
    expect(classifyHostedUiFailure('[verify:cloud:ui] failure_class=admin-auth-unready').failure_class).toBe('admin-auth-unready');
    expect(classifyHostedUiFailure('UI admin auth readiness check failed: Tenant or user not found').failure_class).toBe('admin-auth-unready');
    expect(classifyHostedUiFailure('Demo accounts readiness check failed: manifest missing').failure_class).toBe('demo-accounts-unready');
    expect(classifyHostedUiFailure('Smoke check failed for portal (https://portal.example.com) after 3 attempt(s): returned HTTP 503').failure_class).toBe('resource-unavailable');
  });

  test('buildHostedUiGateSummary emits failure class and failed step', () => {
    const summary = buildHostedUiGateSummary({
      status: 'failed',
      failedStep: 'verify:cloud:ui',
      outputText: 'Expected console resource ready state, got console-auth-required',
    });

    expect(summary.status).toBe('failed');
    expect(summary.failed_step).toBe('verify:cloud:ui');
    expect(summary.failure_class).toBe('auth-required');
    expect(summary.ui_state).toBe('auth-required');
  });

  test('classifyHostedUiRetryPolicy allows one bounded retry for infrastructure-class failures only', () => {
    expect(isInfrastructureRetryableText('Smoke check failed after timeout and returned HTTP 503')).toBe(true);
    expect(classifyHostedUiRetryPolicy({
      failureClass: 'resource-unavailable',
      outputText: 'Smoke check failed after timeout and returned HTTP 503',
      stepLabel: 'ui_resource_preflight',
    })).toEqual({
      retryable: true,
      retry_class: 'infrastructure',
      max_retries: 1,
    });
    expect(classifyHostedUiRetryPolicy({
      failureClass: 'auth-required',
      outputText: 'Expected console resource ready state, got console-auth-required',
      stepLabel: 'verify:cloud:ui',
    })).toEqual({
      retryable: false,
      retry_class: 'not-retryable',
      max_retries: 0,
    });
  });
});
