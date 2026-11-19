// navigation.ts — typed nav SSOT for the Sidenav.
// Re-exports `getNavigation()` from the api facade and maps the seed shape (groups → items)
// into a typed `NavSection[]` ready for the shell. Capability filtering is row-driven via
// useIdentity().hasCapability — no hardcoded role matrices in code.
import { useMemo } from 'react';
import { getNavigation } from '@/lib/api';
import { useIdentity } from '@/lib/identity';

export interface NavItem {
  key: string;
  label: string;
  iconName: string;
  routePath: string;
  capability?: string;
  badge?: string;
  badgeKind?: string;
}

export interface NavSection {
  key: string;
  label: string;
  iconName?: string;
  items: NavItem[];
}

interface RawNavItem {
  key: string;
  label: string;
  icon: string;
  route: string;
  capability?: string | null;
  badge?: string;
  badgeKind?: string;
}

interface RawNavGroup {
  id: string;
  label: string;
  icon?: string;
  items: RawNavItem[];
}

interface RawNav {
  app?: string;
  groups: RawNavGroup[];
}

function toSection(group: RawNavGroup): NavSection {
  return {
    key: group.id,
    label: group.label,
    iconName: group.icon,
    items: group.items.map((it) => ({
      key: it.key,
      label: it.label,
      iconName: it.icon,
      routePath: it.route,
      capability: it.capability ?? undefined,
      badge: it.badge,
      badgeKind: it.badgeKind,
    })),
  };
}

export { getNavigation };

// Hook: returns nav sections filtered to the current identity's capabilities.
// Empty sections (after capability filter) are dropped so the Sidenav stays clean.
export function useNavigation(): NavSection[] {
  const { hasCapability } = useIdentity();
  const raw = getNavigation() as RawNav;
  return useMemo(() => {
    const sections = (raw?.groups ?? []).map(toSection);
    return sections
      .map((s) => ({ ...s, items: s.items.filter((i) => hasCapability(i.capability ?? null)) }))
      .filter((s) => s.items.length > 0);
  }, [raw, hasCapability]);
}
