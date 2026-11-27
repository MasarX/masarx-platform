import { expect, it, vi } from 'vitest';

it('cancels pending seed evidence replay when the listener unsubscribes', async () => {
  vi.useFakeTimers();
  try {
    const { streamEvidence } = await import('../data-source');
    const initialTimerCount = vi.getTimerCount();
    const listener = vi.fn();
    const unsubscribe = streamEvidence(listener);
    const subscribedTimerCount = vi.getTimerCount();

    unsubscribe();

    expect(subscribedTimerCount).toBeGreaterThan(initialTimerCount);
    const remainingTimerCount = vi.getTimerCount();
    vi.runOnlyPendingTimers();
    expect(listener).not.toHaveBeenCalled();
    expect(remainingTimerCount).toBe(initialTimerCount);
  } finally {
    vi.useRealTimers();
  }
});
