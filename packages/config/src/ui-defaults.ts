export const PAGING_MODES = ["server", "client"] as const;
export const LAYOUT_MODES = ["full", "contained"] as const;
export const UI_LOCALE_DEFAULTS = {
  defaultLocale: "en",
  rtlLocales: ["ar"],
} as const;

export const UI_PAGINATION_DEFAULTS = {
  defaultPageSize: 25,
  maxPageSize: 200,
  allowedPageSizes: [10, 25, 50, 100, 200],
  searchDebounceMs: 300,
  searchDebounceOptions: [0, 150, 300, 600, 1000],
  pagingMode: "server" as const,
  pagingModeOptions: PAGING_MODES,
} as const;

export const UI_NAVIGATION_DEFAULTS = {
  maxRecents: 6,
  maxFavorites: 8,
  maxSearchResults: 12,
  sidebarCollapsed: false,
  collapsedSections: [] as string[],
  toggleShortcut: "ctrl+b",
  commandPaletteShortcut: "mod+k",
} as const;

export const UI_LAYOUT_DEFAULTS = {
  mode: "contained",
  maxWidth: "1200px",
  modeOptions: ["contained", "full"] as const,
} as const;

export const UI_TABLE_DEFAULTS = {
  minColumnWidth: 120,
  defaultColumnWidth: 160,
  resizeStep: 10,
  resizeStepLarge: 25,
  truncateLength: 140,
  rowHeightComfortable: 44,
  rowHeightCompact: 32,
  groupRowHeightComfortable: 36,
  groupRowHeightCompact: 28,
  detailRowHeightComfortable: 180,
  detailRowHeightCompact: 140,
  virtualizationOverscan: 6,
  viewTabsMax: 4,
  bulkActionInlineMax: 4,
} as const;
