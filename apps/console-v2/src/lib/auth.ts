// auth.ts - Console V2 Supabase auth/session seam.
//
// The frontend authenticates through Supabase Auth, then hydrates Console
// identity from the canonical api.ui_me_v1 RPC. The shell and guards consume
// only the normalized User/Scope/Capability shape from this file.
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient, rpc } from './supabase';
import {
  assertValidUserAccessScope,
  type AccessScopeType,
  type Capability,
  type Scope,
  type User,
} from '../types/domain';

export const CONSOLE_LOGIN_PATH = '/login';
export const CONSOLE_AUTH_CALLBACK_PATH = '/auth/callback';
export const CONSOLE_AUTH_REDIRECT_STORAGE_KEY = 'console-v2.auth.redirect-to';

export type ConsoleAuthStatus =
  | 'loading'
  | 'authenticated'
  | 'unauthenticated'
  | 'error';

export interface ConsoleIdentitySnapshot {
  user: User;
  scope: Scope;
  capabilities: Capability[];
}

export interface UiMePayload {
  user?: Record<string, unknown> | null;
  org?: Record<string, unknown> | null;
  access_scope?: Record<string, unknown> | null;
  capabilities?: unknown;
  roles?: unknown;
  role_keys?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function normalizeAccessScopeType(value: unknown): AccessScopeType {
  if (
    value === 'platform' ||
    value === 'tenant' ||
    value === 'client' ||
    value === 'sender'
  ) {
    return value;
  }
  throw new Error(`Unsupported Console access scope: ${String(value ?? '')}`);
}

function normalizeCapabilities(value: unknown): Capability[] {
  return readStringArray(value) as Capability[];
}

function buildScope(args: {
  accessScopeType: AccessScopeType;
  accessScopeId: string | null;
  accessScopeLabel?: string;
  orgId: string;
  orgName?: string;
}): Scope {
  const scope: Scope = {};
  if (args.accessScopeType === 'platform') {
    scope.global = { id: 'platform', label: 'Platform', rank: 1 };
  }
  if (args.orgId) {
    scope.tenant = { id: args.orgId, label: args.orgName, rank: 2 };
  }
  if (args.accessScopeType === 'client' && args.accessScopeId) {
    scope.client = {
      id: args.accessScopeId,
      label: args.accessScopeLabel,
      rank: 3,
    };
  }
  if (args.accessScopeType === 'sender' && args.accessScopeId) {
    scope.sender = {
      id: args.accessScopeId,
      label: args.accessScopeLabel,
      rank: 4,
    };
  }
  return scope;
}

export function normalizeUiMePayload(payload: UiMePayload): ConsoleIdentitySnapshot {
  const userPayload = asRecord(payload.user);
  const orgPayload = asRecord(payload.org);
  const accessScopePayload = asRecord(payload.access_scope);

  const accessScopeType = normalizeAccessScopeType(
    accessScopePayload.scope_type ?? userPayload.access_scope_type,
  );
  const accessScopeId = nullableString(
    accessScopePayload.scope_id ?? userPayload.access_scope_id,
  );
  assertValidUserAccessScope(accessScopeType, accessScopeId);

  const orgId = asString(orgPayload.id ?? userPayload.organization_id);
  const orgName = asString(orgPayload.name);
  const capabilities = normalizeCapabilities(payload.capabilities);
  const roleKeys = readStringArray(payload.role_keys ?? payload.roles);
  const userType = asString(userPayload.user_type);
  const role = roleKeys[0] ?? userType;
  const name =
    asString(userPayload.name) ||
    asString(userPayload.full_name) ||
    asString(userPayload.email, 'Console user');

  const user: User = {
    id: asString(userPayload.id),
    name,
    email: asString(userPayload.email) || undefined,
    role,
    capabilities,
    access_scope_type: accessScopeType,
    access_scope_id: accessScopeId,
    organization_id: orgId,
    status: asString(userPayload.status) || undefined,
  };

  if (!user.id) throw new Error('Console identity is missing user.id');
  if (!user.organization_id) {
    throw new Error('Console identity is missing organization_id');
  }

  return {
    user,
    capabilities,
    scope: buildScope({
      accessScopeType,
      accessScopeId,
      accessScopeLabel: asString(accessScopePayload.scope_label),
      orgId,
      orgName,
    }),
  };
}

export function getConsoleAuthClient() {
  return getSupabaseClient();
}

export function isConsoleAuthRoute(pathname: string): boolean {
  return pathname === CONSOLE_LOGIN_PATH || pathname.startsWith('/auth/');
}

function isSafeConsoleRedirect(path: string): boolean {
  try {
    const parsed = new URL(path, 'https://console.local');
    return (
      parsed.origin === 'https://console.local' &&
      path.startsWith('/') &&
      parsed.pathname.startsWith('/') &&
      !path.startsWith('//') &&
      !parsed.pathname.startsWith('//') &&
      !isConsoleAuthRoute(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function getCurrentConsolePath(): string {
  if (typeof window === 'undefined') return '/';
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return isConsoleAuthRoute(window.location.pathname) ? '/' : current;
}

export function rememberConsoleAuthRedirect(path = getCurrentConsolePath()): void {
  if (typeof window === 'undefined') return;
  const safePath = isSafeConsoleRedirect(path) ? path : '/';
  try {
    window.localStorage.setItem(CONSOLE_AUTH_REDIRECT_STORAGE_KEY, safePath);
  } catch {
    /* ignore storage failures */
  }
}

export function consumeConsoleAuthRedirect(): string {
  if (typeof window === 'undefined') return '/';
  try {
    const stored = window.localStorage.getItem(CONSOLE_AUTH_REDIRECT_STORAGE_KEY);
    window.localStorage.removeItem(CONSOLE_AUTH_REDIRECT_STORAGE_KEY);
    return stored && isSafeConsoleRedirect(stored) ? stored : '/';
  } catch {
    return '/';
  }
}

export function clearConsoleAuthRedirect(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CONSOLE_AUTH_REDIRECT_STORAGE_KEY);
  } catch {
    /* ignore storage failures */
  }
}

export function getConsoleAuthRedirectUrl(): string {
  const configured = import.meta.env.VITE_AUTH_REDIRECT_URL as string | undefined;
  if (configured) return configured;
  if (typeof window === 'undefined') return CONSOLE_AUTH_CALLBACK_PATH;
  return `${window.location.origin}${CONSOLE_AUTH_CALLBACK_PATH}`;
}

function authCallbackParams(url: URL): URLSearchParams[] {
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  return [
    url.searchParams,
    hash ? new URLSearchParams(hash) : new URLSearchParams(),
  ];
}

function authCallbackError(paramsList: URLSearchParams[]): string | null {
  for (const params of paramsList) {
    const error = params.get('error_description') ?? params.get('error');
    if (error) return error;
  }
  return null;
}

function authCallbackTokenPair(paramsList: URLSearchParams[]): {
  accessToken: string;
  refreshToken: string;
} | null {
  for (const params of paramsList) {
    const accessToken = params.get('access_token')?.trim();
    const refreshToken = params.get('refresh_token')?.trim();
    if (accessToken && refreshToken) return { accessToken, refreshToken };
  }
  return null;
}

export async function signInConsoleWithPassword(args: {
  email: string;
  password: string;
}): Promise<Session | null> {
  const client = getConsoleAuthClient();
  if (!client) throw new Error('Supabase auth is not configured for Console V2');
  const { data, error } = await client.auth.signInWithPassword({
    email: args.email.trim(),
    password: args.password,
  });
  if (error) throw error;
  return data.session ?? null;
}

export async function sendConsoleMagicLink(email: string): Promise<void> {
  const client = getConsoleAuthClient();
  if (!client) throw new Error('Supabase auth is not configured for Console V2');
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: getConsoleAuthRedirectUrl() },
  });
  if (error) throw error;
}

export async function completeConsoleAuthCallback(): Promise<Session | null> {
  const client = getConsoleAuthClient();
  if (!client) throw new Error('Supabase auth is not configured for Console V2');
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    const paramsList = authCallbackParams(url);
    const callbackError = authCallbackError(paramsList);
    if (callbackError) throw new Error(callbackError);
    const code = url.searchParams.get('code');
    if (code) {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error) throw error;
      if (!data.session) throw new Error('Sign-in link did not return a Console session');
      return data.session;
    }
    const tokenPair = authCallbackTokenPair(paramsList);
    if (tokenPair) {
      const { data, error } = await client.auth.setSession({
        access_token: tokenPair.accessToken,
        refresh_token: tokenPair.refreshToken,
      });
      if (error) throw error;
      if (!data.session) throw new Error('Sign-in link did not return a Console session');
      return data.session;
    }
  }
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error('Sign-in link did not return a Console session');
  return data.session;
}

export async function hydrateConsoleIdentity(): Promise<ConsoleIdentitySnapshot> {
  const payload = await rpc<UiMePayload>('ui_me_v1');
  if (!payload) throw new Error('Console identity RPC returned no payload');
  return normalizeUiMePayload(payload);
}

export async function signOutConsole(): Promise<void> {
  const client = getConsoleAuthClient();
  if (!client) throw new Error('Supabase auth is not configured for Console V2');
  const { error } = await client.auth.signOut();
  if (error) throw error;
  clearConsoleAuthRedirect();
}
