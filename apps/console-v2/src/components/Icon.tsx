// Icon.tsx — single inline-SVG icon component. Path data ported verbatim from demo icons.js.
import type { CSSProperties } from 'react';

export const ICON_PATHS: Record<string, string> = {
  home: 'M3 12l9-9 9 9M5 10v10h14V10',
  dashboard: 'M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z',
  map: 'M9 3l-6 3v15l6-3 6 3 6-3V3l-6 3-6-3zM9 3v15M15 6v15',
  pkg: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  package: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  alert: 'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7zM5.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  refresh: 'M3 12a9 9 0 0115-6.7L21 8M21 12a9 9 0 01-15 6.7L3 16M21 4v4h-4M3 20v-4h4',
  rotate: 'M3 2v6h6M21 22v-6h-6M3 8a9 9 0 0114 0M21 16a9 9 0 01-14 0',
  pin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0zM12 13a3 3 0 100-6 3 3 0 000 6z',
  link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  user_in: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM17 11l2 2 4-4',
  user_out: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM21 12h-7M18 9l-3 3 3 3',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  list: 'M3 6h18M3 12h18M3 18h18',
  filter: 'M3 6h18l-7 9v5l-4-2v-3L3 6z',
  search: 'M11 19a8 8 0 110-16 8 8 0 010 16zm10 2l-4.35-4.35',
  bell: 'M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  lock: 'M3 11h18v11H3zM7 11V7a5 5 0 0110 0v4',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  history: 'M3 12a9 9 0 109-9 9.7 9.7 0 00-7 3L3 9M3 4v5h5M12 7v5l3 3',
  play: 'M5 3l14 9-14 9V3z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  check: 'M5 12l5 5L20 7',
  close: 'M18 6L6 18M6 6l12 12',
  x: 'M18 6L6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  more_v: 'M12 5h.01M12 12h.01M12 19h.01',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  trash: 'M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2',
  file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  save: 'M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2zM17 21v-8H7v8M7 3v5h8',
  copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22V15',
  git: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  cloud: 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z',
  webhook: 'M18 16.98h-5.99c-1.66 0-3.01-1.34-3.01-3 0-1.66 1.35-3 3.01-3H17l-3-3 3-3M6 7.02h6c1.66 0 3 1.34 3 3 0 1.66-1.34 3-3 3M6 16.98h12',
  warn: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01',
  trace: 'M21 21H3V3M7 14l4-4 4 4 5-5',
  building: 'M3 21h18M5 21V7l8-4 8 4v14M9 9h.01M13 9h.01M9 13h.01M13 13h.01M9 17h.01M13 17h.01',
  database: 'M12 2C7.58 2 4 3.79 4 6s3.58 4 8 4 8-1.79 8-4-3.58-4-8-4zM4 6v6c0 2.21 3.58 4 8 4s8-1.79 8-4V6M4 12v6c0 2.21 3.58 4 8 4s8-1.79 8-4v-6',
  scan: 'M3 7V3h4M21 7V3h-4M3 17v4h4M21 17v4h-4M7 12h10',
  warehouse: 'M22 8.35V20a2 2 0 01-2 2H4a2 2 0 01-2-2V8.35a2 2 0 01.95-1.7l8-5.5a2 2 0 012.1 0l8 5.5a2 2 0 01.95 1.7zM6 22V12h12v10',
  squared: 'M9 7H5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-4M14 5l5 5M21 3l-9 9',
  cmd: 'M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z',
  chevR: 'M9 6l6 6-6 6',
  chevD: 'M6 9l6 6 6-6',
  chevL: 'M15 6l-6 6 6 6',
  chevU: 'M18 15l-6-6-6 6',
  up: 'M18 15l-6-6-6 6',
  down: 'M6 9l6 6 6-6',
  arrowR: 'M5 12h14M12 5l7 7-7 7',
  right: 'M5 12h14M12 5l7 7-7 7',
  arrowL: 'M19 12H5M12 19l-7-7 7-7',
  external: 'M14 3h7v7M10 14L21 3M21 14v6a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1h6',
  kanban: 'M3 3h7v18H3zM14 3h7v9h-7z',
  workflow: 'M3 5h6v6H3zM15 13h6v6h-6zM12 11l3 4M9 8l3 4',
  trace_tree: 'M5 4h6M5 12h10M5 20h14M3 4l1 1M3 12l1 1M3 20l1 1',
  globe: 'M12 22a10 10 0 110-20 10 10 0 010 20zM12 2a14 14 0 010 20M12 2a14 14 0 000 20M2 12h20',
  audit: 'M5 4h6M5 12h10M5 20h14M3 4l1 1M3 12l1 1M3 20l1 1',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z',
  shuffle: 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
  wallet: 'M21 12V7H5a2 2 0 010-4h14v4M3 5v14a2 2 0 002 2h16v-5M18 12a2 2 0 100 4h4v-4z',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  bq: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM12 7v10M7 12h10',
  // Webhook source connector — two-prong "plug" symbol.
  // Used in the sidenav for /integrations/sources.
  plug: 'M9 7V2M15 7V2M5 9h14v3a7 7 0 01-14 0V9zM12 16v6',
  // Routing rules — branching arrow (split path).
  // Used in the sidenav for /integrations/rules.
  route: 'M6 3v12a4 4 0 004 4h4M14 19l3-3M14 19l3 3M18 3v6M15 6h6',
  // CLAIM-FINANCE-BILLING — invoice ledger glyph (document with line entries
  // and a torn/serrated bottom edge to read as a billing receipt). Used in the
  // sidenav for /finance/billing.
  invoice: 'M6 2h9l5 5v13l-2-1-2 1-2-1-2 1-2-1-2 1-2-1-2 1V2zM15 2v5h5M9 12h8M9 16h8M9 8h4',
  // CLAIM-NETWORK-MARKETPLACE — shopping-bag glyph (a marketplace tote with
  // two curved handles arching above the body). Used in the sidenav for
  // /network/marketplace.
  'shopping-bag': 'M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4zM3 6h18M16 10a4 4 0 11-8 0',
  // CLAIM-INSIGHTS-API-GW — gauge / speedometer glyph (a half-circle dial
  // with a needle leaning toward upper-right and tick marks). Used in the
  // sidenav for /insights/api-gateway. Reads as latency / throughput at a
  // glance, matching the Datadog APM / Honeycomb / Postman observability
  // metaphor.
  gauge: 'M3 18a9 9 0 0118 0M12 18l5-7M7 18h.01M17 18h.01M5.5 13.5h.01M18.5 13.5h.01',
  // CLAIM-SUPPORT-CASES — speech-bubble glyph (single rounded chat bubble
  // with a tail). Used in the sidenav for /support/cases. Reads as
  // conversation / triage at a glance, matching the Zendesk / Front /
  // Linear-triage support-conversation metaphor.
  message: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
};

export interface IconProps {
  name: string;
  size?: number;
  stroke?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export function isSupportedIconName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICON_PATHS, name);
}

export function Icon({ name, size = 14, stroke = 1.6, className, style, title }: IconProps) {
  const d = ICON_PATHS[name] || ICON_PATHS.more!;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? 'false' : 'true'}
      role={title ? 'img' : undefined}
      aria-label={title}
      className={className}
      style={style}
    >
      <path d={d} />
    </svg>
  );
}
