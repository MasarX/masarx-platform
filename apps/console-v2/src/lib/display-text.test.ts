import { describe, expect, it } from 'vitest';
import { humanizeToken } from './display-text';

describe('humanizeToken', () => {
  it('turns technical tokens into operator-facing labels', () => {
    expect(humanizeToken('return_to_branch_intake')).toBe('Return to branch intake');
    expect(humanizeToken('route.stop.finalize')).toBe('Route stop finalize');
    expect(humanizeToken('driverUserAssigned')).toBe('Driver User Assigned');
  });

  it('uses the provided fallback for empty values', () => {
    expect(humanizeToken('', 'Missing label')).toBe('Missing label');
    expect(humanizeToken(null, 'Missing label')).toBe('Missing label');
  });
});
