import { useMemo } from 'react';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KPICard, type KPITone } from '@/components/KPICard';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { CAP } from '@/lib/capabilities';
import { useCapability } from '@/lib/identity';
import { useResourceList } from '@/lib/queries';

interface ReleaseDeployProofRow extends Record<string, unknown> {
  id: string;
  proof_scope: string;
  surface_id: string;
  surface_label: string;
  stage: string;
  deploy_environment: string;
  stage_workflow_file: string;
  evidence_workflow_file: string | null;
  workflow_name: string;
  artifact_name: string | null;
  json_entry_suffix: string | null;
  evidence_status: string;
  evidence_required: boolean;
  proof_guard: string;
  source_paths: string[];
  doc_paths: string[];
  notes: string;
}

function statusKind(status: string): ChipKind {
  if (status === 'configured' || status === 'passed' || status === 'active') return 'good';
  if (status === 'missing_evidence_contract' || status === 'missing' || status === 'blocked') return 'danger';
  if (status === 'partial' || status === 'warning') return 'warn';
  return 'neutral';
}

function kpiTone(status: string): KPITone {
  if (status === 'configured') return 'good';
  if (status.includes('missing')) return 'danger';
  return 'neutral';
}

function pathTags(paths: string[] | null | undefined) {
  if (!paths?.length) return null;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {paths.map((path) => (
        <span key={path} className="chip chip--xs mono">
          {path}
        </span>
      ))}
    </span>
  );
}

const columns: Array<DataTableColumn<ReleaseDeployProofRow>> = [
  { key: 'surface_label', label: 'Surface', type: 'text', sortable: true, filterable: true, width: '220px' },
  { key: 'surface_id', label: 'Key', type: 'text', mono: true, sortable: true, filterable: true },
  { key: 'stage', label: 'Stage', type: 'text', mono: true, sortable: true, filterable: true },
  { key: 'deploy_environment', label: 'Env', type: 'text', mono: true, sortable: true, filterable: true },
  {
    key: 'evidence_status',
    label: 'Evidence',
    type: 'select',
    sortable: true,
    filterable: true,
    render: (raw) => <Chip label={String(raw ?? 'missing')} kind={statusKind(String(raw ?? 'missing'))} size="xs" />,
  },
  { key: 'stage_workflow_file', label: 'Stage workflow', type: 'text', mono: true, sortable: true, filterable: true },
  { key: 'artifact_name', label: 'Artifact', type: 'text', mono: true, sortable: true, filterable: true },
  { key: 'json_entry_suffix', label: 'Manifest', type: 'text', mono: true, sortable: true, filterable: true },
  { key: 'proof_guard', label: 'Guard', type: 'text', sortable: true, filterable: true },
  { key: 'source_paths', label: 'Config evidence', render: (raw) => pathTags(raw as string[]) },
  { key: 'doc_paths', label: 'Docs', render: (raw) => pathTags(raw as string[]) },
];

export function ReleaseProofModule() {
  const canRead = useCapability(CAP.SETTINGS_READ);
  const proofQuery = useResourceList<ReleaseDeployProofRow>(
    'release_deploy_proof_governance',
    { sort: { key: 'surface_id', dir: 'asc' }, page_size: 1000 },
    { enabled: canRead },
  );
  const rows = proofQuery.data?.rows ?? [];

  const kpis = useMemo(() => {
    const configured = rows.filter((row) => row.evidence_status === 'configured').length;
    const gaps = rows.filter((row) => row.evidence_status.includes('missing')).length;
    const consoleGaps = rows.filter(
      (row) => row.surface_id === 'console' && row.evidence_status !== 'configured',
    ).length;
    const docsLinked = rows.filter((row) => row.doc_paths.length > 0).length;
    return [
      { key: 'total', label: 'Proof rows', value: rows.length, tone: 'neutral' as KPITone },
      { key: 'configured', label: 'Configured', value: configured, tone: 'good' as KPITone },
      { key: 'gaps', label: 'Evidence gaps', value: gaps, tone: gaps > 0 ? 'danger' as KPITone : 'good' as KPITone },
      { key: 'console', label: 'Console gaps', value: consoleGaps, tone: kpiTone(consoleGaps ? 'missing' : 'configured') },
      { key: 'docs', label: 'Docs linked', value: docsLinked, tone: 'info' as KPITone },
    ];
  }, [rows]);

  if (!canRead) {
    return (
      <div className="page" data-testid="release-proof-page">
        <PageHeader eyebrow="Platform" titleAccent="Release" titlePlain="proof" />
        <StateView
          kind="denied"
          capability={CAP.SETTINGS_READ}
          hint="Release proof governance requires settings permission."
        />
      </div>
    );
  }

  return (
    <div className="page" data-testid="release-proof-page">
      <PageHeader
        eyebrow="Platform"
        titleAccent="Release"
        titlePlain="proof"
        pills={[
          <Chip key="ro" label="read-only" kind="info" size="xs" />,
          <span key="rpc" className="chip chip--xs mono">api.ui_list_resource_v1</span>,
          <span key="view" className="chip chip--xs mono">release_deploy_proof_governance_v1</span>,
          <span key="contract" className="chip chip--xs mono">deploy-evidence-contract.json</span>,
        ]}
        actions={[
          <Button
            key="refresh"
            label="Refresh"
            iconName="refresh"
            kind="ghost"
            size="sm"
            onClick={() => void proofQuery.refetch()}
          />,
        ]}
      />

      {proofQuery.isLoading ? (
        <StateView kind="loading" title="Loading release proof governance" />
      ) : proofQuery.isError ? (
        <StateView
          kind="error"
          title="Release proof governance failed"
          hint={proofQuery.error instanceof Error ? proofQuery.error.message : 'ui_list_resource_v1 failed'}
        />
      ) : (
        <>
          <div className="status-grid" data-testid="release-proof-kpis">
            {kpis.map((kpi) => (
              <KPICard key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} />
            ))}
          </div>

          <DataTable
            viewKey="platform.release-proof"
            columns={columns}
            rows={rows}
            allowSelection={false}
            virtualize={false}
            emptyText="No release proof governance rows returned."
            searchKeys={[
              'surface_label',
              'surface_id',
              'stage',
              'deploy_environment',
              'evidence_status',
              'stage_workflow_file',
              'artifact_name',
              'json_entry_suffix',
              'proof_guard',
              'notes',
            ]}
          />
        </>
      )}
    </div>
  );
}
