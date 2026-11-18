import { normalizeConsoleHref } from '@/lib/legacy-hash-navigation';

export type ShellCommandRegistryRow = {
  key?: string | number | null;
  label?: string | null;
  section?: string | null;
  capability?: string | null;
  route_targets?: {
    console?: { path?: string | null } | null;
  } | null;
};

export type ShellCommandRouteItem = {
  label: string;
  routePath: string;
};

export function resolveCommandRoutePath(
  row: ShellCommandRegistryRow,
  _navItems: ShellCommandRouteItem[],
): string | undefined {
  const consoleTarget = row.route_targets?.console;
  const configuredPath = typeof consoleTarget?.path === 'string' ? consoleTarget.path.trim() : '';

  if (configuredPath) return normalizeConsoleHref(configuredPath);
  return undefined;
}
