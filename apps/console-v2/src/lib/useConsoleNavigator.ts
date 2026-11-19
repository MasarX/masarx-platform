import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  normalizeConsoleHref,
  resolveLegacyHashNavigation,
  type ConsoleNavigationTarget,
} from './legacy-hash-navigation';

function applyBrowserHistoryTarget(target: ConsoleNavigationTarget) {
  const query = new URLSearchParams(target.search as Record<string, string>).toString();
  const nextUrl = query ? `${target.to}?${query}` : target.to;
  window.history.pushState(null, '', nextUrl);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useConsoleNavigator() {
  const navigate = useNavigate();

  return useCallback(
    (href: string) => {
      const normalized = normalizeConsoleHref(href);
      const target = resolveLegacyHashNavigation(normalized);
      if (!target) {
        window.location.assign(normalized);
        return;
      }

      try {
        const result = navigate({
          to: target.to as never,
          search: target.search as never,
        });
        void Promise.resolve(result).catch(() => applyBrowserHistoryTarget(target));
      } catch {
        applyBrowserHistoryTarget(target);
      }
    },
    [navigate],
  );
}
