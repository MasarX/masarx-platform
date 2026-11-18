// supabase.test.ts — coverage for the swap-seam factory.
//
// Confirms the contract the data-source.ts swap-seam relies on:
//   - returns null when env vars are absent (so adapters branch to in-memory),
//   - returns a non-null client when env vars are set (so adapters route via
//     supabase.rpc()),
//   - memoizes across consecutive calls (so a single SupabaseClient instance
//     is shared across the app — including auth/realtime channels),
//   - the test-only reset helper clears memoization.
//
// We mock @supabase/supabase-js so the factory can be exercised without a
// real network round-trip; vi.stubEnv drives the import.meta.env signal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: vi.fn((url: string, key: string) => ({
      __mock: true,
      url,
      key,
      rpc: vi.fn(),
      from: vi.fn(),
      auth: { getSession: vi.fn() },
    })),
  };
});

import { createClient } from '@supabase/supabase-js';
import {
  __resetSupabaseClientForTests,
  getSupabaseClient,
} from '../supabase';

describe('lib/supabase — getSupabaseClient swap-seam', () => {
  beforeEach(() => {
    __resetSupabaseClientForTests();
    vi.mocked(createClient).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSupabaseClientForTests();
  });

  it('returns null when VITE_SUPABASE_URL is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'some-anon-key');

    expect(getSupabaseClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns null when VITE_SUPABASE_ANON_KEY is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    expect(getSupabaseClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns null when both env vars are missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    expect(getSupabaseClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns a non-null client when both env vars are set', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-xyz');

    const client = getSupabaseClient();

    expect(client).not.toBeNull();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key-xyz',
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'pkce',
          storageKey: 'masarx-console-v2-auth',
        }),
        db: { schema: 'api' },
        global: expect.objectContaining({
          headers: expect.objectContaining({ 'x-client-info': 'console-v2' }),
        }),
      }),
    );
  });

  it('memoizes the client across consecutive calls', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-xyz');

    const first = getSupabaseClient();
    const second = getSupabaseClient();
    const third = getSupabaseClient();

    expect(first).not.toBeNull();
    expect(first).toBe(second);
    expect(second).toBe(third);
    // createClient must only run on the first call — subsequent calls hit cache.
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('memoizes the null result so absent env does not re-read every call', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    const first = getSupabaseClient();
    const second = getSupabaseClient();

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('__resetSupabaseClientForTests clears memoization so the factory re-reads env', () => {
    // First call: env unset -> null cached.
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    expect(getSupabaseClient()).toBeNull();

    // Set env, but without reset the memoized null still wins.
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-xyz');
    expect(getSupabaseClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();

    // Reset clears the cache; next call re-reads env and constructs the client.
    __resetSupabaseClientForTests();
    const client = getSupabaseClient();
    expect(client).not.toBeNull();
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  // W41 F6 path-a (pivot): under vitest, when both env vars are set, the factory
  // constructs a real client just like production. MSW handlers are the SSOT for
  // intercepting the canonical RPC contract — not a vitest-only short-circuit.
  it('constructs the live client under vitest when env vars are set (W41 path-a)', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-xyz');

    const client = getSupabaseClient();

    expect(client).not.toBeNull();
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
