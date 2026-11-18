import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConsoleNavigator } from './useConsoleNavigator';

const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

describe('useConsoleNavigator', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    window.history.pushState(null, '', '/');
  });

  it('normalizes hash routes before navigating through the router', () => {
    const { result } = renderHook(() => useConsoleNavigator());

    act(() => result.current('#/operate/amend-cancel'));

    expect(navigateMock).toHaveBeenCalledWith({ to: '/operate/amend-cancel', search: {} });
  });

  it('normalizes legacy resource routes before navigating through the router', () => {
    const { result } = renderHook(() => useConsoleNavigator());

    act(() => result.current('/console/resources/shipments?focus=SHP-1'));

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/operate/shipments',
      search: { focus: 'SHP-1' },
    });
  });

  it('does not mutate browser history when router navigation reports success', async () => {
    navigateMock.mockReturnValue(Promise.resolve());
    const { result } = renderHook(() => useConsoleNavigator());

    act(() => {
      result.current('/platform/onboarding-readiness?scope_type=tenant&scope_id=org_ready');
    });

    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('does not apply a URL-only fallback while router navigation is still pending', async () => {
    navigateMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useConsoleNavigator());

    act(() => {
      result.current('/integrations/mapping?focus=map_live');
    });

    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('falls back to browser history only when router navigation rejects', async () => {
    navigateMock.mockReturnValue(Promise.reject(new Error('router rejected')));
    const { result } = renderHook(() => useConsoleNavigator());

    act(() => {
      result.current('/integrations/mapping?focus=map_live');
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe('/integrations/mapping');
      expect(window.location.search).toBe('?focus=map_live');
    });
  });
});
