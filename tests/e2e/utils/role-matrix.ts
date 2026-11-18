import { expect, type Page } from "@playwright/test";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { isResourceReadScopeAllowed } from "../../../packages/ui/src/capabilities";
import { normalizeCommandRegistry } from "../../../packages/ui/src/command-registry";
import {
  normalizeAppHref,
  normalizeBasePath,
} from "../../../packages/ui/src/navigation-paths";
import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "./supabase";

export type NavigationItem = {
  id: string;
  label?: string | null;
  href?: string | null;
  capability?: string | null;
  resource?: string | null;
  disabled_reason?: string | null;
  items?: NavigationItem[] | null;
};

export type NavigationSection = {
  id: string;
  label?: string | null;
  items?: NavigationItem[] | null;
};

export type NavigationResponse = {
  app?: string | null;
  sections?: NavigationSection[] | null;
};

export type ReadRegistryResource = {
  key?: string | null;
  id_column?: string | null;
  read_scope_types?: string[] | null;
  scope_columns?: Record<string, string | null> | null;
  filters?: Array<{
    key?: string | null;
    column?: string | null;
    op?: string | null;
  }> | null;
  download?: unknown;
};

export type ReadRegistry = {
  resources?: ReadRegistryResource[] | null;
};

export type CommandDefinition = {
  key?: string | null;
  schema_category?: string | null;
  capability?: string | null;
  execution?: {
    rpc?: string | null;
    type?: string | null;
  } | null;
  label?: string | null;
  selection?: {
    min_count?: number | null;
    max_count?: number | null;
  } | null;
};

type UiMe = {
  user?: {
    email?: string | null;
    user_type?: string | null;
  } | null;
  access_scope?: {
    scope_type?: string | null;
    scope_id?: string | null;
  } | null;
  org?: {
    id?: string | null;
  } | null;
  capabilities?: string[] | null;
};

type UserContext = {
  me: UiMe | null;
  navigation: NavigationResponse;
  readRegistry: ReadRegistry | null;
  commandRegistry: CommandDefinition[];
};

type FlattenedNavItem = {
  sectionLabel: string | null;
  item: NavigationItem;
};

const contextCache = new Map<string, UserContext>();

export function flattenNavigationSections(
  sections: NavigationSection[] = []
): FlattenedNavItem[] {
  const out: FlattenedNavItem[] = [];
  const walk = (items: NavigationItem[], sectionLabel: string | null) => {
    items.forEach((item) => {
      out.push({ sectionLabel, item });
      if (Array.isArray(item.items) && item.items.length > 0) {
        walk(item.items, sectionLabel);
      }
    });
  };
  sections.forEach((section) => {
    const label = section.label ?? null;
    const items = Array.isArray(section.items) ? section.items : [];
    walk(items, label);
  });
  return out;
}

export function normalizeNavHref(href: string, basePath: string) {
  const normalized = normalizeAppHref(href, basePath);
  const normalizedBase = normalizeBasePath(basePath);
  if (!normalizedBase) return normalized;
  if (normalized.startsWith(normalizedBase)) return normalized;
  const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `${normalizedBase}${path}`;
}

export async function ensureNavigationVisible(page: Page) {
  const nav = page.locator('[data-testid="navigation-list"]').first();
  await expect(nav).toBeVisible();
  await expect(page.locator('[data-testid="navigation-pending"]')).toHaveCount(0);
  await expect(page.locator('[data-navigation-registry-state]')).toHaveCount(1);
  await expect(page.locator('[data-navigation-registry-state]')).toHaveAttribute("data-navigation-registry-state", "ready");
  return nav;
}

export async function assertNavigationMatches(params: {
  page: Page;
  basePath: string;
  sections: NavigationSection[];
  readRegistry?: ReadRegistry | null;
  capabilities?: string[] | null;
  scopeType?: string | null;
  scopeId?: string | null;
  organizationId?: string | null;
}) {
  const {
    page,
    basePath,
    sections,
    readRegistry,
    capabilities,
    scopeType,
    scopeId,
    organizationId,
  } = params;
  const capabilitySet = resolveCapabilitySet(capabilities);
  const nav = await ensureNavigationVisible(page);

  for (const section of sections) {
    const sectionNav = nav.getByTestId(`navigation-section-items-${section.id}`);
    for (const { item } of flattenNavigationSections([section])) {
      const label = item.label?.trim();
      if (!label) continue;
      const href = item.href?.trim() ?? "";
      const requiredCapability = item.capability?.trim() ?? "";
      const resourceKey = item.resource?.trim() ?? "";
      const resource = resourceKey
        ? readRegistry?.resources?.find((entry) => entry?.key === resourceKey)
        : null;
      const scopeBlocked = Boolean(resourceKey) && !isResourceReadScopeAllowed(
        resource as Parameters<typeof isResourceReadScopeAllowed>[0],
        scopeType,
        scopeId,
        organizationId,
      );
      const missingCapability =
        requiredCapability && !hasCapability(capabilitySet, requiredCapability);
      const shouldDisable =
        !href || Boolean(item.disabled_reason) || missingCapability || scopeBlocked;

      const navigationItem = sectionNav.getByTestId(`navigation-item-${item.id}`);
      await expect(navigationItem).toBeVisible();
      if (shouldDisable) {
        await expect(navigationItem).toHaveAttribute("aria-disabled", "true");
        await expect(navigationItem).toHaveAttribute("title", /\S/);
        continue;
      }

      const expectedHref = normalizeNavHref(href, basePath);
      await expect(navigationItem).not.toHaveAttribute("aria-disabled", "true");
      const link = navigationItem.getByRole("link");
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", expectedHref);
    }
  }
}

export async function fetchUserContext(params: {
  app: "console" | "portal";
  email: string;
  password: string;
}) {
  const { app, email, password } = params;
  const cacheKey = `${app}:${email}`;
  const cached = contextCache.get(cacheKey);
  if (cached) return cached;

  const supabase = await createAuthedSupabaseClient({
    email,
    password,
    label: `role-matrix:${app}:${email}`,
  });

  const { data: me, error: meError } = await rpcWithRetry<UiMe>(supabase, "ui_me_v1", null, {
    label: `ui_me_v1:${email}`,
  });
  if (meError) {
    throw new Error(`Failed to read ui_me_v1 for ${email}: ${(meError as any)?.message || String(meError)}`);
  }

  const [
    { data: navigation, error: navError },
    { data: readRegistry, error: registryError },
    { data: commandRegistry, error: commandError },
  ] = await Promise.all([
    rpcWithRetry<NavigationResponse>(
      supabase,
      "ui_navigation_v1",
      { p_app: app },
      { label: `ui_navigation_v1:${app}:${email}` }
    ),
    rpcWithRetry<ReadRegistry>(supabase, "ui_read_registry_v1", null, {
      label: `ui_read_registry_v1:${email}`,
    }),
    rpcWithRetry(supabase, "ui_command_registry_v1", null, {
      label: `ui_command_registry_v1:${email}`,
    }),
  ]);

  if (navError || !navigation) {
    throw new Error(
      `Failed to read ui_navigation_v1 for ${email}: ${(navError as any)?.message || "no data"}`
    );
  }
  if (registryError) {
    throw new Error(
      `Failed to read ui_read_registry_v1 for ${email}: ${(registryError as any)?.message || String(registryError)}`
    );
  }
  if (commandError) {
    throw new Error(
      `Failed to read ui_command_registry_v1 for ${email}: ${(commandError as any)?.message || String(commandError)}`
    );
  }

  await signOutSupabaseClient(supabase, { label: `role-matrix:${app}:${email}` });

  const context = {
    me: me ?? null,
    navigation,
    readRegistry: (readRegistry ?? null) as ReadRegistry | null,
    commandRegistry: normalizeCommandRegistry(commandRegistry as any),
  };
  contextCache.set(cacheKey, context);
  return context;
}
