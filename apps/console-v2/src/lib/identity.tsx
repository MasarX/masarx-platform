// identity.tsx - current user, scope, capabilities, and auth state.
//
// The 4-tier `access_scope_type` model and the helpers below mirror the backend
// SSOT in `supabase/migrations/202512291310_users_access_scope_model.sql`:
//
//   Backend SQL helper          | Frontend equivalent on `useIdentity()`
//   ----------------------------|---------------------------------------------
//   is_platform_user()          | isPlatformUser()
//   current_user_scope_type()   | currentScopeType()
//   current_user_scope_id()     | currentScopeId()
//   current_user_org_id()       | currentTenantId()  (active tenant lens)
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as ds from './data-source';
import {
  getConsoleAuthClient,
  hydrateConsoleIdentity,
  type ConsoleAuthStatus,
  type ConsoleIdentitySnapshot,
} from './auth';
import { hasWildcardCapability } from './capabilities';
import {
  assertValidUserAccessScope,
  type AccessScopeType,
  type Capability,
  type CurrentUserContext,
  type Id,
  type Scope,
  type User,
} from '../types/domain';

interface IdentityCtx extends CurrentUserContext {
  authStatus: ConsoleAuthStatus;
  authError: string | null;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  refreshSession: () => Promise<void>;
  hasCapability: (cap: Capability | null | undefined) => boolean;
  setRole: (roleId: string) => void;
  switchScope: (scope: Partial<Scope>) => void;
  isPlatformUser: () => boolean;
  isTenantUser: () => boolean;
  /** True when the user is client- or sender-scoped (Portal users). */
  isPortalUser: () => boolean;
  currentScopeType: () => AccessScopeType;
  currentScopeId: () => Id | null;
  /** The user's home org id (`users.organization_id`). */
  currentTenantId: () => Id;
}

export type { AccessScopeType };

const Ctx = createContext<IdentityCtx | null>(null);

const ANONYMOUS_USER: User = {
  id: '',
  name: '',
  role: '',
  capabilities: [],
  access_scope_type: 'tenant',
  access_scope_id: null,
  organization_id: '',
};

const EMPTY_SCOPE: Scope = {};
const ACTIVE_TENANT_SCOPE_STORAGE_PREFIX = 'nzxmhryhtqlzoshjkyozkpup.example.invalidnsoleV2.activeTenantScope.';

function activeTenantScopeStorageKey(userId: Id): string {
  return `${ACTIVE_TENANT_SCOPE_STORAGE_PREFIX}${userId}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readPersistedActiveTenantScope(user: User): Scope | null {
  if (user.access_scope_type !== 'platform' || !user.id) return null;
  const store = storage();
  if (!store) return null;

  try {
    const raw = store.getItem(activeTenantScopeStorageKey(user.id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Scope> | null;
    const tenant = parsed?.tenant;
    if (!tenant || typeof tenant.id !== 'string' || tenant.id.trim().length === 0) return null;
    return {
      tenant: {
        id: tenant.id,
        label:
          typeof tenant.label === 'string' && tenant.label.trim().length > 0
            ? tenant.label
            : tenant.id,
        rank: typeof tenant.rank === 'number' ? tenant.rank : 2,
      },
    };
  } catch {
    return null;
  }
}

function persistActiveTenantScope(user: User, scope: Scope): void {
  if (user.access_scope_type !== 'platform' || !user.id) return;
  const store = storage();
  if (!store) return;

  const key = activeTenantScopeStorageKey(user.id);
  const tenant = scope.tenant;
  if (!tenant?.id) {
    store.removeItem(key);
    return;
  }
  store.setItem(
    key,
    JSON.stringify({
      tenant: {
        id: tenant.id,
        label: tenant.label ?? tenant.id,
        rank: tenant.rank ?? 2,
      },
    }),
  );
}

function clearPersistedActiveTenantScopes(): void {
  const store = storage();
  if (!store) return;

  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key?.startsWith(ACTIVE_TENANT_SCOPE_STORAGE_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => store.removeItem(key));
}

interface LiveIdentityState {
  authStatus: ConsoleAuthStatus;
  authError: string | null;
  snapshot: ConsoleIdentitySnapshot | null;
}

function _resolveScopeFromUser(u: Partial<User> | undefined | null): {
  type: AccessScopeType;
  id: Id | null;
  organization_id: Id;
} {
  const type = (u?.access_scope_type ?? 'tenant') as AccessScopeType;
  const id = u?.access_scope_id ?? null;
  const organization_id = u?.organization_id ?? '';
  assertValidUserAccessScope(type, id);
  return { type, id, organization_id };
}

export interface IdentityProviderMockValue {
  user?: Partial<User>;
  scope?: Scope;
  capabilities?: Capability[];
  authStatus?: ConsoleAuthStatus;
  authError?: string | null;
  refreshSession?: () => Promise<void>;
}

export interface IdentityProviderProps {
  children: ReactNode;
  /**
   * Test/storybook override. Production leaves this undefined and uses either
   * Supabase live auth or the seed data-source fallback.
   */
  mockValue?: IdentityProviderMockValue;
}

export function IdentityProvider({ children, mockValue }: IdentityProviderProps) {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const refreshSessionInFlight = useRef<Promise<void> | null>(null);
  const [liveIdentity, setLiveIdentity] = useState<LiveIdentityState>(() => ({
    authStatus: getConsoleAuthClient() ? 'loading' : 'authenticated',
    authError: null,
    snapshot: null,
  }));
  const [liveScopeOverride, setLiveScopeOverride] = useState<Scope | null>(null);

  const refreshSession = useCallback(async () => {
    if (refreshSessionInFlight.current) {
      return refreshSessionInFlight.current;
    }
    const client = getConsoleAuthClient();
    if (!client) {
      bump();
      return;
    }

    setLiveIdentity((prev) => ({
      ...prev,
      authStatus: 'loading',
      authError: null,
    }));

    const run = (async () => {
      try {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        if (!data.session) {
          clearPersistedActiveTenantScopes();
          setLiveScopeOverride(null);
          setLiveIdentity({
            authStatus: 'unauthenticated',
            authError: null,
            snapshot: null,
          });
          return;
        }
        const snapshot = await hydrateConsoleIdentity();
        setLiveScopeOverride(readPersistedActiveTenantScope(snapshot.user));
        setLiveIdentity({
          authStatus: 'authenticated',
          authError: null,
          snapshot,
        });
      } catch (error) {
        setLiveScopeOverride(null);
        setLiveIdentity({
          authStatus: 'error',
          authError: (error as Error).message || 'Unable to hydrate Console session',
          snapshot: null,
        });
      }
    })();
    refreshSessionInFlight.current = run;
    try {
      await run;
    } finally {
      if (refreshSessionInFlight.current === run) {
        refreshSessionInFlight.current = null;
      }
    }
  }, [bump]);

  const value = useMemo<IdentityCtx>(() => {
    if (mockValue) {
      const caps = mockValue.capabilities ?? [];
      const capSet = new Set(caps);
      const liveUser = ds.getCurrentUser() as unknown as User;
      const overrideUser = mockValue.user ?? {};
      const scopeFields = _resolveScopeFromUser({
        access_scope_type: overrideUser.access_scope_type ?? liveUser?.access_scope_type,
        access_scope_id: overrideUser.access_scope_id ?? liveUser?.access_scope_id,
        organization_id: overrideUser.organization_id ?? liveUser?.organization_id,
      });
      const baseUser: User = {
        id: liveUser?.id ?? 'usr_test',
        name: liveUser?.name ?? 'Test User',
        role: liveUser?.role ?? '',
        capabilities: caps,
        access_scope_type: scopeFields.type,
        access_scope_id: scopeFields.id,
        organization_id: scopeFields.organization_id,
        ...(liveUser?.initials !== undefined ? { initials: liveUser.initials } : {}),
        ...(liveUser?.email !== undefined ? { email: liveUser.email } : {}),
      };
      const user: User = {
        ...baseUser,
        ...overrideUser,
        access_scope_type: scopeFields.type,
        access_scope_id: scopeFields.id,
        organization_id: scopeFields.organization_id,
        capabilities: caps,
      };
      const scope: Scope = mockValue.scope ?? (ds.getCurrentScope() as unknown as Scope) ?? {};
      const authStatus = mockValue.authStatus ?? 'authenticated';
      return {
        user,
        scope,
        capabilities: caps,
        authStatus,
        authError: mockValue.authError ?? null,
        isAuthenticated: authStatus === 'authenticated',
        isAuthLoading: authStatus === 'loading',
        refreshSession: mockValue.refreshSession ?? (async () => {}),
        hasCapability: (cap) => {
          if (!cap) return true;
          if (authStatus !== 'authenticated') return false;
          if (hasWildcardCapability(capSet)) return true;
          return capSet.has(cap);
        },
        setRole: () => bump(),
        switchScope: () => bump(),
        isPlatformUser: () => user.access_scope_type === 'platform',
        isTenantUser: () => user.access_scope_type === 'tenant',
        isPortalUser: () =>
          user.access_scope_type === 'client' || user.access_scope_type === 'sender',
        currentScopeType: () => user.access_scope_type,
        currentScopeId: () => user.access_scope_id,
        currentTenantId: () => scope.tenant?.id ?? user.organization_id,
      };
    }

    if (getConsoleAuthClient()) {
      const snapshot = liveIdentity.snapshot;
      const user = snapshot?.user ?? ANONYMOUS_USER;
      const baseScope = snapshot?.scope ?? EMPTY_SCOPE;
      const scope = liveScopeOverride ? { ...baseScope, ...liveScopeOverride } : baseScope;
      const capabilities = snapshot?.capabilities ?? [];
      const capSet = new Set(capabilities);
      return {
        user,
        scope,
        capabilities,
        authStatus: liveIdentity.authStatus,
        authError: liveIdentity.authError,
        isAuthenticated: liveIdentity.authStatus === 'authenticated',
        isAuthLoading: liveIdentity.authStatus === 'loading',
        refreshSession,
        hasCapability: (cap) => {
          if (!cap) return true;
          if (liveIdentity.authStatus !== 'authenticated') return false;
          if (hasWildcardCapability(capSet)) return true;
          return capSet.has(cap);
        },
        setRole: () => {},
        switchScope: (next) => {
          setLiveScopeOverride((prev) => {
            const merged = { ...(prev ?? baseScope), ...next };
            persistActiveTenantScope(user, merged);
            return merged;
          });
        },
        isPlatformUser: () => user.access_scope_type === 'platform',
        isTenantUser: () => user.access_scope_type === 'tenant',
        isPortalUser: () =>
          user.access_scope_type === 'client' || user.access_scope_type === 'sender',
        currentScopeType: () => user.access_scope_type,
        currentScopeId: () => user.access_scope_id,
        currentTenantId: () => scope.tenant?.id ?? user.organization_id,
      };
    }

    const user = ds.getCurrentUser() as unknown as User;
    const scope = ds.getCurrentScope() as unknown as Scope;
    const capabilities = ds.getCapabilities() as Capability[];
    return {
      user,
      scope,
      capabilities,
      authStatus: 'authenticated',
      authError: null,
      isAuthenticated: true,
      isAuthLoading: false,
      refreshSession: async () => {
        bump();
      },
      hasCapability: (cap) => ds.hasCapability(cap),
      setRole: (roleId) => {
        ds.setRole(roleId);
        bump();
      },
      switchScope: (next) => {
        Object.assign(ds.getCurrentScope(), next);
        bump();
      },
      isPlatformUser: () => user.access_scope_type === 'platform',
      isTenantUser: () => user.access_scope_type === 'tenant',
      isPortalUser: () =>
        user.access_scope_type === 'client' || user.access_scope_type === 'sender',
      currentScopeType: () => user.access_scope_type ?? 'tenant',
      currentScopeId: () => user.access_scope_id ?? null,
      currentTenantId: () => user.organization_id ?? '',
    };
  }, [tick, bump, mockValue, liveIdentity, liveScopeOverride, refreshSession]);

  useEffect(() => {
    if (mockValue) return undefined;
    const client = getConsoleAuthClient();
    if (!client) return undefined;

    void refreshSession();
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (_event === 'SIGNED_OUT' || !session) {
        clearPersistedActiveTenantScopes();
        setLiveScopeOverride(null);
        setLiveIdentity({
          authStatus: 'unauthenticated',
          authError: null,
          snapshot: null,
        });
        return;
      }
      void refreshSession();
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, [mockValue, refreshSession]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useIdentity() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useIdentity outside IdentityProvider');
  return ctx;
}

export function useCapability(cap: Capability | null | undefined) {
  return useIdentity().hasCapability(cap);
}
