// identity.test.tsx — exercises the identity context and the 4-tier
// `access_scope_type` model defined in
// `supabase/migrations/202512291310_users_access_scope_model.sql`.
//
// Coverage:
//   1. useCapability returns true/false based on the active capability set.
//   2. setRole flips capabilities to the canonical backend role's grant set.
//   3. setRole flips access_scope_type AND keeps access_scope_id consistent
//      with the backend `users_access_scope_consistency_check` constraint.
//   4. isPlatformUser / isTenantUser / isPortalUser return the right tier.
//   5. currentScopeId returns NULL for platform/tenant and the bound id for
//      client/sender.
//   6. The runtime type guard rejects illegal (scope_type, scope_id) pairs
//      mirroring the backend constraint.
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  IdentityProvider,
  useCapability,
  useIdentity,
  type AccessScopeType,
} from './identity';
import {
  isValidUserAccessScope,
  assertValidUserAccessScope,
} from '../types/domain';

const allWrapper = ({ children }: { children: React.ReactNode }) => (
  <IdentityProvider mockValue={{ capabilities: ['all'] }}>{children}</IdentityProvider>
);

const backendWildcardWrapper = ({ children }: { children: React.ReactNode }) => (
  <IdentityProvider mockValue={{ capabilities: ['*'] }}>{children}</IdentityProvider>
);

const noneWrapper = ({ children }: { children: React.ReactNode }) => (
  <IdentityProvider mockValue={{ capabilities: ['shipments.read'] }}>{children}</IdentityProvider>
);

const liveWrapper = ({ children }: { children: React.ReactNode }) => (
  <IdentityProvider>{children}</IdentityProvider>
);

function tierWrapper(
  tier: AccessScopeType,
  scopeId: string | null,
  caps: string[] = ['shipments.read'],
) {
  return ({ children }: { children: React.ReactNode }) => (
    <IdentityProvider
      mockValue={{
        user: { access_scope_type: tier, access_scope_id: scopeId },
        capabilities: caps,
      }}
    >
      {children}
    </IdentityProvider>
  );
}

describe('lib/identity — capabilities', () => {
  it('useCapability returns true when the user holds the capability', () => {
    const { result } = renderHook(() => useCapability('shipments.read'), {
      wrapper: noneWrapper,
    });
    expect(result.current).toBe(true);
  });

  it('useCapability returns false when the user lacks the capability', () => {
    const { result } = renderHook(() => useCapability('finance.write'), {
      wrapper: noneWrapper,
    });
    expect(result.current).toBe(false);
  });

  it('granting "all" allows every capability check (super_admin wildcard)', () => {
    const { result } = renderHook(() => useCapability('any.weird.capability'), {
      wrapper: allWrapper,
    });
    expect(result.current).toBe(true);
  });

  it('granting backend "*" allows every capability check (live super_admin wildcard)', () => {
    const { result } = renderHook(() => useCapability('finance.write'), {
      wrapper: backendWildcardWrapper,
    });
    expect(result.current).toBe(true);
  });

  it('setRole switches capabilities to the chosen canonical backend role', () => {
    // Use the live IdentityProvider (no mockValue) so setRole has effect.
    const { result } = renderHook(() => useIdentity(), { wrapper: liveWrapper });
    // Default seed user is super_admin → has 'all'.
    expect(result.current.hasCapability('finance.read')).toBe(true);

    // account_manager (rank 3, tenant) does not include finance.read in its
    // backend capability grant (see migration 202601022113 lines 247-255).
    act(() => result.current.setRole('account_manager'));
    expect(result.current.hasCapability('finance.read')).toBe(false);
    // …but it does include clients.read.
    expect(result.current.hasCapability('clients.read')).toBe(true);

    // Restore so subsequent tests see the default platform posture.
    act(() => result.current.setRole('super_admin'));
  });

  it('canonical access_policy.read capability is held by ops_admin and account_manager (not by client_admin)', () => {
    // Mirrors the canonical backend grant in
    // supabase/migrations/202601022113_access_control_policy_core.sql:209,228+,247+.
    // FE seed must use the canonical key `access_policy.read` (not the legacy
    // alias `access.read`).
    const { result } = renderHook(() => useIdentity(), { wrapper: liveWrapper });

    act(() => result.current.setRole('ops_admin'));
    expect(result.current.hasCapability('access_policy.read')).toBe(true);
    // Legacy alias must NOT leak — it should fail-closed.
    expect(result.current.hasCapability('access.read')).toBe(false);

    act(() => result.current.setRole('account_manager'));
    expect(result.current.hasCapability('access_policy.read')).toBe(true);
    expect(result.current.hasCapability('access.read')).toBe(false);

    act(() => result.current.setRole('client_admin'));
    // client_admin has no access policy admin capability.
    expect(result.current.hasCapability('access_policy.read')).toBe(false);

    // Restore.
    act(() => result.current.setRole('super_admin'));
  });

  it('tenant_signup_requests capabilities mirror the demo registry posture: ops_admin (R + review), account_manager (R-only), client_admin (none)', () => {
    // Backend canonical SSOT:
    //   supabase/migrations/202602201020_access_control_policy_tenant_signup_requests_v1.sql:38-66
    //   (capabilities `tenant_signup_requests.read` + `tenant_signup_requests.review`).
    // Demo seed posture intentionally narrows account_manager to read-only
    // (consistent with billing/branches/support/alerts/feature_flags/api_gateway
    // narrowing in seed.js); ops_admin keeps the full review surface.
    const { result } = renderHook(() => useIdentity(), { wrapper: liveWrapper });

    act(() => result.current.setRole('ops_admin'));
    // Positive: ops_admin can both read AND review.
    expect(result.current.hasCapability('tenant_signup_requests.read')).toBe(true);
    expect(result.current.hasCapability('tenant_signup_requests.review')).toBe(true);

    act(() => result.current.setRole('account_manager'));
    // Positive: account_manager can read.
    expect(result.current.hasCapability('tenant_signup_requests.read')).toBe(true);
    // Negative: account_manager cannot review (read-only review surface).
    expect(result.current.hasCapability('tenant_signup_requests.review')).toBe(false);

    act(() => result.current.setRole('client_admin'));
    // Negative: portal users have no access to the platform tenant signup queue.
    expect(result.current.hasCapability('tenant_signup_requests.read')).toBe(false);
    expect(result.current.hasCapability('tenant_signup_requests.review')).toBe(false);

    // Restore.
    act(() => result.current.setRole('super_admin'));
  });
});

describe('lib/identity — access scope helpers (4-tier model)', () => {
  it('isPlatformUser is true ONLY for platform scope', () => {
    const platform = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('platform', null),
    });
    expect(platform.result.current.isPlatformUser()).toBe(true);
    expect(platform.result.current.isTenantUser()).toBe(false);
    expect(platform.result.current.isPortalUser()).toBe(false);

    const tenant = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('tenant', null),
    });
    expect(tenant.result.current.isPlatformUser()).toBe(false);

    const client = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('client', 'cl_test_1'),
    });
    expect(client.result.current.isPlatformUser()).toBe(false);
  });

  it('isTenantUser is true ONLY for tenant scope', () => {
    const tenant = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('tenant', null),
    });
    expect(tenant.result.current.isTenantUser()).toBe(true);
    expect(tenant.result.current.isPlatformUser()).toBe(false);
    expect(tenant.result.current.isPortalUser()).toBe(false);
  });

  it('isPortalUser is true for client AND sender (and false for platform/tenant)', () => {
    const client = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('client', 'cl_test_1'),
    });
    expect(client.result.current.isPortalUser()).toBe(true);

    const sender = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('sender', 'snd_test_1'),
    });
    expect(sender.result.current.isPortalUser()).toBe(true);

    const platform = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('platform', null),
    });
    expect(platform.result.current.isPortalUser()).toBe(false);

    const tenant = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('tenant', null),
    });
    expect(tenant.result.current.isPortalUser()).toBe(false);
  });

  it('currentScopeId returns NULL for platform/tenant and the bound id for client/sender', () => {
    const platform = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('platform', null),
    });
    expect(platform.result.current.currentScopeId()).toBeNull();
    expect(platform.result.current.currentScopeType()).toBe('platform');

    const tenant = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('tenant', null),
    });
    expect(tenant.result.current.currentScopeId()).toBeNull();
    expect(tenant.result.current.currentScopeType()).toBe('tenant');

    const client = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('client', 'cl_exampleparcel_ksa'),
    });
    expect(client.result.current.currentScopeId()).toBe('cl_exampleparcel_ksa');
    expect(client.result.current.currentScopeType()).toBe('client');

    const sender = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('sender', 'snd_exampleparcel_jed'),
    });
    expect(sender.result.current.currentScopeId()).toBe('snd_exampleparcel_jed');
    expect(sender.result.current.currentScopeType()).toBe('sender');
  });

  it('currentTenantId follows the active tenant lens when one is selected', () => {
    const { result } = renderHook(() => useIdentity(), {
      wrapper: tierWrapper('platform', null),
    });
    expect(result.current.currentTenantId()).toBe('org_rashed');
  });
});

describe('lib/identity — runtime type guard (mirrors users_access_scope_consistency_check)', () => {
  it('isValidUserAccessScope accepts platform/tenant with NULL scope_id', () => {
    expect(isValidUserAccessScope('platform', null)).toBe(true);
    expect(isValidUserAccessScope('tenant', null)).toBe(true);
  });

  it('isValidUserAccessScope rejects platform/tenant with a non-null scope_id', () => {
    expect(isValidUserAccessScope('platform', 'cl_oops')).toBe(false);
    expect(isValidUserAccessScope('tenant', 'snd_nope')).toBe(false);
  });

  it('isValidUserAccessScope accepts client/sender with non-null scope_id', () => {
    expect(isValidUserAccessScope('client', 'cl_exampleparcel_ksa')).toBe(true);
    expect(isValidUserAccessScope('sender', 'snd_exampleparcel_jed')).toBe(true);
  });

  it('isValidUserAccessScope rejects client/sender with NULL scope_id', () => {
    expect(isValidUserAccessScope('client', null)).toBe(false);
    expect(isValidUserAccessScope('sender', null)).toBe(false);
  });

  it('assertValidUserAccessScope throws on inconsistent shapes', () => {
    expect(() => assertValidUserAccessScope('platform', 'cl_oops')).toThrow(
      /access_scope_id must be NULL/,
    );
    expect(() => assertValidUserAccessScope('client', null)).toThrow(
      /access_scope_id must be set/,
    );
    // Valid shapes do not throw.
    expect(() => assertValidUserAccessScope('platform', null)).not.toThrow();
    expect(() => assertValidUserAccessScope('client', 'cl_exampleparcel_ksa')).not.toThrow();
  });
});

describe('lib/identity — setRole + access scope (live data-source)', () => {
  it('setRole(super_admin) → platform tier with NULL scope_id', () => {
    const { result } = renderHook(() => useIdentity(), { wrapper: liveWrapper });
    act(() => result.current.setRole('super_admin'));
    expect(result.current.currentScopeType()).toBe('platform');
    expect(result.current.currentScopeId()).toBeNull();
    expect(result.current.isPlatformUser()).toBe(true);
  });

  it('setRole(ops_admin) → tenant tier with NULL scope_id', () => {
    const { result } = renderHook(() => useIdentity(), { wrapper: liveWrapper });
    act(() => result.current.setRole('ops_admin'));
    expect(result.current.currentScopeType()).toBe('tenant');
    expect(result.current.currentScopeId()).toBeNull();
    expect(result.current.isTenantUser()).toBe(true);

    // Restore default for other test files.
    act(() => result.current.setRole('super_admin'));
  });

  it('setRole(client_admin) → client tier with non-null scope_id', () => {
    const { result } = renderHook(() => useIdentity(), { wrapper: liveWrapper });
    act(() => result.current.setRole('client_admin'));
    expect(result.current.currentScopeType()).toBe('client');
    expect(result.current.currentScopeId()).toBe('cl_exampleparcel_ksa');
    expect(result.current.isPortalUser()).toBe(true);

    // Restore default.
    act(() => result.current.setRole('super_admin'));
  });

  it('setRole(sender_user) → sender tier with non-null scope_id', () => {
    const { result } = renderHook(() => useIdentity(), { wrapper: liveWrapper });
    act(() => result.current.setRole('sender_user'));
    expect(result.current.currentScopeType()).toBe('sender');
    expect(result.current.currentScopeId()).toBe('snd_exampleparcel_jed');
    expect(result.current.isPortalUser()).toBe(true);

    // Restore default.
    act(() => result.current.setRole('super_admin'));
  });
});
