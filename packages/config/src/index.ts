import {
  LAYOUT_MODES,
  UI_LAYOUT_DEFAULTS,
  PAGING_MODES,
  UI_LOCALE_DEFAULTS,
  UI_NAVIGATION_DEFAULTS,
  UI_PAGINATION_DEFAULTS,
  UI_TABLE_DEFAULTS,
} from "./ui-defaults";

export type PublicConfig = {
  appName: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseFunctionsUrl?: string | null;
  sentryDsn?: string | null;
  sentryEnvironment?: string | null;
  authMethods: string[];
  locale: string;
};

export type PublicEnvInput = {
  NEXT_PUBLIC_APP_NAME?: string;
  NEXT_PUBLIC_APP_NAME_CONSOLE?: string;
  NEXT_PUBLIC_APP_NAME_PORTAL?: string;
  NEXT_PUBLIC_APP_NAME_FIELDOPS?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL?: string;
  NEXT_PUBLIC_SENTRY_DSN?: string;
  NEXT_PUBLIC_SENTRY_ENVIRONMENT?: string;
  NEXT_PUBLIC_AUTH_METHODS?: string;
  NEXT_PUBLIC_LOCALE?: string;
};
type PagingMode = "server" | "client";
type LayoutMode = "full" | "contained";

export type UiDefaults = {
  locale: string;
  rtlLocales: string[];
  authMethods: string[];
  authMethodLabels: Record<string, string>;
  filterOpLabels: Record<string, string>;
  dashboard: {
    maxSections: number;
    maxItemsPerSection: number;
    maxActions: number;
    maxMetrics: number;
  };
  pagination: {
    defaultPageSize: number;
    maxPageSize: number;
    allowedPageSizes: number[];
    searchDebounceMs: number;
    searchDebounceOptions: number[];
    pagingMode: PagingMode;
    pagingModeOptions: PagingMode[];
  };
  navigation: {
    maxRecents: number;
    maxFavorites: number;
    maxSearchResults: number;
    sidebarCollapsed: boolean;
    collapsedSections: string[];
    toggleShortcut: string;
    commandPaletteShortcut: string;
  };
  layout: {
    mode: LayoutMode;
    maxWidth: string;
    modeOptions: LayoutMode[];
  };
  table: {
    minColumnWidth: number;
    defaultColumnWidth: number;
    resizeStep: number;
    resizeStepLarge: number;
    truncateLength: number;
    rowHeightComfortable: number;
    rowHeightCompact: number;
    groupRowHeightComfortable: number;
    groupRowHeightCompact: number;
    detailRowHeightComfortable: number;
    detailRowHeightCompact: number;
    virtualizationOverscan: number;
    viewTabsMax: number;
    bulkActionInlineMax: number;
    maxDownloadBatch: number;
    showInternalIdHints: boolean;
  };
  resourceLabelKeys: string[];
  resourceDescriptorKeys: string[];
};

const DEFAULT_AUTH_METHODS = ["magic_link", "password"];
const DEFAULT_AUTH_METHOD_LABELS: Record<string, string> = {
  magic_link: "Email link",
  password: "Password",
};
const DEFAULT_FILTER_OP_LABELS: Record<string, string> = {
  eq: "equals",
  ne: "not equal",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  ilike: "contains",
};
const DEFAULT_DASHBOARD_LIMITS = {
  maxSections: 4,
  maxItemsPerSection: 6,
  maxActions: 4,
  maxMetrics: 6,
};
const DEFAULT_TABLE = {
  ...UI_TABLE_DEFAULTS,
  maxDownloadBatch: UI_PAGINATION_DEFAULTS.defaultPageSize,
};
const DEFAULT_LAYOUT = {
  ...UI_LAYOUT_DEFAULTS,
};
const DEFAULT_RESOURCE_LABEL_KEYS = ["name", "label", "title", "slug", "code"];
const DEFAULT_RESOURCE_DESCRIPTOR_KEYS = [
  "description",
  "summary",
  "notes",
  "purpose",
];
const DEFAULT_LOCALE = UI_LOCALE_DEFAULTS.defaultLocale;
function readPublicEnv(): PublicEnvInput {
  return {
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_NAME_CONSOLE: process.env.NEXT_PUBLIC_APP_NAME_CONSOLE,
    NEXT_PUBLIC_APP_NAME_PORTAL: process.env.NEXT_PUBLIC_APP_NAME_PORTAL,
    NEXT_PUBLIC_APP_NAME_FIELDOPS: process.env.NEXT_PUBLIC_APP_NAME_FIELDOPS,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL: process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_AUTH_METHODS: process.env.NEXT_PUBLIC_AUTH_METHODS,
    NEXT_PUBLIC_LOCALE: process.env.NEXT_PUBLIC_LOCALE,
  };
}

function readUiEnv() {
  return {
    NEXT_PUBLIC_UI_AUTH_METHOD_LABELS: process.env.NEXT_PUBLIC_UI_AUTH_METHOD_LABELS,
    NEXT_PUBLIC_UI_FILTER_OP_LABELS: process.env.NEXT_PUBLIC_UI_FILTER_OP_LABELS,
    NEXT_PUBLIC_UI_DASHBOARD_MAX_SECTIONS:
      process.env.NEXT_PUBLIC_UI_DASHBOARD_MAX_SECTIONS,
    NEXT_PUBLIC_UI_DASHBOARD_MAX_ITEMS:
      process.env.NEXT_PUBLIC_UI_DASHBOARD_MAX_ITEMS,
    NEXT_PUBLIC_UI_DASHBOARD_MAX_ACTIONS:
      process.env.NEXT_PUBLIC_UI_DASHBOARD_MAX_ACTIONS,
    NEXT_PUBLIC_UI_DASHBOARD_MAX_METRICS:
      process.env.NEXT_PUBLIC_UI_DASHBOARD_MAX_METRICS,
    NEXT_PUBLIC_UI_DEFAULT_PAGE_SIZE: process.env.NEXT_PUBLIC_UI_DEFAULT_PAGE_SIZE,
    NEXT_PUBLIC_UI_MAX_PAGE_SIZE: process.env.NEXT_PUBLIC_UI_MAX_PAGE_SIZE,
    NEXT_PUBLIC_UI_PAGE_SIZES: process.env.NEXT_PUBLIC_UI_PAGE_SIZES,
    NEXT_PUBLIC_UI_SEARCH_DEBOUNCE_MS: process.env.NEXT_PUBLIC_UI_SEARCH_DEBOUNCE_MS,
    NEXT_PUBLIC_UI_SEARCH_DEBOUNCE_OPTIONS:
      process.env.NEXT_PUBLIC_UI_SEARCH_DEBOUNCE_OPTIONS,
    NEXT_PUBLIC_UI_PAGING_MODE: process.env.NEXT_PUBLIC_UI_PAGING_MODE,
    NEXT_PUBLIC_UI_PAGING_MODE_OPTIONS:
      process.env.NEXT_PUBLIC_UI_PAGING_MODE_OPTIONS,
    NEXT_PUBLIC_UI_NAV_MAX_RECENTS: process.env.NEXT_PUBLIC_UI_NAV_MAX_RECENTS,
    NEXT_PUBLIC_UI_NAV_MAX_FAVORITES:
      process.env.NEXT_PUBLIC_UI_NAV_MAX_FAVORITES,
    NEXT_PUBLIC_UI_NAV_MAX_RESULTS: process.env.NEXT_PUBLIC_UI_NAV_MAX_RESULTS,
    NEXT_PUBLIC_UI_NAV_SIDEBAR_COLLAPSED:
      process.env.NEXT_PUBLIC_UI_NAV_SIDEBAR_COLLAPSED,
    NEXT_PUBLIC_UI_NAV_COLLAPSED_SECTIONS:
      process.env.NEXT_PUBLIC_UI_NAV_COLLAPSED_SECTIONS,
    NEXT_PUBLIC_UI_NAV_TOGGLE_SHORTCUT:
      process.env.NEXT_PUBLIC_UI_NAV_TOGGLE_SHORTCUT,
    NEXT_PUBLIC_UI_NAV_COMMAND_PALETTE_SHORTCUT:
      process.env.NEXT_PUBLIC_UI_NAV_COMMAND_PALETTE_SHORTCUT,
    NEXT_PUBLIC_UI_LAYOUT_MODE: process.env.NEXT_PUBLIC_UI_LAYOUT_MODE,
    NEXT_PUBLIC_UI_LAYOUT_MODE_OPTIONS:
      process.env.NEXT_PUBLIC_UI_LAYOUT_MODE_OPTIONS,
    NEXT_PUBLIC_UI_LAYOUT_MAX_WIDTH:
      process.env.NEXT_PUBLIC_UI_LAYOUT_MAX_WIDTH,
    NEXT_PUBLIC_UI_VIEW_TABS_MAX: process.env.NEXT_PUBLIC_UI_VIEW_TABS_MAX,
    NEXT_PUBLIC_UI_RTL_LOCALES: process.env.NEXT_PUBLIC_UI_RTL_LOCALES,
    NEXT_PUBLIC_UI_RESOURCE_LABEL_KEYS: process.env.NEXT_PUBLIC_UI_RESOURCE_LABEL_KEYS,
    NEXT_PUBLIC_UI_RESOURCE_DESCRIPTOR_KEYS:
      process.env.NEXT_PUBLIC_UI_RESOURCE_DESCRIPTOR_KEYS,
    NEXT_PUBLIC_UI_TABLE_SHOW_INTERNAL_ID_HINTS:
      process.env.NEXT_PUBLIC_UI_TABLE_SHOW_INTERNAL_ID_HINTS,
  };
}

type PublicEnv = ReturnType<typeof readPublicEnv>;

const FALLBACK_APP_NAME = "App";

function resolveAppName(env: PublicEnv) {
  if (env.NEXT_PUBLIC_APP_NAME) return env.NEXT_PUBLIC_APP_NAME;
  if (env.NEXT_PUBLIC_APP_NAME_CONSOLE && !env.NEXT_PUBLIC_APP_NAME_PORTAL) {
    return env.NEXT_PUBLIC_APP_NAME_CONSOLE;
  }
  if (env.NEXT_PUBLIC_APP_NAME_PORTAL && !env.NEXT_PUBLIC_APP_NAME_CONSOLE) {
    return env.NEXT_PUBLIC_APP_NAME_PORTAL;
  }
  if (
    env.NEXT_PUBLIC_APP_NAME_FIELDOPS &&
    !env.NEXT_PUBLIC_APP_NAME_CONSOLE &&
    !env.NEXT_PUBLIC_APP_NAME_PORTAL
  ) {
    return env.NEXT_PUBLIC_APP_NAME_FIELDOPS;
  }
  return undefined;
}

function parseAuthMethods(value?: string) {
  if (!value) return DEFAULT_AUTH_METHODS;
  const normalized = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized)).filter(
    (method) => method === "magic_link" || method === "password"
  );
  return unique.length > 0 ? unique : DEFAULT_AUTH_METHODS;
}

function parseNumber(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseNumberList(value: string | undefined, fallback: readonly number[]) {
  if (!value) return Array.from(fallback);
  const normalized = value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique : Array.from(fallback);
}

function parseStringList(value: string | undefined, fallback: string[]) {
  if (!value) return fallback;
  const normalized = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseShortcut(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized || fallback;
}

const PAGING_MODES_LIST: PagingMode[] = [...PAGING_MODES];
const LAYOUT_MODES_LIST: LayoutMode[] = [...LAYOUT_MODES];

function normalizePagingModes(value: string[], fallback: PagingMode[]) {
  const raw = value.length > 0 ? value : fallback;
  const normalized = raw
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is PagingMode =>
      PAGING_MODES_LIST.includes(entry as PagingMode)
    );
  return Array.from(new Set(normalized));
}

function normalizeLayoutModes(value: string[], fallback: LayoutMode[]) {
  const raw = value.length > 0 ? value : fallback;
  const normalized = raw
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is LayoutMode =>
      LAYOUT_MODES_LIST.includes(entry as LayoutMode)
    );
  return Array.from(new Set(normalized));
}

function resolvePagingMode(
  value: string | undefined,
  options: PagingMode[],
  fallback: PagingMode
) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase() as PagingMode;
  return options.includes(normalized) ? normalized : fallback;
}

function resolveLayoutMode(
  value: string | undefined,
  options: LayoutMode[],
  fallback: LayoutMode
) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase() as LayoutMode;
  return options.includes(normalized) ? normalized : fallback;
}

function normalizeLayoutWidth(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/^\d+(\.\d+)?(px|rem|em|%)$/.test(trimmed)) return trimmed;
  return fallback;
}

function parseAuthMethodLabels(value?: string) {
  if (!value) return DEFAULT_AUTH_METHOD_LABELS;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_AUTH_METHOD_LABELS;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const labels: Record<string, string> = {};
      for (const [key, raw] of Object.entries(parsed)) {
        if (typeof raw !== "string") continue;
        const label = raw.trim();
        if (!label) continue;
        labels[key.trim().toLowerCase()] = label;
      }
      return { ...DEFAULT_AUTH_METHOD_LABELS, ...labels };
    } catch {
      return DEFAULT_AUTH_METHOD_LABELS;
    }
  }
  const labels: Record<string, string> = {};
  for (const entry of trimmed.split(",")) {
    const [rawKey, ...rawLabelParts] = entry.split(":");
    const key = rawKey?.trim().toLowerCase();
    const label = rawLabelParts.join(":").trim();
    if (!key || !label) continue;
    labels[key] = label;
  }
  return Object.keys(labels).length > 0
    ? { ...DEFAULT_AUTH_METHOD_LABELS, ...labels }
    : DEFAULT_AUTH_METHOD_LABELS;
}

function parseFilterOpLabels(value?: string) {
  if (!value) return DEFAULT_FILTER_OP_LABELS;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_FILTER_OP_LABELS;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const labels: Record<string, string> = {};
      for (const [key, raw] of Object.entries(parsed)) {
        if (typeof raw !== "string") continue;
        const label = raw.trim();
        const normalizedKey = key.trim().toLowerCase();
        if (!normalizedKey || !label) continue;
        labels[normalizedKey] = label;
      }
      return Object.keys(labels).length > 0
        ? { ...DEFAULT_FILTER_OP_LABELS, ...labels }
        : DEFAULT_FILTER_OP_LABELS;
    } catch {
      return DEFAULT_FILTER_OP_LABELS;
    }
  }
  const labels: Record<string, string> = {};
  for (const entry of trimmed.split(",")) {
    const [rawKey, ...rawLabelParts] = entry.split(":");
    const key = rawKey?.trim().toLowerCase();
    const label = rawLabelParts.join(":").trim();
    if (!key || !label) continue;
    labels[key] = label;
  }
  return Object.keys(labels).length > 0
    ? { ...DEFAULT_FILTER_OP_LABELS, ...labels }
    : DEFAULT_FILTER_OP_LABELS;
}

function getRequiredEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function getOptionalEnv(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function getUiDefaults(): UiDefaults {
  const uiEnv = readUiEnv();
  const publicEnv = readPublicEnv();
  const pagingModeOptions = normalizePagingModes(
    parseStringList(
      uiEnv.NEXT_PUBLIC_UI_PAGING_MODE_OPTIONS,
      UI_PAGINATION_DEFAULTS.pagingModeOptions as unknown as string[]
    ),
    UI_PAGINATION_DEFAULTS.pagingModeOptions as unknown as PagingMode[]
  );
  const layoutModeOptions = normalizeLayoutModes(
    parseStringList(
      uiEnv.NEXT_PUBLIC_UI_LAYOUT_MODE_OPTIONS,
      DEFAULT_LAYOUT.modeOptions as unknown as string[]
    ),
    DEFAULT_LAYOUT.modeOptions as unknown as LayoutMode[]
  );
  const fallbackPagingMode = pagingModeOptions.includes(
    UI_PAGINATION_DEFAULTS.pagingMode
  )
    ? UI_PAGINATION_DEFAULTS.pagingMode
    : pagingModeOptions[0] ?? "server";
  const fallbackLayoutMode = layoutModeOptions.includes(DEFAULT_LAYOUT.mode)
    ? (DEFAULT_LAYOUT.mode as LayoutMode)
    : layoutModeOptions[0] ?? "full";
  const pagingMode = resolvePagingMode(
    uiEnv.NEXT_PUBLIC_UI_PAGING_MODE,
    pagingModeOptions,
    fallbackPagingMode
  );
  const layoutMode = resolveLayoutMode(
    uiEnv.NEXT_PUBLIC_UI_LAYOUT_MODE,
    layoutModeOptions,
    fallbackLayoutMode
  );
  const layoutMaxWidth = normalizeLayoutWidth(
    uiEnv.NEXT_PUBLIC_UI_LAYOUT_MAX_WIDTH,
    DEFAULT_LAYOUT.maxWidth
  );
  const searchDebounceOptions = parseNumberList(
    uiEnv.NEXT_PUBLIC_UI_SEARCH_DEBOUNCE_OPTIONS,
    UI_PAGINATION_DEFAULTS.searchDebounceOptions
  );
  const searchDebounceMs = parseNumber(
    uiEnv.NEXT_PUBLIC_UI_SEARCH_DEBOUNCE_MS,
    UI_PAGINATION_DEFAULTS.searchDebounceMs,
    0,
    10000
  );
  return {
    locale: publicEnv.NEXT_PUBLIC_LOCALE || DEFAULT_LOCALE,
    rtlLocales: parseStringList(
      uiEnv.NEXT_PUBLIC_UI_RTL_LOCALES,
      UI_LOCALE_DEFAULTS.rtlLocales as unknown as string[]
    ),
    authMethods: parseAuthMethods(process.env.NEXT_PUBLIC_AUTH_METHODS),
    authMethodLabels: parseAuthMethodLabels(uiEnv.NEXT_PUBLIC_UI_AUTH_METHOD_LABELS),
    filterOpLabels: parseFilterOpLabels(uiEnv.NEXT_PUBLIC_UI_FILTER_OP_LABELS),
    dashboard: {
      maxSections: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_DASHBOARD_MAX_SECTIONS,
        DEFAULT_DASHBOARD_LIMITS.maxSections,
        1,
        24
      ),
      maxItemsPerSection: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_DASHBOARD_MAX_ITEMS,
        DEFAULT_DASHBOARD_LIMITS.maxItemsPerSection,
        1,
        24
      ),
      maxActions: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_DASHBOARD_MAX_ACTIONS,
        DEFAULT_DASHBOARD_LIMITS.maxActions,
        1,
        24
      ),
      maxMetrics: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_DASHBOARD_MAX_METRICS,
        DEFAULT_DASHBOARD_LIMITS.maxMetrics,
        1,
        24
      ),
    },
    pagination: {
      defaultPageSize: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_DEFAULT_PAGE_SIZE,
        UI_PAGINATION_DEFAULTS.defaultPageSize,
        1,
        1000
      ),
      maxPageSize: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_MAX_PAGE_SIZE,
        UI_PAGINATION_DEFAULTS.maxPageSize,
        1,
        1000
      ),
      allowedPageSizes: parseNumberList(
        uiEnv.NEXT_PUBLIC_UI_PAGE_SIZES,
        UI_PAGINATION_DEFAULTS.allowedPageSizes
      ),
      searchDebounceMs,
      searchDebounceOptions,
      pagingMode,
      pagingModeOptions,
    },
    navigation: {
      maxRecents: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_NAV_MAX_RECENTS,
        UI_NAVIGATION_DEFAULTS.maxRecents,
        0,
        50
      ),
      maxFavorites: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_NAV_MAX_FAVORITES,
        UI_NAVIGATION_DEFAULTS.maxFavorites,
        0,
        50
      ),
      maxSearchResults: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_NAV_MAX_RESULTS,
        UI_NAVIGATION_DEFAULTS.maxSearchResults,
        1,
        100
      ),
      sidebarCollapsed: parseBoolean(
        uiEnv.NEXT_PUBLIC_UI_NAV_SIDEBAR_COLLAPSED,
        UI_NAVIGATION_DEFAULTS.sidebarCollapsed
      ),
      collapsedSections: parseStringList(
        uiEnv.NEXT_PUBLIC_UI_NAV_COLLAPSED_SECTIONS,
        UI_NAVIGATION_DEFAULTS.collapsedSections as unknown as string[]
      ),
      toggleShortcut: parseShortcut(
        uiEnv.NEXT_PUBLIC_UI_NAV_TOGGLE_SHORTCUT,
        UI_NAVIGATION_DEFAULTS.toggleShortcut
      ),
      commandPaletteShortcut: parseShortcut(
        uiEnv.NEXT_PUBLIC_UI_NAV_COMMAND_PALETTE_SHORTCUT,
        UI_NAVIGATION_DEFAULTS.commandPaletteShortcut
      ),
    },
    layout: {
      mode: layoutMode,
      maxWidth: layoutMaxWidth,
      modeOptions: layoutModeOptions,
    },
    table: {
      ...DEFAULT_TABLE,
      viewTabsMax: parseNumber(
        uiEnv.NEXT_PUBLIC_UI_VIEW_TABS_MAX,
        UI_TABLE_DEFAULTS.viewTabsMax,
        1,
        12
      ),
      showInternalIdHints: parseBoolean(
        uiEnv.NEXT_PUBLIC_UI_TABLE_SHOW_INTERNAL_ID_HINTS,
        false
      ),
    },
    resourceLabelKeys: parseStringList(
      uiEnv.NEXT_PUBLIC_UI_RESOURCE_LABEL_KEYS,
      DEFAULT_RESOURCE_LABEL_KEYS
    ),
    resourceDescriptorKeys: parseStringList(
      uiEnv.NEXT_PUBLIC_UI_RESOURCE_DESCRIPTOR_KEYS,
      DEFAULT_RESOURCE_DESCRIPTOR_KEYS
    ),
  };
}

export function getPublicConfig(): PublicConfig {
  return getPublicConfigFromEnv(readPublicEnv());
}

export function getPublicConfigFromEnv(env: PublicEnvInput): PublicConfig {
  const publicEnv = env as PublicEnv;
  return {
    appName: resolveAppName(publicEnv) ?? FALLBACK_APP_NAME,
    supabaseUrl: getRequiredEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      publicEnv.NEXT_PUBLIC_SUPABASE_URL
    ),
    supabaseAnonKey: getRequiredEnv(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ),
    supabaseFunctionsUrl: getOptionalEnv(
      publicEnv.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
    ),
    sentryDsn: getOptionalEnv(publicEnv.NEXT_PUBLIC_SENTRY_DSN),
    sentryEnvironment: getOptionalEnv(publicEnv.NEXT_PUBLIC_SENTRY_ENVIRONMENT),
    authMethods: parseAuthMethods(publicEnv.NEXT_PUBLIC_AUTH_METHODS),
    locale: publicEnv.NEXT_PUBLIC_LOCALE || DEFAULT_LOCALE,
  };
}

export * from "./messages";
