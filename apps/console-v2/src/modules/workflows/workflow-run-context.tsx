import { type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import type { ChipKind } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import type { UseDrawerHandle } from '@/hooks/useOverlay';
import { lookupRow } from '@/lib/api';

export interface WorkflowRunContextRecord {
  id: string;
  status?: string | null;
  workflow_status?: string | null;
  correlation_id?: string | null;
  template_id?: string | null;
  template_name?: string | null;
  workflow_template_key?: string | null;
}

export interface WorkflowRunDomainEvent {
  id: string;
  event_type?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  workflow_run_id?: string | null;
  correlation_id?: string | null;
}

export interface WorkflowRunContextRow {
  label: string;
  value: ReactNode;
}

export interface OpenWorkflowRunContextDrawerOptions {
  workflowRunId: string;
  run?: WorkflowRunContextRecord | null;
  events?: WorkflowRunDomainEvent[];
  contextRows?: WorkflowRunContextRow[];
  deepLink?: string;
  onOpenTrace?: (() => void) | null;
  onOpenWorkflowModule?: (() => void) | null;
}

function canonicalChip(category: string, value: unknown): ReactNode {
  const normalized = String(value ?? '').trim();
  if (!normalized) return 'Waiting for saved result';
  const row = lookupRow(category, normalized);
  const tone = row?.tone as ChipKind | undefined;
  return tone && row?.label
    ? <Chip label={row.label} kind={tone} size="xs" />
    : <Chip label="Needs review" kind="danger" size="xs" />;
}

function workflowTemplateLabel(run: WorkflowRunContextRecord | null | undefined): ReactNode {
  return (
    run?.template_name ??
    run?.workflow_template_key?.replace(/[_-]+/g, ' ') ??
    'Waiting for saved result'
  );
}

function workflowStatus(run: WorkflowRunContextRecord | null | undefined): string | null {
  return run?.status ?? run?.workflow_status ?? null;
}

export function WorkflowRunContextPanel({
  workflowRunId,
  run,
  events = [],
  contextRows = [],
}: OpenWorkflowRunContextDrawerOptions) {
  return (
    <div className="rail-body" style={{ paddingBottom: 0 }}>
      <h4 className="eyebrow">Workflow run context</h4>
      <div className="kvgrid" aria-label="Workflow run context">
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Run</span>
          <span className="kvgrid__val mono">{workflowRunId}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Status</span>
          <span className="kvgrid__val mono">{canonicalChip('workflow_run_status', workflowStatus(run))}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Template</span>
          <span className="kvgrid__val mono">{workflowTemplateLabel(run)}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Request trail</span>
          <span className="kvgrid__val mono">{run?.correlation_id ? 'Recorded' : 'Awaiting saved data'}</span>
        </div>
        {contextRows.map((item) => (
          <div key={item.label} className="kvgrid__row">
            <span className="kvgrid__key mono">{item.label}</span>
            <span className="kvgrid__val mono">{item.value}</span>
          </div>
        ))}
      </div>
      <div className="card" style={{ background: 'var(--paper-2)', marginTop: '12px' }}>
        <h4 className="eyebrow" style={{ marginBottom: '8px' }}>Related activity</h4>
        {events.length ? (
          <div style={{ display: 'grid', gap: '8px' }}>
            {events.map((event) => (
              <div
                key={event.id}
                className="kvgrid__row"
                style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px' }}
              >
                <span className="kvgrid__key mono">{event.event_type ?? 'Activity recorded'}</span>
                <span className="kvgrid__val mono">Related record: Recorded</span>
              </div>
            ))}
          </div>
        ) : (
          <StateView
            kind="empty"
            title="No related activity yet"
            hint="The workflow run is visible, but no related activity has been saved yet."
          />
        )}
      </div>
    </div>
  );
}

export function openWorkflowRunContextDrawer(
  drawer: Pick<UseDrawerHandle, 'open'>,
  options: OpenWorkflowRunContextDrawerOptions,
): void {
  drawer.open({
    title: 'Workflow run',
    size: 'md',
    deepLink: options.deepLink,
    body: <WorkflowRunContextPanel {...options} />,
    footer: options.onOpenTrace || options.onOpenWorkflowModule ? (
      <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
        {options.onOpenTrace ? (
          <Button label="Open activity history" iconName="trace_tree" kind="ghost" onClick={options.onOpenTrace} />
        ) : null}
        <div style={{ flex: 1 }} />
        {options.onOpenWorkflowModule ? (
          <Button
            label="Open workflow module"
            iconName="external_link"
            kind="ghost"
            onClick={options.onOpenWorkflowModule}
          />
        ) : null}
      </div>
    ) : undefined,
  });
}
