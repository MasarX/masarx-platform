// dashboard.tsx — TS/React port of demo-v2/assets/js/modules/dashboard.js
//
// Configurable, multi-view dashboard. Toolbar exposes view switcher / time
// range / refresh interval / freshness / edit mode / add widget. Body is a
// 12-column responsive grid of widgets in S/M/L/XL sizes.
//
// Widget kinds (parity with demo): kpi_strip · queue · activity_feed ·
// status_grid · counter_board · scope_card · commands · planning_os.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { KPICard } from '@/components/KPICard';
import { DataTable } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import {
  useDashboardKpis,
  useTasks,
  useResourceList,
  useDecisionLog,
  useAuditLog,
  useCodSummary,
  useResolveSettings,
} from '@/lib/queries';
import { usePalette } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { useI18n } from '@/lib/i18n';
import * as api from '@/lib/api';
import { CAP, formatCapabilityRequirement, formatCapabilityTitle } from '@/lib/capabilities';
import { isShipmentRisk } from './operate/shipments';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';

type WidgetKind =
  | 'kpi_strip'
  | 'queue'
  | 'activity_feed'
  | 'status_grid'
  | 'counter_board'
  | 'scope_card'
  | 'commands'
  | 'planning_os';

type WidgetSize = 's' | 'm' | 'l' | 'xl';

interface Widget {
  id: string;
  kind: WidgetKind;
  size: WidgetSize;
  config?: Record<string, unknown>;
}

interface View {
  id: string;
  label: string;
  icon: string;
  widgets: Widget[];
}

const VIEWS_KEY = 'console-v2.dashboard.views';
const ACTIVE_VIEW_KEY = 'console-v2.dashboard.active';

const DEFAULT_VIEWS: Record<string, View> = {
  my_day: {
    id: 'my_day',
    label: 'My Day',
    icon: 'user',
    widgets: [
      { id: 'w1', kind: 'kpi_strip', size: 'xl' },
      { id: 'w2', kind: 'queue', size: 'l', config: { resource: 'tasks', filter: 'mine', limit: 6 } },
      { id: 'w3', kind: 'activity_feed', size: 'm', config: { source: 'decision_log', limit: 10 } },
      { id: 'w4', kind: 'commands', size: 'm', config: { limit: 5 } },
    ],
  },
  ops_focus: {
    id: 'ops_focus',
    label: 'Operations Focus',
    icon: 'truck',
    widgets: [
      { id: 'w1', kind: 'kpi_strip', size: 'xl' },
      { id: 'w2', kind: 'queue', size: 'l', config: { resource: 'shipments', filter: 'at_risk', limit: 8 } },
      { id: 'w3', kind: 'queue', size: 'l', config: { resource: 'tasks', filter: 'ndr', limit: 6 } },
      { id: 'w4', kind: 'counter_board', size: 'm', config: { source: 'route_runs' } },
      { id: 'w5', kind: 'status_grid', size: 'm', config: { source: 'integration_health' } },
    ],
  },
  finance_focus: {
    id: 'finance_focus',
    label: 'Finance Focus',
    icon: 'bolt',
    widgets: [
      { id: 'w1', kind: 'kpi_strip', size: 'xl', config: { domain: 'finance' } },
      { id: 'w2', kind: 'queue', size: 'l', config: { resource: 'settlement_batches', limit: 6 } },
      { id: 'w3', kind: 'counter_board', size: 'm', config: { source: 'cod' } },
      { id: 'w4', kind: 'activity_feed', size: 'm', config: { source: 'audit_log', limit: 8 } },
    ],
  },
  integration_health: {
    id: 'integration_health',
    label: 'Integration Health',
    icon: 'cloud',
    widgets: [
      { id: 'w1', kind: 'status_grid', size: 'xl', config: { source: 'integration_health' } },
      { id: 'w2', kind: 'queue', size: 'l', config: { resource: 'integration_plugins', limit: 7 } },
      { id: 'w3', kind: 'activity_feed', size: 'm', config: { source: 'webhook_inbox', limit: 8 } },
      { id: 'w4', kind: 'scope_card', size: 'm', config: { category: 'webhook_ingest_policy' } },
    ],
  },
};

const TIME_RANGES = [
  { id: '15m', label: 'Last 15m' },
  { id: '1h', label: 'Last 1h' },
  { id: '24h', label: 'Last 24h' },
  { id: '7d', label: 'Last 7d' },
  { id: '30d', label: 'Last 30d' },
] as const;

const REFRESH_OPTS = [
  { id: 'off', label: 'Off', ms: 0 },
  { id: '30s', label: '30 seconds', ms: 30_000 },
  { id: '1m', label: '1 minute', ms: 60_000 },
  { id: '5m', label: '5 minutes', ms: 300_000 },
] as const;

function loadViews(): Record<string, View> {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWS_KEY) || 'null');
    if (v && Object.keys(v).length) return v as Record<string, View>;
  } catch {
    /* noop */
  }
  return JSON.parse(JSON.stringify(DEFAULT_VIEWS));
}
function saveViews(views: Record<string, View>): void {
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* noop */
  }
}
function loadActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_VIEW_KEY);
  } catch {
    return null;
  }
}
function saveActive(id: string): void {
  try {
    localStorage.setItem(ACTIVE_VIEW_KEY, id);
  } catch {
    /* noop */
  }
}

export function DashboardModule() {
  const { scope } = useIdentity();
  const palette = usePalette();
  const { t } = useI18n();

  const [views, setViews] = useState<Record<string, View>>(() => loadViews());
  const [activeViewId, setActiveViewId] = useState<string>(() => loadActive() || 'my_day');
  const [timeRange, setTimeRange] = useState<string>('24h');
  const [refresh, setRefresh] = useState<string>('off');
  const [editMode, setEditMode] = useState<boolean>(false);
  const [freshness, setFreshness] = useState<number>(Date.now());

  const view = views[activeViewId] || Object.values(views)[0]!;

  // Refresh interval timer
  useEffect(() => {
    const opt = REFRESH_OPTS.find((r) => r.id === refresh);
    if (!opt || !opt.ms) return undefined;
    const id = window.setInterval(() => setFreshness(Date.now()), opt.ms);
    return () => window.clearInterval(id);
  }, [refresh]);

  function persistViews(next: Record<string, View>) {
    setViews(next);
    saveViews(next);
  }

  function pickView(id: string) {
    setActiveViewId(id);
    saveActive(id);
  }

  // ---------- Toolbar menus ----------
  function openViewMenu() {
    const items = [
      ...Object.values(views).map((v) => ({
        label: v.label,
        key: v.id,
        section: 'Views',
        meta: `${v.widgets.length} widgets`,
        onPick: () => pickView(v.id),
      })),
      {
        label: 'Reset to defaults',
        key: '__reset__',
        section: 'Manage',
        onPick: () => {
          const defaults = JSON.parse(JSON.stringify(DEFAULT_VIEWS)) as Record<string, View>;
          persistViews(defaults);
          pushToast('Views reset', 'good');
        },
      },
    ];
    palette.open({ placeholder: 'Switch view…', items, onPick: (it) => it.onPick?.() });
  }
  function openTimeRange() {
    palette.open({
      placeholder: 'Time range…',
      items: TIME_RANGES.map((r) => ({
        label: r.label,
        key: r.id,
        section: 'Range',
        onPick: () => setTimeRange(r.id),
      })),
      onPick: (it) => it.onPick?.(),
    });
  }
  function openRefreshMenu() {
    palette.open({
      placeholder: 'Auto refresh…',
      items: REFRESH_OPTS.map((r) => ({
        label: r.label,
        key: r.id,
        section: 'Auto refresh',
        onPick: () => setRefresh(r.id),
      })),
      onPick: (it) => it.onPick?.(),
    });
  }
  function openAddWidget() {
    const KINDS: Array<{ kind: WidgetKind; label: string; icon: string }> = [
      { kind: 'kpi_strip', label: 'KPI strip · operational', icon: 'dashboard' },
      { kind: 'queue', label: 'Queue / list', icon: 'list' },
      { kind: 'activity_feed', label: 'Activity feed (decisions)', icon: 'trace' },
      { kind: 'status_grid', label: 'Integration status grid', icon: 'cloud' },
      { kind: 'counter_board', label: 'Counter board', icon: 'grid' },
      { kind: 'scope_card', label: 'Resolved scope card', icon: 'layers' },
      { kind: 'commands', label: 'Quick commands', icon: 'cmd' },
      { kind: 'planning_os', label: 'Planning OS · execution cards', icon: 'kanban' },
    ];
    palette.open({
      placeholder: 'Add a widget…',
      items: KINDS.map((k) => ({
        label: k.label,
        key: k.kind,
        section: 'Widget types',
        onPick: () => {
          const next = { ...views };
          const cur = next[activeViewId] ?? view;
          next[activeViewId] = {
            ...cur,
            widgets: [...cur.widgets, { id: 'w_' + Date.now(), kind: k.kind, size: 'm', config: {} }],
          };
          persistViews(next);
          pushToast(`Added ${k.label}`, 'good');
        },
      })),
      onPick: (it) => it.onPick?.(),
    });
  }

  function moveWidget(widgetId: string, dir: -1 | 1) {
    const cur = views[activeViewId];
    if (!cur) return;
    const i = cur.widgets.findIndex((w) => w.id === widgetId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= cur.widgets.length) return;
    const widgets = cur.widgets.slice();
    const [a, b] = [widgets[i]!, widgets[j]!];
    widgets[i] = b;
    widgets[j] = a;
    persistViews({ ...views, [cur.id]: { ...cur, widgets } });
  }
  function removeWidget(widgetId: string) {
    const cur = views[activeViewId];
    if (!cur) return;
    persistViews({ ...views, [cur.id]: { ...cur, widgets: cur.widgets.filter((w) => w.id !== widgetId) } });
    pushToast('Widget removed', 'info');
  }
  function cycleWidgetSize(widgetId: string) {
    const sizes: WidgetSize[] = ['s', 'm', 'l', 'xl'];
    const cur = views[activeViewId];
    if (!cur) return;
    persistViews({
      ...views,
      [cur.id]: {
        ...cur,
        widgets: cur.widgets.map((w) => {
          if (w.id !== widgetId) return w;
          const idx = sizes.indexOf(w.size || 'm');
          return { ...w, size: sizes[(idx + 1) % sizes.length]! };
        }),
      },
    });
  }

  const inlineViews = Object.values(views).slice(0, 4);

  const pills: ReactNode[] = [<ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />];

  return (
    <div className="page">
      <PageHeader
        moduleKey="dashboard"
        pills={pills}
        actions={[
          <Button
            key="palette"
            label="Open palette · ⌘K"
            iconName="cmd"
            kind="primary"
            onClick={() => {
              const trigger = document.getElementById('cmd-trigger');
              if (trigger) (trigger as HTMLElement).click();
            }}
          />,
        ]}
      />

      {/* Toolbar */}
      <div className="dash-toolbar">
        <div className="dash-toolbar__group">
          <button
            className="btn btn--sm btn--ghost"
            onClick={openViewMenu}
            title="Switch view"
            type="button"
          >
            <Icon name={view.icon || 'dashboard'} size={12} />
            <span style={{ fontWeight: 600 }}>{view.label}</span>
            <span className="kbd" style={{ fontSize: '9px' }}>▾</span>
          </button>
          {inlineViews.map((v) => (
            <button
              key={v.id}
              className={`dash-tab ${v.id === activeViewId ? 'is-active' : ''}`}
              onClick={() => pickView(v.id)}
              type="button"
            >
              {v.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="dash-toolbar__group">
          <button className="btn btn--sm btn--ghost" type="button" onClick={openTimeRange} title="Time range">
            <Icon name="history" size={12} />
            <span>{TIME_RANGES.find((r) => r.id === timeRange)?.label || 'Range'}</span>
          </button>
          <button className="btn btn--sm btn--ghost" type="button" onClick={openRefreshMenu} title="Auto refresh">
            <Icon name="refresh" size={12} />
            <span>{REFRESH_OPTS.find((r) => r.id === refresh)?.label || 'Off'}</span>
          </button>
          <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)', padding: '0 4px' }}>
            {`as of ${new Date(freshness).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}`}
          </span>
          <button
            className={`btn btn--sm ${editMode ? 'btn--primary' : 'btn--ghost'}`}
            type="button"
            onClick={() => setEditMode((v) => !v)}
            title="Toggle edit mode"
          >
            <Icon name="edit" size={12} />
            <span>{editMode ? 'Done' : 'Edit'}</span>
          </button>
          <Button
            label="Add widget"
            iconName="plus"
            kind={editMode ? 'primary' : 'ghost'}
            disabled={!editMode}
            onClick={openAddWidget}
          />
        </div>
      </div>

      {/* Grid */}
      <div className={`dash-grid ${editMode ? 'is-edit' : ''}`}>
        {view.widgets.map((w) => (
          <WidgetCard
            key={w.id}
            widget={w}
            editMode={editMode}
            onCycleSize={() => cycleWidgetSize(w.id)}
            onMoveUp={() => moveWidget(w.id, -1)}
            onMoveDown={() => moveWidget(w.id, 1)}
            onRemove={() => removeWidget(w.id)}
            onConfigure={() => {
              const sizes: WidgetSize[] = ['s', 'm', 'l', 'xl'];
              palette.open({
                placeholder: 'Widget config…',
                items: sizes.map((s) => ({
                  label: `Size: ${s.toUpperCase()}`,
                  key: s,
                  section: 'Size',
                  onPick: () => {
                    persistViews({
                      ...views,
                      [view.id]: {
                        ...view,
                        widgets: view.widgets.map((ww) => (ww.id === w.id ? { ...ww, size: s } : ww)),
                      },
                    });
                  },
                })),
                onPick: (it) => it.onPick?.(),
              });
            }}
            time={`${timeRange}-${freshness}`}
          />
        ))}
      </div>

      {palette.node}
      {/* Used to reference t for unused var rule */}
      <span hidden aria-hidden>{t('dashboard.label', '')}</span>
    </div>
  );
}

// ---------- Widget shell + content router ----------

interface WidgetCardProps {
  widget: Widget;
  editMode: boolean;
  onCycleSize: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onConfigure: () => void;
  onRemove: () => void;
  /** Bumped externally to force-refresh time-driven widgets. */
  time: string;
}

function WidgetCard({
  widget,
  editMode,
  onCycleSize,
  onMoveUp,
  onMoveDown,
  onConfigure,
  onRemove,
  time,
}: WidgetCardProps) {
  const title = widgetTitle(widget);
  return (
    <div className={`dash-widget dash-widget--${widget.size || 'm'}`} data-time={time}>
      <div className="dash-widget__head">
        <span className="eyebrow">{title}</span>
        <div style={{ flex: 1 }} />
        {editMode ? (
          <div className="dash-widget__edit-actions">
            <button className="icon-btn" type="button" onClick={onCycleSize} title="Resize">
              {(widget.size || 'm').toUpperCase()}
            </button>
            <button className="icon-btn" type="button" onClick={onMoveUp} title="Move up">↑</button>
            <button className="icon-btn" type="button" onClick={onMoveDown} title="Move down">↓</button>
            <button className="icon-btn" type="button" onClick={onConfigure} title="Configure">⚙</button>
            <button className="icon-btn" type="button" onClick={onRemove} title="Remove">×</button>
          </div>
        ) : null}
      </div>
      <div className="dash-widget__body" tabIndex={0} role="region" aria-label={title}>
        <WidgetBody widget={widget} />
      </div>
    </div>
  );
}

const DASHBOARD_RESOURCE_LABELS: Record<string, string> = {
  tasks: 'Task queue',
  shipments: 'Shipment queue',
  settlement_batches: 'Settlement batches',
  integration_plugins: 'Integration plugins',
};

const DASHBOARD_FILTER_LABELS: Record<string, string> = {
  mine: 'My work',
  ndr: 'NDR review',
  at_risk: 'At risk',
  list: 'List',
};

const DASHBOARD_ACTIVITY_LABELS: Record<string, string> = {
  decision_log: 'Decisions',
  audit_log: 'Audit activity',
  webhook_inbox: 'Webhook intake',
};

const DASHBOARD_COUNTER_LABELS: Record<string, string> = {
  route_runs: 'Route runs',
  cod: 'COD',
};

const DASHBOARD_SETTINGS_LABELS: Record<string, string> = {
  webhook_ingest_policy: 'Webhook intake policy',
  'pod.required_evidence': 'POD evidence policy',
};

function widgetTitle(w: Widget): string {
  const cfg = (w.config ?? {}) as { resource?: string; filter?: string; source?: string; category?: string };
  switch (w.kind) {
    case 'kpi_strip':
      return 'KPI · live operations';
    case 'queue': {
      const resource = DASHBOARD_RESOURCE_LABELS[cfg.resource ?? ''] ?? 'Queue';
      const filter = DASHBOARD_FILTER_LABELS[cfg.filter ?? 'list'] ?? humanizeKey(cfg.filter);
      return filter ? `${resource} · ${filter}` : resource;
    }
    case 'activity_feed':
      return DASHBOARD_ACTIVITY_LABELS[cfg.source ?? ''] ?? 'Activity feed';
    case 'status_grid':
      return 'Integration health';
    case 'counter_board':
      return cfg.source ? `${DASHBOARD_COUNTER_LABELS[cfg.source] ?? humanizeKey(cfg.source)} counters` : 'Counters';
    case 'scope_card':
      return DASHBOARD_SETTINGS_LABELS[cfg.category ?? ''] ?? 'Settings policy';
    case 'commands':
      return 'Quick commands';
    case 'planning_os':
      return 'Planning OS';
    default:
      return humanizeKey(w.kind);
  }
}

function WidgetBody({ widget }: { widget: Widget }) {
  switch (widget.kind) {
    case 'kpi_strip':
      return <KpiStripWidget />;
    case 'queue':
      return <QueueWidget config={widget.config ?? {}} />;
    case 'activity_feed':
      return <ActivityFeedWidget config={widget.config ?? {}} />;
    case 'status_grid':
      return <StatusGridWidget />;
    case 'counter_board':
      return <CounterBoardWidget config={widget.config ?? {}} />;
    case 'scope_card':
      return <ScopeCardWidget config={widget.config ?? {}} />;
    case 'commands':
      return <CommandsWidget config={widget.config ?? {}} />;
    case 'planning_os':
      return <PlanningOsWidget />;
    default:
      return (
        <div className="state__hint" style={{ padding: '12px' }}>{`Unknown widget · ${widget.kind}`}</div>
      );
  }
}

// ---------- Widget bodies ----------

function KpiStripWidget() {
  const { data, isLoading } = useDashboardKpis();
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  return (
    <div className="kpi-strip" style={{ borderTop: 'none' }}>
      {(data ?? []).map((k) => (
        <KPICard
          key={k.key}
          label={k.label}
          value={k.value as string | number}
          tone={(k.tone as 'good' | 'warn' | 'danger' | 'info' | 'neutral' | undefined) || 'neutral'}
          delta={k.delta}
          spark={k.spark}
        />
      ))}
    </div>
  );
}

function TasksQueueBody({ filter, limit }: { filter: Parameters<typeof useTasks>[0]; limit: number }) {
  const go = useConsoleNavigator();
  const { data, isLoading } = useTasks(filter);
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  return (
    <DataTable
      columns={[
        { key: 'task_id', label: 'Task', mono: true, sortable: false, filterable: false },
        { key: 'task_type', label: 'Type', lookup: 'task_type', sortable: false, filterable: false },
        { key: 'subject', label: 'Subject', sortable: false, filterable: false },
        { key: 'status', label: 'Status', lookup: 'task_status', sortable: false, filterable: false },
      ]}
      rows={(data ?? []).slice(0, limit) as Array<Record<string, unknown>>}
      allowSelection={false}
      onRowClick={(row) => {
        const id = String(row.task_id ?? row.id ?? '').trim();
        go(id ? `/workflows/review-queue?focus=${encodeURIComponent(id)}` : '/workflows/review-queue');
      }}
    />
  );
}

function ShipmentsQueueBody({ filter, limit }: { filter?: string; limit: number }) {
  const go = useConsoleNavigator();
  const { data, isLoading } = useResourceList<Record<string, unknown>>('shipments');
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  const rows = data?.rows ?? [];
  // W13-2: derive at-risk via canonical isShipmentRisk() — `risk_flag` was a
  // fictional column on `public.shipments` and is not on the FE row interface.
  // Source of truth: status (failed_attempt) or stalled OFD past promised_delivery_date.
  const filtered = filter === 'at_risk' ? rows.filter((r) => isShipmentRisk(r)) : rows;
  return (
      <DataTable
        columns={[
          { key: 'tracking_number', label: 'Tracking', mono: true, sortable: false, filterable: false },
          { key: 'service_type', label: 'Service', lookup: 'service_type', sortable: false, filterable: false },
          { key: 'destination_city', label: 'Destination', sortable: false, filterable: false },
          { key: 'status', label: 'Status', lookup: 'shipment_status', sortable: false, filterable: false },
        ]}
        rows={filtered.slice(0, limit)}
        allowSelection={false}
        onRowClick={(row) => {
          const id = String(row.tracking_number ?? row.shipment_id ?? row.id ?? '').trim();
          go(id ? `/operate/shipments?focus=${encodeURIComponent(id)}` : '/operate/shipments');
        }}
      />
    );
}

function SettlementsQueueBody({ limit }: { limit: number }) {
  const go = useConsoleNavigator();
  const { data, isLoading } = useResourceList<Record<string, unknown>>('settlement_batches');
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  return (
    <DataTable
      columns={[
        { key: 'batch_id', label: 'Batch', mono: true, sortable: false, filterable: false },
        { key: 'kind', label: 'Kind', lookup: 'settlement_kind', sortable: false, filterable: false },
        { key: 'expected_amount', label: 'Expected', align: 'right', format: 'currency', sortable: false, filterable: false },
        { key: 'status', label: 'Status', lookup: 'settlement_status', sortable: false, filterable: false },
      ]}
      rows={(data?.rows ?? []).slice(0, limit)}
      allowSelection={false}
      onRowClick={(row) => {
        const id = String(row.batch_id ?? row.id ?? '').trim();
        go(id ? `/finance/settlements?focus=${encodeURIComponent(id)}` : '/finance/settlements');
      }}
    />
  );
}

function IntegrationsQueueBody({ limit }: { limit: number }) {
  const go = useConsoleNavigator();
  const { data, isLoading } = useResourceList<Record<string, unknown>>('integration_plugins');
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  return (
    <DataTable
      columns={[
        { key: 'name', label: 'Plugin', sortable: false, filterable: false },
        { key: 'vendor', label: 'Vendor', sortable: false, filterable: false },
        { key: 'status', label: 'Status', lookup: 'plugin_status', sortable: false, filterable: false },
        { key: 'health', label: 'Health', align: 'right', format: 'percent', sortable: false, filterable: false },
      ]}
      rows={(data?.rows ?? []).slice(0, limit)}
      allowSelection={false}
      onRowClick={(row) => {
        const id = String(row.plugin_key ?? row.key ?? row.id ?? '').trim();
        go(id ? `/integrations/catalog?focus=${encodeURIComponent(id)}` : '/integrations/catalog');
      }}
    />
  );
}

function QueueWidget({ config }: { config: Record<string, unknown> }) {
  const cfg = config as { resource?: string; filter?: string; limit?: number };
  const limit = cfg.limit || 6;
  const { user } = useIdentity();
  if (cfg.resource === 'tasks') {
    const currentUserId = typeof user.id === 'string' ? user.id.trim() : '';
    const filter =
      cfg.filter === 'mine'
        ? currentUserId
          ? { assigned_to: currentUserId }
          : undefined
        : cfg.filter === 'ndr'
          ? { task_type: 'dispatch_exception_review' }
          : undefined;
    return <TasksQueueBody filter={filter} limit={limit} />;
  }
  if (cfg.resource === 'shipments') return <ShipmentsQueueBody filter={cfg.filter} limit={limit} />;
  if (cfg.resource === 'settlement_batches') return <SettlementsQueueBody limit={limit} />;
  if (cfg.resource === 'integration_plugins') return <IntegrationsQueueBody limit={limit} />;
  return <div className="state__hint" style={{ padding: '12px' }}>Queue source is not configured for this dashboard.</div>;
}

function ActivityFeedWidget({ config }: { config: Record<string, unknown> }) {
  const cfg = config as { source?: string; limit?: number };
  const limit = cfg.limit || 10;
  const { fmtDateTime } = useI18n();
  const canReadDecisionLog = useCapability(CAP.OBSERVABILITY_READ);

  if (cfg.source === 'decision_log' && canReadDecisionLog) {
    return <DecisionLogFeed limit={limit} fmtDateTime={fmtDateTime} />;
  }
  if (cfg.source === 'audit_log') return <AuditLogFeed limit={limit} fmtDateTime={fmtDateTime} />;
  if (cfg.source === 'webhook_inbox') return <WebhookInboxFeed limit={limit} fmtDateTime={fmtDateTime} />;
  return null;
}

type FmtDt = (iso: string) => string;

function humanizeKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Record';
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function decisionScopeLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Default scope';
  if (value === 'global') return 'Global default';
  if (value === 'tenant') return 'Tenant rule';
  if (value === 'client') return 'Client rule';
  return humanizeKey(value);
}

function settingValueSummary(value: unknown): Array<{ label: string; value: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ label: 'Value', value: String(value ?? 'Not configured') }];
  }
  return Object.entries(value as Record<string, unknown>).slice(0, 6).map(([key, raw]) => {
    let display = 'Configured';
    if (raw == null) display = 'Not configured';
    else if (typeof raw === 'boolean') display = raw ? 'Enabled' : 'Disabled';
    else if (typeof raw === 'number') display = String(raw);
    else if (typeof raw === 'string') display = raw.replace(/[_-]+/g, ' ');
    else if (Array.isArray(raw)) display = `${raw.length} item${raw.length === 1 ? '' : 's'}`;
    else display = `${Object.keys(raw as Record<string, unknown>).length} setting${Object.keys(raw as Record<string, unknown>).length === 1 ? '' : 's'}`;
    return { label: humanizeKey(key), value: display };
  });
}

function settingsResolutionLabel(value: unknown): string {
  const token = String(value ?? '').trim();
  if (!token) return 'Resolution pending';
  return `Resolution #${token.slice(-6).toUpperCase()}`;
}

function DecisionLogFeed({ limit, fmtDateTime }: { limit: number; fmtDateTime: FmtDt }) {
  const go = useConsoleNavigator();
  const { data, isLoading } = useDecisionLog({ limit });
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  return (
    <div className="activity-feed">
      {(data ?? []).map((d) => (
        <div key={String(d.id)} className="activity-row" onClick={() => go('/insights/decisions')}>
          <span className="mono" style={{ color: 'var(--ink-3)', fontSize: '10.5px', minWidth: '52px' }}>
            {fmtDateTime(String(d.timestamp ?? '')).split(',').pop()?.trim()}
          </span>
          <Chip size="xs" kind="info" label={d.decision_category} />
          <span style={{ fontSize: '11px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {humanizeKey(d.resource_type)}
          </span>
          <span style={{ fontSize: '10px', color: 'var(--ink-3)' }}>{decisionScopeLabel(d.resolved_from)}</span>
        </div>
      ))}
    </div>
  );
}

function AuditLogFeed({ limit, fmtDateTime }: { limit: number; fmtDateTime: FmtDt }) {
  const { data, isLoading, error } = useAuditLog({ limit });
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  if (error) return <div className="state__hint">Audit activity permission is required.</div>;
  return (
    <div className="activity-feed">
      {((data ?? []) as Array<Record<string, unknown>>).map((a, i) => (
        <div key={`${a.id ?? i}`} className="activity-row">
          <span className="mono" style={{ color: 'var(--ink-3)', fontSize: '10.5px', minWidth: '52px' }}>
            {fmtDateTime(String(a.occurred_at)).split(',').pop()?.trim()}
          </span>
          <Chip size="xs" label={String(a.op ?? 'updated').replace(/_/g, ' ')} />
          <span className="mono" style={{ fontSize: '11px', flex: 1 }}>
            {`${formatAuditSubject(a.table)} · ${formatAuditReference(a.pk)}`}
          </span>
          <span className="mono" style={{ fontSize: '10px', color: 'var(--ink-3)' }}>{String(a.actor)}</span>
        </div>
      ))}
    </div>
  );
}

function formatAuditSubject(value: unknown): string {
  const label = String(value ?? 'record')
    .replace(/^public\./, '')
    .replace(/_/g, ' ')
    .trim();
  return label ? label.replace(/\b[a-z]/g, (match) => match.toUpperCase()) : 'Record';
}

function formatAuditReference(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'record';
  const token = raw.split(/[,:|/#\s-]+/).filter(Boolean).pop() ?? raw;
  return `record #${token.slice(-6).toUpperCase()}`;
}

function WebhookInboxFeed({ limit, fmtDateTime }: { limit: number; fmtDateTime: FmtDt }) {
  const { data, isLoading } = useResourceList<Record<string, unknown>>('webhook_inbox');
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  const rows = (data?.rows ?? []).slice(0, limit);
  return (
    <div className="activity-feed">
      {rows.map((wb, i) => (
        <div key={`${wb.id ?? i}`} className="activity-row">
          <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)', minWidth: '52px' }}>
            {fmtDateTime(String(wb.received_at ?? '')).split(',').pop()?.trim()}
          </span>
          <Chip size="xs" kind={wb.status === 'processed' ? 'good' : wb.status === 'dead_letter' ? 'danger' : 'neutral'} label={humanizeKey(wb.status)} />
          <span className="mono" style={{ fontSize: '11px', flex: 1 }}>{String(wb.event_type)}</span>
        </div>
      ))}
    </div>
  );
}

function StatusGridWidget() {
  const go = useConsoleNavigator();
  const { data, isLoading } = useResourceList<Record<string, unknown>>('provider_health_latest');
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  return (
    <div className="status-grid">
      {(data?.rows ?? []).map((p, i) => (
        <div
          key={`${p.provider_id ?? i}`}
          className={`status-cell status-cell--${String(p.status)}`}
          onClick={() => {
            go('/integrations/health');
          }}
        >
          <div className="mono" style={{ fontWeight: 600, fontSize: '11.5px' }}>{String(p.provider_id)}</div>
          <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)', marginTop: '2px' }}>
            {String(p.status)}
          </div>
          <div className="mono" style={{ fontSize: '10.5px', marginTop: '4px' }}>
            <span>{`${(Number(p.success_rate_24h ?? 0) * 100).toFixed(1)}%`}</span>
            <span style={{ marginLeft: '6px', color: 'var(--ink-3)' }}>{`${p.avg_latency_ms ?? 0}ms`}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RouteRunsCounters() {
  const { data, isLoading } = useResourceList<Record<string, unknown>>('route_runs');
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  const counts: Record<string, number> = {};
  (data?.rows ?? []).forEach((r) => {
    const status = String(r.status);
    counts[status] = (counts[status] || 0) + 1;
  });
  return (
    <div className="counter-board">
      {Object.entries(counts).map(([k, v]) => (
        <div key={k} className="counter">
          <div className="counter__value">{v}</div>
          <div className="counter__label">{humanizeKey(k)}</div>
        </div>
      ))}
    </div>
  );
}

function CodCounters() {
  const { fmtCurrency } = useI18n();
  const { scope } = useIdentity();
  // No hardcoded tenant fallback. In seed mode scope.tenant.id is populated
  // from seed.current_scope; in live mode IdentityProvider hydrates from
  // the real Supabase session. Empty string signals pre-auth/unset state.
  const { data, isLoading } = useCodSummary({ tenant: scope.tenant?.id ?? '' });
  if (isLoading) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  const summary = (data ?? {}) as { expected?: number; collected?: number; remitted?: number; variance?: number };
  return (
    <div className="counter-board">
      <div className="counter"><div className="counter__value">{fmtCurrency(summary.expected ?? 0)}</div><div className="counter__label">expected</div></div>
      <div className="counter"><div className="counter__value">{fmtCurrency(summary.collected ?? 0)}</div><div className="counter__label">collected</div></div>
      <div className="counter"><div className="counter__value">{fmtCurrency(summary.remitted ?? 0)}</div><div className="counter__label">remitted</div></div>
      <div className="counter"><div className="counter__value">{fmtCurrency(summary.variance ?? 0)}</div><div className="counter__label">variance</div></div>
    </div>
  );
}

function CounterBoardWidget({ config }: { config: Record<string, unknown> }) {
  const cfg = config as { source?: string };
  if (cfg.source === 'route_runs') return <RouteRunsCounters />;
  if (cfg.source === 'cod') return <CodCounters />;
  return <div className="state__hint" style={{ padding: '12px' }}>Counter board source not configured.</div>;
}

// Stub guard — keep the legacy block below from compiling. We replaced it above.

function ScopeCardWidget({ config }: { config: Record<string, unknown> }) {
  const cfg = config as { category?: string };
  const cat = cfg.category || 'pod.required_evidence';
  const { data, isLoading } = useResolveSettings(cat);
  const { scope } = useIdentity();
  if (isLoading || !data) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  // No hardcoded tenant fallback for the ScopePill display id; pull from
  // the active identity scope when the resolver reports a tenant winner.
  return (
    <div style={{ padding: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span className="mono" style={{ fontWeight: 600, fontSize: '12px' }}>{DASHBOARD_SETTINGS_LABELS[cat] ?? humanizeKey(cat)}</span>
        <ScopePill scopeType={data.resolved_from} scopeId={data.resolved_from === 'global' ? 'global' : (scope.tenant?.id ?? '')} />
        <span className="mono" style={{ fontSize: '10px', color: 'var(--ink-3)' }}>{settingsResolutionLabel(data.settings_resolution_id)}</span>
      </div>
      <div
        style={{
          background: 'var(--paper-3)',
          padding: '8px',
          borderRadius: '4px',
          fontSize: '11px',
          display: 'grid',
          gap: '6px',
          margin: 0,
        }}
      >
        {settingValueSummary(data.value).map((item) => (
          <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{ color: 'var(--ink-3)' }}>{item.label}</span>
            <span className="mono" style={{ textAlign: 'right' }}>{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandsWidget({ config }: { config: Record<string, unknown> }) {
  const cfg = config as { limit?: number };
  const limit = cfg.limit || 5;
  const registry = useMemo(
    () => api.getCommandRegistry() as CommandRegistryRow[],
    [],
  );
  return (
    <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {registry.slice(0, limit).map((c) => (
        <CommandRow key={c.key} cmd={c} />
      ))}
    </div>
  );
}

interface CommandRegistryRow {
  key: string;
  label: string;
  capability: string;
  execution?: unknown;
  target?: unknown;
  route_targets?: unknown;
}

export function formatCommandExecution(execution: unknown, target?: unknown): string {
  if (typeof execution === 'string') {
    const trimmed = execution.trim();
    if (trimmed === 'rpc') return 'System action';
    if (trimmed === 'workflow') return 'Workflow action';
    return trimmed ? humanizeKey(trimmed) : 'Command action';
  }
  if (execution && typeof execution === 'object' && !Array.isArray(execution)) {
    const row = execution as Record<string, unknown>;
    const type = typeof row.type === 'string' && row.type.trim()
      ? row.type.trim()
      : typeof row.kind === 'string' && row.kind.trim()
        ? row.kind.trim()
        : typeof row.mode === 'string' && row.mode.trim()
          ? row.mode.trim()
          : 'command';
    if (type === 'rpc') return 'System action';
    if (type === 'workflow') return 'Workflow action';
    return type ? humanizeKey(type) : 'Command action';
  }
  return typeof target === 'string' && target.trim() ? 'Command action' : 'Command action';
}

function commandRouteTarget(cmd: CommandRegistryRow): string | null {
  const routeTargets = cmd.route_targets;
  if (routeTargets && typeof routeTargets === 'object') {
    const consoleTarget = (routeTargets as { console?: unknown }).console;
    if (typeof consoleTarget === 'string' && consoleTarget.trim()) return consoleTarget.trim();
    if (consoleTarget && typeof consoleTarget === 'object') {
      const target = consoleTarget as { path?: unknown; route?: unknown };
      if (typeof target.path === 'string' && target.path.trim()) return target.path.trim();
      if (typeof target.route === 'string' && target.route.trim()) return target.route.trim();
    }
  }
  const target = cmd.target;
  if (target && typeof target === 'object') {
    const route = (target as { path?: unknown; route?: unknown }).path ??
      (target as { path?: unknown; route?: unknown }).route;
    if (typeof route === 'string' && route.trim().startsWith('/')) return route.trim();
  }
  return null;
}

function CommandRow({ cmd }: { cmd: CommandRegistryRow }) {
  const allowed = useCapability(cmd.capability);
  const go = useConsoleNavigator();
  const executionLabel = formatCommandExecution(cmd.execution, cmd.target);
  const actionLabel = allowed ? executionLabel : formatCapabilityRequirement(cmd.capability);
  const routeTarget = commandRouteTarget(cmd);
  const openCommandSurface = () => {
    if (!allowed) {
      pushToast(formatCapabilityTitle(cmd.capability), 'warn');
      return;
    }
    if (routeTarget) {
      go(routeTarget);
      return;
    }
    const trigger = document.getElementById('cmd-trigger');
    if (trigger instanceof HTMLElement) {
      trigger.click();
      pushToast(`Open command palette for ${cmd.label}`, 'info');
      return;
    }
    pushToast('Command palette trigger is unavailable', 'warn');
  };
  return (
    <button
      className="card"
      type="button"
      aria-busy={false}
      disabled={!allowed}
      title={allowed ? undefined : actionLabel}
      style={{
        textAlign: 'left',
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: allowed ? 'pointer' : 'not-allowed',
        opacity: allowed ? 1 : 0.55,
      }}
      onClick={openCommandSurface}
    >
      <Icon name="cmd" size={12} style={{ color: 'var(--accent)' }} />
      <span style={{ flex: 1, fontWeight: 500, fontSize: '12px' }}>
        {cmd.label}
      </span>
      <span
        className="mono"
        style={{ fontSize: '10px', color: 'var(--ink-3)', textAlign: 'right', lineHeight: 1.25 }}
      >
        {actionLabel}
      </span>
    </button>
  );
}

function PlanningOsWidget() {
  const [cards, setCards] = useState<Array<{ issue_number: number; title: string; status: string }> | null>(null);
  useEffect(() => {
    (async () => {
      const list = await ((api as unknown) as { listExecutionCards?: () => Promise<Array<{ issue_number: number; title: string; status: string }>> })
        .listExecutionCards?.();
      setCards(list ?? []);
    })();
  }, []);
  if (cards == null) return <div className="state__hint" style={{ padding: '12px' }}>Loading…</div>;
  if (!cards.length) return <StateView kind="empty" hint="No execution cards." />;
  return (
    <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {cards.slice(0, 5).map((c) => (
        <div
          key={c.issue_number}
          className="card"
          style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Chip size="xs" label={`#${c.issue_number}`} />
          <span style={{ flex: 1, fontSize: '12px' }}>{c.title}</span>
          <Chip size="xs" kind={c.status === 'Done' ? 'good' : 'info'} label={c.status} />
        </div>
      ))}
    </div>
  );
}
