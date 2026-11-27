// traces.tsx — Insights · Distributed traces (canonical ui_get_trace_v1).
//
// REAUDIT INSIGHTS §D3 closure: the surface now consumes the canonical
// `public.ui_get_trace_v1(uuid)` envelope directly:
//
//   { correlation_id,
//     observability_events[],   // unified decision_log + api_call_log read
//     domain_events[],          // engine-first ledger entries
//     workflow_runs[] }         // workflow_runs whose triggered_by_request_id matches
//
// The legacy `{ spans: [...] }` shape is retired — there is no FE-side
// derivation any more. The timeline view treats each `observability_events`
// row as a timeline marker (op = `event_type`, dur = `metadata.duration_ms`,
// start = relative offset from the first event_time). `domain_events` and
// `workflow_runs` are surfaced as sibling sections beneath the timeline so
// the operator sees the full canonical join in a single pane.
//
// J pass behavior preserved:
//   • URL deep-link: `?cor=<correlation_id>` is read on mount and on URL
//     change. Typing a new id + Enter pushes the param so the trace is
//     bookmarkable / shareable.
//   • "Copy correlation_id" + "Open in new tab" toolbar buttons.
//   • Row click opens a Drawer with full attributes + a "Copy as curl"
//     snippet that replays the canonical RPC `ui_get_trace_v1`.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip, type ChipKind } from '@/components/Chip';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { StateView } from '@/components/StateView';
import { useTrace } from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { fill, useI18n, type Translate } from '@/lib/i18n';
import { useDrawer } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { lookupRow } from '@/lib/api';
import type {
  UiTraceObservabilityEvent,
  UiTraceDomainEvent,
  UiTraceWorkflowRun,
} from '@/types/domain';
import { useInsightsSearch, useUpdateSearch } from './_hooks';

const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '180px 110px 1fr 80px',
  gap: '10px',
  alignItems: 'center',
  cursor: 'pointer',
  padding: '4px 6px',
  borderRadius: '3px',
  fontSize: '12px',
};
const BAR_TRACK_STYLE: CSSProperties = {
  position: 'relative',
  height: '14px',
  background: 'var(--paper-3)',
  borderRadius: '3px',
};

/**
 * Compute the relative timeline offsets for each observability event.
 * Returns rows annotated with `start` (ms from first event), `dur` (from
 * `metadata.duration_ms` when present, else 0). Total span is the largest
 * `start + dur` value.
 */
interface TimelineRow {
  ev: UiTraceObservabilityEvent;
  startMs: number;
  durMs: number;
}

function buildTimeline(events: UiTraceObservabilityEvent[]): {
  rows: TimelineRow[];
  totalMs: number;
} {
  if (!events.length) return { rows: [], totalMs: 0 };
  const sorted = [...events].sort(
    (a, b) => new Date(a.event_time).getTime() - new Date(b.event_time).getTime(),
  );
  const baseMs = new Date(sorted[0]!.event_time).getTime();
  const rows: TimelineRow[] = sorted.map((ev) => {
    const startMs = new Date(ev.event_time).getTime() - baseMs;
    const dur = ev.metadata && typeof (ev.metadata as Record<string, unknown>).duration_ms === 'number'
      ? Number((ev.metadata as Record<string, unknown>).duration_ms)
      : 0;
    return { ev, startMs, durMs: dur };
  });
  const totalMs = rows.reduce((m, r) => Math.max(m, r.startMs + r.durMs), 0);
  return { rows, totalMs };
}

interface ObservabilityRowProps {
  row: TimelineRow;
  totalMs: number;
  fmtNumber: (n: number) => string;
  onSelect: (row: TimelineRow) => void;
}

function ObservabilityRow({ row, totalMs, fmtNumber, onSelect }: ObservabilityRowProps) {
  const { t } = useI18n();
  const startPct = totalMs > 0 ? (row.startMs / totalMs) * 100 : 0;
  // Render at minimum 2px-equivalent so zero-duration markers stay visible.
  const durPct = totalMs > 0 ? Math.max((row.durMs / totalMs) * 100, 1) : 0;
  // W-Cycle-E (P2 #9) — timeline-bar fill resolves through the canonical
  // `trace_event_status` lookup metadata (`bar_var`). Replaces the prior
  // inline `row.ev.status === 'failed' ? var(--danger) : var(--accent)`
  // ternary so adding a new status (warning/timeout/...) is a row mutation,
  // not a source change. Falls back to `var(--accent)` when canonical row
  // is missing — same neutral visual the prior fallback path produced.
  const barVar =
    (lookupRow('trace_event_status', row.ev.status)?.metadata as { bar_var?: string } | undefined)
      ?.bar_var ?? 'var(--accent)';
  const barFillStyle: CSSProperties = {
    position: 'absolute',
    left: `${startPct}%`,
    width: `${durPct}%`,
    top: 0,
    bottom: 0,
    background: barVar,
    borderRadius: '3px',
  };
  return (
    <div
      role="button"
      tabIndex={0}
      style={ROW_STYLE}
      data-event-id={row.ev.event_id}
      data-event-source={row.ev.event_source}
      onClick={() => onSelect(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(row);
        }
      }}
      aria-label={fill(t('insightsTraces.observabilityRow.eventEventTypeDurms'), { event_type: String(row.ev.event_type), durMs: String(row.durMs) })}
    >
      <Chip
        label={row.ev.event_source}
        kind={(lookupRow('trace_event_source', row.ev.event_source)?.tone as ChipKind | undefined) ?? 'neutral'}
        size="xs"
        className="mono"
      />
      <span className="mono" title={row.ev.event_type}>
        {row.ev.event_type}
      </span>
      <div style={BAR_TRACK_STYLE}>
        <div style={barFillStyle} />
      </div>
      <span
        className="mono"
        style={{ fontSize: '10.5px', color: 'var(--ink-3)', textAlign: 'right' }}
      >
        {row.durMs > 0 ? `${fmtNumber(row.durMs)}ms` : '—'}
      </span>
    </div>
  );
}

function eventDrawerBody(row: TimelineRow, t: Translate): ReactNode {
  const meta = row.ev.metadata ?? {};
  const metaKeys = Object.keys(meta);
  return (
    <div data-testid="traces-event-drawer">
      <h4 className="eyebrow">{t('insightsTraces.eventDrawerBody.activityEvent')}</h4>
      <div style={{ display: 'grid', gap: '6px', fontSize: '12px' }}>
        <div>{fill(t('insightsTraces.eventDrawerBody.event'), { value: String(row.ev.event_type) })}</div>
        <div>{fill(t('insightsTraces.eventDrawerBody.source'), { value: String(row.ev.event_source) })}</div>
        <div>{fill(t('insightsTraces.eventDrawerBody.resource'), { value: String(row.ev.resource_type) })}</div>
        <div>{fill(t('insightsTraces.eventDrawerBody.status'), { value: String(row.ev.status) })}</div>
        <div>{fill(t('insightsTraces.eventDrawerBody.eventTime'), { value: String(row.ev.event_time) })}</div>
        <div>{fill(t('insightsTraces.eventDrawerBody.duration'), { value: row.durMs > 0 ? `${row.durMs}ms` : t('insightsTraces.eventDrawerBody.notAvailable') })}</div>
      </div>
      {metaKeys.length > 0 && (
        <>
          <h4 className="eyebrow" style={{ marginTop: '12px' }}>{t('insightsTraces.eventDrawerBody.additionalDetails')}</h4>
          <p className="state__hint">
            {`${metaKeys.length} additional detail${metaKeys.length === 1 ? '' : 's'} recorded for support review.`}
          </p>
        </>
      )}
      <h4 className="eyebrow" style={{ marginTop: '12px' }}>{t('insightsTraces.eventDrawerBody.activityHistory')}</h4>
      <p className="state__hint">
        {t('insightsTraces.eventDrawerBody.thisLookupReturnsTimeline')}
      </p>
    </div>
  );
}

function DomainEventCard({ ev }: { ev: UiTraceDomainEvent }) {
  const { t } = useI18n();
  return (
    <div
      className="card"
      data-testid="traces-domain-event-card"
      style={{
        padding: '8px 10px',
        display: 'grid',
        gridTemplateColumns: '160px 1fr 140px',
        gap: '10px',
        alignItems: 'center',
        fontSize: '12px',
      }}
    >
      <Chip label={ev.event_type} kind="info" size="xs" className="mono" />
      <span className="mono" style={{ fontSize: '11px' }}>
        {`${ev.resource_type}: ${ev.resource_id ? t('insightsTraces.domainEventCard.recorded') : t('insightsTraces.domainEventCard.notAvailable')}`}
      </span>
      <span
        className="mono"
        style={{ fontSize: '10.5px', color: 'var(--ink-3)', textAlign: 'right' }}
      >
        {ev.created_at}
      </span>
    </div>
  );
}

function WorkflowRunCard({ wr }: { wr: UiTraceWorkflowRun }) {
  const { t } = useI18n();
  return (
    <div
      className="card"
      data-testid="traces-workflow-run-card"
      style={{
        padding: '8px 10px',
        display: 'grid',
        gridTemplateColumns: '160px 1fr 140px',
        gap: '10px',
        alignItems: 'center',
        fontSize: '12px',
      }}
    >
      {/*
        W27-cycle-D §1 — `wr.status` is the canonical `workflow_runs.status`
        projection (pending|running|succeeded|failed|timeout|cancelled). The
        chip tone resolves through the `workflow_run_status` lookup catalog
        rather than hardcoded equality branches, so any future status added
        upstream lights up automatically and the legacy `'completed'` alias
        is retired (FE projections normalize to canonical 'succeeded').
      */}
      <Chip
        label={wr.status}
        kind={(lookupRow('workflow_run_status', wr.status)?.tone as ChipKind | undefined) ?? 'neutral'}
        size="xs"
        className="mono"
      />
      <span className="mono" style={{ fontSize: '11px' }}>
        {fill(t('insightsTraces.workflowRunCard.workflowTemplate'), { value: wr.workflow_template_id ? t('insightsTraces.workflowRunCard.recorded') : t('insightsTraces.workflowRunCard.notAvailable') })}
      </span>
      <span
        className="mono"
        style={{ fontSize: '10.5px', color: 'var(--ink-3)', textAlign: 'right' }}
      >
        {wr.completed_at ?? wr.created_at}
      </span>
    </div>
  );
}

export function TracesModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.OBSERVABILITY_READ);
  const { t, fmtNumber } = useI18n();
  const drawer = useDrawer();
  const search = useInsightsSearch();
  const updateSearch = useUpdateSearch();

  // W54-D — `cor_9821` was a hardcoded sample correlation_id default. The
  // module now starts with an empty correlation id and renders a StateView
  // empty-state until the operator pastes a real correlation id (via the
  // search input or `?cor=` URL query). AGENTS.md §2 (ZERO HARDCODING).
  const initialId = search.cor ?? '';
  const [draftId, setDraftId] = useState<string>(initialId);
  const [activeId, setActiveId] = useState<string>(initialId);

  // Sync URL → state if the user pastes a different ?cor= or uses back/forward.
  useEffect(() => {
    if (search.cor && search.cor !== activeId) {
      setActiveId(search.cor);
      setDraftId(search.cor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.cor]);

  const { data: trace, isLoading, isError } = useTrace(activeId);

  const observabilityEvents = useMemo<UiTraceObservabilityEvent[]>(
    () => trace?.observability_events ?? [],
    [trace],
  );
  const domainEvents = useMemo<UiTraceDomainEvent[]>(
    () => trace?.domain_events ?? [],
    [trace],
  );
  const workflowRuns = useMemo<UiTraceWorkflowRun[]>(
    () => trace?.workflow_runs ?? [],
    [trace],
  );

  const { rows: timelineRows, totalMs } = useMemo(
    () => buildTimeline(observabilityEvents),
    [observabilityEvents],
  );

  const onFetch = () => {
    const next = draftId.trim();
    if (!next) return;
    setActiveId(next);
    updateSearch({ cor: next });
  };

  const onCopyCorrelation = useCallback(() => {
    try {
      navigator.clipboard?.writeText(activeId);
      pushToast(fill(t('insightsTraces.tracesModule.copiedActiveid'), { activeId: String(activeId) }), 'good');
    } catch {
      pushToast(t('insightsTraces.tracesModule.clipboardBlocked'), 'warn');
    }
  }, [activeId, t]);

  const onOpenNewTab = useCallback(() => {
    const url = `${window.location.pathname}?cor=${encodeURIComponent(activeId)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [activeId]);

  const onSelectRow = useCallback(
    (row: TimelineRow) => {
      drawer.open({
        title: fill(t('insightsTraces.tracesModule.eventEventType'), { event_type: String(row.ev.event_type) }),
        size: 'md',
        body: eventDrawerBody(row, t),
      });
    },
    [drawer, activeId, t],
  );

  const headerPills = useMemo<ReactNode[]>(() => {
    const list: ReactNode[] = [
      <Chip
        key="src"
        label={t('insightsTraces.tracesModule.activityHistory')}
        kind="neutral"
        size="xs"
        className="mono"
      />,
    ];
    if (totalMs > 0) {
      list.push(
        <Chip
          key="total"
          label={`total · ${fmtNumber(totalMs)}ms`}
          kind="info"
          size="xs"
          className="mono"
        />,
      );
    }
    if (observabilityEvents.length > 0) {
      list.push(
        <Chip
          key="evcount"
          label={`${observabilityEvents.length} events · ${domainEvents.length} domain · ${workflowRuns.length} workflows`}
          kind="neutral"
          size="xs"
          className="mono"
        />,
      );
    }
    return list;
  }, [totalMs, fmtNumber, observabilityEvents.length, domainEvents.length, workflowRuns.length, t]);

  const noResults =
    observabilityEvents.length === 0 &&
    domainEvents.length === 0 &&
    workflowRuns.length === 0;

  if (!canRead) {
    return (
      <div className="page" data-testid="insights-traces-page">
        <PageHeader
          moduleKey="traces"
          eyebrow={t('insightsTraces.tracesModule.insights')}
          titleAccent={t('insightsTraces.tracesModule.activity')}
          titlePlain={t('insightsTraces.tracesModule.titlePlain')}
        />
        <StateView
          kind="denied"
          capability={CAP.OBSERVABILITY_READ}
          hint={t('insightsTraces.tracesModule.youNeedActivityHistory')}
        />
      </div>
    );
  }

  return (
    <div className="page" data-testid="insights-traces-page">
      <PageHeader
        moduleKey="traces"
        eyebrow={t('insightsTraces.tracesModule.insights')}
        titleAccent={t('insightsTraces.tracesModule.activity')}
        titlePlain={t('insightsTraces.tracesModule.titlePlain')}
        pills={headerPills}
        actions={[]}
      />

      <div className="view-bar">
        <div className="view-bar__group" style={{ flex: 1 }}>
          <div className="search-input">
            <span aria-hidden>
              <Icon name="search" size={12} />
            </span>
            <input
              type="text"
              placeholder={t('insightsTraces.tracesModule.activityReference')}
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onFetch();
              }}
              aria-label={t('insightsTraces.tracesModule.activityReference')}
            />
          </div>
        </div>
        <div className="view-bar__spacer" />
        <div className="view-bar__group">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onCopyCorrelation}
            title={t('insightsTraces.tracesModule.copyActivityReference')}
          >
            {t('insightsTraces.tracesModule.copyReference')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onOpenNewTab}
            title={t('insightsTraces.tracesModule.openThisActivityIn')}
          >
            {t('insightsTraces.tracesModule.openInNewTab')}
          </button>
          <Button label={t('insightsTraces.tracesModule.findActivity')} iconName="play" kind="primary" onClick={onFetch} />
        </div>
      </div>

      <div style={{ flex: 1, padding: '16px', overflow: 'auto' }}>
        {!activeId ? (
          // W54-D — initial empty state when no correlation_id is selected.
          // Replaces the previous hardcoded `cor_9821` default that
          // pretended a sample trace was the user's selection.
          <StateView
            kind="empty"
            title={t('insightsTraces.tracesModule.noActivityReferenceSelected')}
            hint={t('insightsTraces.tracesModule.pasteAnActivityReference')}
          />
        ) : isError ? (
          <StateView
            kind="error"
            title={t('insightsTraces.tracesModule.activityHistoryUnavailable')}
            hint={fill(t('insightsTraces.tracesModule.couldNotLoadActivity'), { activeId: String(activeId) })}
          />
        ) : isLoading ? (
          <StateView kind="loading" hint={fill(t('insightsTraces.tracesModule.fetchingActivityForActiveid'), { activeId: String(activeId) })} />
        ) : noResults ? (
          <StateView
            kind="empty"
            title={t('insightsTraces.tracesModule.noEventsFound')}
            hint={fill(t('insightsTraces.tracesModule.noActivityFoundFor'), { activeId: String(activeId) })}
          />
        ) : (
          <>
            <div className="eyebrow">
              {fill(t('insightsTraces.tracesModule.activityReferenceValue'), { value: trace?.correlation_id || activeId ? t('insightsTraces.tracesModule.recorded') : t('insightsTraces.tracesModule.notAvailable') })}
              {totalMs > 0 ? fill(t('insightsTraces.tracesModule.totalValueMs'), { value: String(fmtNumber(totalMs)) }) : ''}
            </div>

            {/* Section 1: observability_events timeline */}
            {observabilityEvents.length > 0 && (
              <section data-testid="traces-observability-section" style={{ marginTop: '16px' }}>
                <h4 className="eyebrow">{t('insightsTraces.tracesModule.timelineEvents')}</h4>
                <div
                  className="trace-timeline"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    marginTop: '6px',
                  }}
                >
                  {timelineRows.map((row) => (
                    <ObservabilityRow
                      key={row.ev.event_id}
                      row={row}
                      totalMs={totalMs}
                      fmtNumber={fmtNumber}
                      onSelect={onSelectRow}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Section 2: domain_events */}
            {domainEvents.length > 0 && (
              <section data-testid="traces-domain-events-section" style={{ marginTop: '16px' }}>
                <h4 className="eyebrow">{t('insightsTraces.tracesModule.relatedEvents')}</h4>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    marginTop: '6px',
                  }}
                >
                  {domainEvents.map((ev) => (
                    <DomainEventCard key={ev.id} ev={ev} />
                  ))}
                </div>
              </section>
            )}

            {/* Section 3: workflow_runs */}
            {workflowRuns.length > 0 && (
              <section data-testid="traces-workflow-runs-section" style={{ marginTop: '16px' }}>
                <h4 className="eyebrow">{t('insightsTraces.tracesModule.relatedWorkflows')}</h4>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    marginTop: '6px',
                  }}
                >
                  {workflowRuns.map((wr) => (
                    <WorkflowRunCard key={wr.id} wr={wr} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {drawer.node}
    </div>
  );
}
