import { afterEach, describe, expect, it, vi } from 'vitest';

describe('data-source live-mode fail-closed guards', () => {
  afterEach(() => {
    vi.doUnmock('./seed-loader');
    vi.doUnmock('./supabase');
    vi.resetModules();
  });

  it('does not return a synthetic marketplace participant review success when the live client is missing', async () => {
    vi.resetModules();
    vi.doMock('./seed-loader', () => ({ seed: {}, SEED_MODE_ENABLED: false }));
    vi.doMock('./supabase', () => ({ getSupabaseClient: () => null }));

    const liveDs = await import('./data-source');
    await expect(
      liveDs.marketplace_participant_request_review_apply_v1({
        participant_request_id: 'mpr_drv_4421',
        decision: 'approve',
      }),
    ).rejects.toThrow(/VITE_USE_SEED=false disables Console V2 seed fallbacks/i);
  });

  it('does not return a synthetic task transition success when the live client is missing', async () => {
    vi.resetModules();
    vi.doMock('./seed-loader', () => ({ seed: {}, SEED_MODE_ENABLED: false }));
    vi.doMock('./supabase', () => ({ getSupabaseClient: () => null }));

    const liveDs = await import('./data-source');
    await expect(
      liveDs.transition_task_v1('00000000-0000-4000-8000-000000000101', {
        next_status: 'completed',
      }),
    ).rejects.toThrow(/VITE_USE_SEED=false disables Console V2 seed fallbacks/i);
  });
});
