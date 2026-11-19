// commands.tsx — ui_command_registry catalog with section/domain filter chips,
// capability gating, and owner-module routing for real command execution.

import { useMemo, useState, type ReactNode } from 'react';
import { Chip } from '@/components/Chip';
import { Dot } from '@/components/Dot';
import { Icon } from '@/components/Icon';
import { CapabilityLock } from '@/components/CapabilityLock';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { useCapability } from '@/lib/identity';
import * as api from '@/lib/api';
import { CAP, formatCapabilityRequirement } from '@/lib/capabilities';
import { normalizeConsoleHref } from '@/lib/legacy-hash-navigation';

interface CommandDef {
  key: string;
  label: string;
  section: string;
  execution?: string | Record<string, unknown> | null;
  target?: string;
  capability?: string;
  route_targets?: {
    console?: { path?: string | null } | null;
  } | null;
}

function commandExecutionKind(cmd: CommandDef): string {
  const execution = cmd.execution;
  if (typeof execution === 'string' && execution.trim()) return execution.trim();
  if (execution && typeof execution === 'object') {
    return String(execution.type ?? execution.kind ?? 'automated');
  }
  return 'module';
}

function commandTarget(cmd: CommandDef): string {
  if (typeof cmd.target === 'string' && cmd.target.trim()) return cmd.target.trim();
  const execution = cmd.execution;
  if (execution && typeof execution === 'object') {
    const target = execution.rpc ?? execution.target ?? execution.function ?? execution.handler;
    return typeof target === 'string' ? target.trim() : '';
  }
  return '';
}

function commandOwnerHref(cmd: CommandDef): string | undefined {
  const consoleTarget = cmd.route_targets?.console;
  const path = typeof consoleTarget?.path === 'string' ? consoleTarget.path.trim() : '';
  return path ? normalizeConsoleHref(path) : undefined;
}

export function CommandsModule() {
  const canRead = useCapability(CAP.AUDIT_LOG_READ);

  const cmds = useMemo<CommandDef[]>(
    () => (api.getCommandRegistry() as CommandDef[]) || [],
    []
  );

  const sections = useMemo<string[]>(() => {
    const set = new Set<string>();
    cmds.forEach((c) => set.add(c.section || 'Other'));
    return Array.from(set);
  }, [cmds]);

  const [search, setSearch] = useState<string>('');
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return cmds.filter((c) => {
      if (activeSection && c.section !== activeSection) return false;
      if (!q) return true;
      return (
        c.label.toLowerCase().includes(q) ||
        c.key.toLowerCase().includes(q) ||
        (c.target?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [cmds, search, activeSection]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="commands"
          eyebrow="Platform"
          titleAccent="Commands"
          titlePlain="— catalog"
          pills={[<span key="reg" className="chip chip--xs">Governed command catalog</span>] as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.AUDIT_LOG_READ}
          hint="You do not have permission to view the commands catalog."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="commands"
        eyebrow="Platform"
        titleAccent="Commands"
        titlePlain="— catalog"
        pills={[<span key="reg" className="chip chip--xs">Governed command catalog</span>] as ReactNode[]}
      />

      <div className="dt-toolbar">
        <div className="dt-tb-search">
          <span>
            <Icon name="search" size={12} />
          </span>
          <input
            type="text"
            placeholder="Search commands…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="commands-search"
          />
        </div>
        <div className="dt-tb-spacer" />
        <button
          type="button"
          className={`dt-tb-view-tab ${activeSection === null ? 'is-active' : ''}`}
          onClick={() => setActiveSection(null)}
        >
          All
        </button>
        {sections.map((s) => (
          <button
            key={s}
            type="button"
            className={`dt-tb-view-tab ${activeSection === s ? 'is-active' : ''}`}
            onClick={() => setActiveSection(s)}
            data-testid={`commands-section-${s}`}
          >
            {s}
          </button>
        ))}
        <span className="dt-tb-count mono">
          {filtered.length}/{cmds.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <StateView kind="empty" hint="No commands match your filter." />
      ) : (
        <div
          style={{
            padding: '16px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '8px',
            overflow: 'auto',
            flex: 1,
          }}
        >
          {filtered.map((c) => (
            <CommandCard key={c.key} cmd={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommandCard({ cmd }: { cmd: CommandDef }) {
  const allowed = useCapability(cmd.capability);
  const ownerHref = commandOwnerHref(cmd);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }} data-testid={`command-card-${cmd.key}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontWeight: 600 }}>{cmd.label}</span>
        <div style={{ flex: 1 }} />
        <Chip label={commandExecutionKind(cmd) === 'module' ? 'Module action' : 'Automated action'} kind="info" size="xs" />
      </div>
      <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
        {cmd.key}
      </div>
      {commandTarget(cmd) ? (
        <div
          className="mono"
          style={{ fontSize: '10.5px', color: 'var(--ink-2)', display: 'flex', gap: '6px', flexWrap: 'wrap' }}
        >
          <span>{commandExecutionKind(cmd)}</span>
          <span>{`target: ${commandTarget(cmd)}`}</span>
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
        {cmd.capability ? (
          allowed ? (
            <Chip label="granted" kind="good" size="xs" />
          ) : (
            <CapabilityLock capability={cmd.capability} />
          )
        ) : (
          <Chip label="no capability" size="xs" />
        )}
        <Chip label="owner workflow" kind={ownerHref ? 'info' : 'warn'} size="xs" />
        <div style={{ flex: 1 }} />
        {ownerHref ? (
          <a
            className="btn btn--ghost btn--sm"
            href={ownerHref}
            data-testid={`command-owner-${cmd.key}`}
            style={{ textDecoration: 'none' }}
          >
            <Icon name="external" size={12} />
            <span>Open owner</span>
          </a>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled
            title="This command needs a selected record in its owning module."
          >
            <Icon name="external" size={12} />
            <span>Open owner</span>
          </button>
        )}
      </div>
    </div>
  );
}
