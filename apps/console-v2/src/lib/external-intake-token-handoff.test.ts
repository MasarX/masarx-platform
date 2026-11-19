import { afterEach, describe, expect, it } from 'vitest';
import {
  clearExternalIntakeSourceToken,
  consumeExternalIntakeSourceToken,
  peekExternalIntakeSourceToken,
  stashExternalIntakeSourceToken,
} from './external-intake-token-handoff';

describe('external intake token handoff', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('stores a source token for one target and consumes it once', () => {
    expect(stashExternalIntakeSourceToken('api-gateway', {
      token: ' source-token ',
      source_id: 'whs_123',
      source_name: 'API source',
    })).toBe(true);

    expect(consumeExternalIntakeSourceToken('webhook-tester')).toBeNull();
    expect(consumeExternalIntakeSourceToken('api-gateway')).toMatchObject({
      token: 'source-token',
      source_id: 'whs_123',
      source_name: 'API source',
    });
    expect(consumeExternalIntakeSourceToken('api-gateway')).toBeNull();
  });

  it('supports render-safe peek before explicit clear', () => {
    expect(stashExternalIntakeSourceToken('api-gateway', {
      token: ' source-token ',
      source_id: 'whs_123',
      source_name: 'API source',
    })).toBe(true);

    expect(peekExternalIntakeSourceToken('api-gateway')).toMatchObject({
      token: 'source-token',
      source_id: 'whs_123',
      source_name: 'API source',
    });
    expect(peekExternalIntakeSourceToken('api-gateway')).toMatchObject({
      token: 'source-token',
    });

    clearExternalIntakeSourceToken('api-gateway');
    expect(peekExternalIntakeSourceToken('api-gateway')).toBeNull();
  });

  it('rejects stale or empty handoffs', () => {
    expect(stashExternalIntakeSourceToken('webhook-tester', {
      token: '',
      source_id: 'whs_empty',
    })).toBe(false);

    expect(stashExternalIntakeSourceToken('webhook-tester', {
      token: 'source-token',
      source_id: 'whs_stale',
    })).toBe(true);
    expect(consumeExternalIntakeSourceToken('webhook-tester', Date.now() + 11 * 60 * 1000)).toBeNull();
  });

  it('clears cached handoffs when a later stash has no token', () => {
    expect(stashExternalIntakeSourceToken('webhook-tester', {
      token: 'source-token',
      source_id: 'whs_stale',
    })).toBe(true);
    expect(sessionStorage.length).toBe(1);

    expect(stashExternalIntakeSourceToken('webhook-tester', {
      token: '   ',
      source_id: 'whs_empty',
    })).toBe(false);
    expect(peekExternalIntakeSourceToken('webhook-tester')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('clears stale handoffs on peek so expired source tokens are not retained', () => {
    expect(stashExternalIntakeSourceToken('webhook-tester', {
      token: 'source-token',
      source_id: 'whs_stale',
    })).toBe(true);
    expect(sessionStorage.length).toBe(1);

    expect(peekExternalIntakeSourceToken('webhook-tester', Date.now() + 11 * 60 * 1000)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
