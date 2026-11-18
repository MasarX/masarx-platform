// LadderViz.tsx — visualises the override-ladder walk for a SettingsResolution
// or a canonical `settings_resolution_log` row.
//
// Each step shows rank, scope_type, scope_id, and the resolved value. The
// matching scope (resolved_from / winning_scope_type AND step.has_value) gets
// `is-match`; scopes without a value get `is-dim`.
//
// SCHEMA-DRIFT NOTE (W14-6 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §8):
// LadderViz is dual-shape:
//   • SettingsResolution — the in-flight resolver result
//     (`SettingsResolution['ladder_path']` + `resolved_from`). Used by
//     feature-flags, mobile-policy, dispatch, tracking-map, config, bindings
//     where the resolver output is fed live.
//   • ResolutionLogRow   — the persisted canonical row from
//     `public.settings_resolution_log` (`scope_path` JSONB +
//     `winning_scope_type`). Used by the Insights resolution-log drawer.
// A small normalize() pass collapses both into the same display contract.
import type { ResolutionLogRow, SettingsResolution } from '../types/domain';

type LadderInput = SettingsResolution | ResolutionLogRow | null | undefined;

interface NormalizedStep {
  rank: number;
  scope_type: string;
  scope_id: string | null;
  has_value: boolean;
  value: unknown;
}

interface NormalizedResolution {
  steps: NormalizedStep[];
  winning_scope_type: string;
}

export interface LadderVizProps {
  resolution: LadderInput;
  className?: string;
}

function isResolutionLogRow(input: NonNullable<LadderInput>): input is ResolutionLogRow {
  return (
    typeof (input as ResolutionLogRow).winning_scope_type === 'string' &&
    Array.isArray((input as ResolutionLogRow).scope_path)
  );
}

function isSettingsResolution(
  input: NonNullable<LadderInput>,
): input is SettingsResolution {
  return (
    typeof (input as SettingsResolution).resolved_from === 'string' &&
    Array.isArray((input as SettingsResolution).ladder_path)
  );
}

function normalize(input: LadderInput): NormalizedResolution | null {
  if (!input) return null;
  if (isResolutionLogRow(input)) {
    return {
      steps: input.scope_path.map((s) => ({
        rank: typeof s.rank === 'number' ? s.rank : 0,
        scope_type: String(s.scope_type ?? ''),
        scope_id: s.scope_id ?? null,
        has_value: !!s.has_value,
        value: s.value,
      })),
      winning_scope_type: String(input.winning_scope_type ?? ''),
    };
  }
  if (isSettingsResolution(input)) {
    return {
      steps: input.ladder_path.map((s) => ({
        rank: typeof s.rank === 'number' ? s.rank : 0,
        scope_type: String(s.scope_type ?? ''),
        scope_id: s.scope_id ?? null,
        has_value: !!s.has_value,
        value: s.value,
      })),
      winning_scope_type: String(input.resolved_from ?? ''),
    };
  }
  return null;
}

function formatLadderValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>);
    const primitiveEntries = entries.filter(([, value]) =>
      value == null || ['string', 'number', 'boolean'].includes(typeof value),
    );
    const summary = primitiveEntries
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${String(value ?? 'none')}`)
      .join(', ');
    return summary || `${entries.length} policy fields`;
  }
  return String(v);
}

export function LadderViz({ resolution, className }: LadderVizProps) {
  const classes = ['ladder', className].filter(Boolean).join(' ');
  const normalized = normalize(resolution);
  if (!normalized) {
    return <div className={classes} />;
  }
  return (
    <div className={classes}>
      {normalized.steps.map((step, i) => {
        const isMatch =
          normalized.winning_scope_type === step.scope_type && step.has_value;
        const stepClasses = [
          'ladder__step',
          isMatch ? 'is-match' : '',
          !isMatch && !step.has_value ? 'is-dim' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div key={`${step.rank}-${step.scope_type}-${i}`} className={stepClasses}>
            <span className="ladder__rank">{String(step.rank)}</span>
            <span className="ladder__level">{step.scope_type}</span>
            <span className="ladder__id">{step.scope_id || '—'}</span>
            <span className="ladder__value">
              {step.has_value ? formatLadderValue(step.value) : 'inherit'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
