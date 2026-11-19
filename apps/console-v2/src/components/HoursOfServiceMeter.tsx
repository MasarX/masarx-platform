// HoursOfServiceMeter.tsx — segmented duty-status bar.
//
// Shows a horizontal bar segmented by `type` with proportional widths derived
// from `durationMinutes`. Each segment carries a `<title>` SVG element so
// screen readers announce duration on focus/hover. Footer shows driving and
// on-duty totals against `limits` (provided by the caller — typically resolved
// from a canonical `driver_safety_policy` setting); tone flips when the limit
// is exceeded so the meter doubles as a compliance signal.
//
// AGENTS.md §2 (ZERO HARDCODING): `limits` is required prop — no
// FMCSA-or-other in-component default. The status label resolves from the
// canonical `duty_status` lookup_values rows; missing rows render a danger
// label so the gap is visible instead of silently presenting an FE default.
import { useMemo } from 'react';
import { lookupRow, getLookups } from '@/lib/api';

export type DutyStatus = 'driving' | 'on_duty' | 'off_duty' | 'sleeper';

export interface DutySegment {
  type: DutyStatus;
  durationMinutes: number;
}

export interface HoursOfServiceMeterProps {
  segments: DutySegment[];
  /**
   * Limits in minutes. REQUIRED — no in-component default.
   * Caller resolves from canonical `driver_safety_policy.hos_limits`
   * (or jurisdiction-equivalent settings category).
   */
  limits: { driving: number; on_duty: number };
  /**
   * Warn-threshold percentage. REQUIRED — no in-component default.
   * Caller resolves from canonical `driver_safety_policy.hos_warn_pct`.
   * W59 Cycle E2 (P2-2) closure: removes the in-component `>= 80` literal
   * so the warn-tone trip is row-driven through the override ladder.
   */
  warnPct: number;
  showLabels?: boolean;
  className?: string;
}

function statusLabel(s: DutyStatus): string {
  // Canonical source: `duty_status` lookup_values.label. Missing row →
  // danger-prefixed label so the gap is visible rather than silently
  // defaulting to the enum value.
  const row = lookupRow('duty_status', s);
  return row?.label ?? `duty_status/${s} (missing)`;
}

function statusSwatchToken(s: DutyStatus): string {
  // W56-B (F2) — Canonical source: `duty_status.metadata.swatch_token` lookup
  // row. Missing row falls back to a danger-tone CSS variable so the gap is
  // visible rather than silently defaulting to a tenant-themed swatch.
  const row = lookupRow('duty_status', s) as
    | { metadata?: { swatch_token?: string } }
    | null;
  return row?.metadata?.swatch_token ?? 'var(--danger)';
}

function formatHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function HoursOfServiceMeter({
  segments,
  limits,
  warnPct,
  showLabels = true,
  className,
}: HoursOfServiceMeterProps) {
  const totals = useMemo(() => {
    let total = 0;
    let driving = 0;
    let on_duty = 0;
    for (const s of segments) {
      total += s.durationMinutes;
      const row = lookupRow('duty_status', s.type) as
        | { metadata?: { counts_for_drive_time?: boolean; counts_for_on_duty?: boolean } }
        | null;
      if (row?.metadata?.counts_for_drive_time === true) {
        driving += s.durationMinutes;
      }
      if (row?.metadata?.counts_for_on_duty === true) {
        on_duty += s.durationMinutes;
      }
    }
    return { total, driving, on_duty };
  }, [segments]);

  const drivingPct = Math.min(100, (totals.driving / limits.driving) * 100);
  const onDutyPct = Math.min(100, (totals.on_duty / limits.on_duty) * 100);
  const drivingState =
    totals.driving > limits.driving ? 'is-over' : drivingPct >= warnPct ? 'is-warn' : '';
  const onDutyState =
    totals.on_duty > limits.on_duty ? 'is-over' : onDutyPct >= warnPct ? 'is-warn' : '';

  const wrapClasses = ['primitive-hos', className].filter(Boolean).join(' ');
  const ariaLabel = `Duty totals — driving ${formatHM(totals.driving)} of ${formatHM(limits.driving)}, on-duty ${formatHM(totals.on_duty)} of ${formatHM(limits.on_duty)}`;

  return (
    <div className={wrapClasses} role="group" aria-label={ariaLabel}>
      <div className="primitive-hos__bar">
        <svg
          width="0"
          height="0"
          style={{ position: 'absolute', visibility: 'hidden' }}
          aria-hidden="true"
        />
        {segments.map((seg, i) => {
          const widthPct = totals.total > 0 ? (seg.durationMinutes / totals.total) * 100 : 0;
          return (
            <div
              key={i}
              className={`primitive-hos__seg primitive-hos__seg--${seg.type}`}
              style={{ width: `${widthPct}%` }}
              role="img"
              aria-label={`${statusLabel(seg.type)}, ${formatHM(seg.durationMinutes)}`}
              title={`${statusLabel(seg.type)} — ${formatHM(seg.durationMinutes)}`}
            />
          );
        })}
      </div>

      {showLabels && (
        <div className="primitive-hos__legend">
          {/*
            W79 (Cycle F-R-19) closure — legend rows derive from canonical
            `duty_status` lookup category, sorted by `rank`. Adding/renaming
            a duty status (e.g., a future `on_break` row) is a single seed
            update; no code change here. Strict no-fallback: missing rows
            simply yield no legend entries (the gap is observable via the
            `statusLabel`/`statusSwatchToken` helpers).
            AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
          */}
          {((getLookups('duty_status') as Array<{ value: string; rank?: number }> | undefined) ?? [])
            .slice()
            .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
            .map((row) => {
              const s = row.value as DutyStatus;
              return (
                <span key={s} className="primitive-hos__legend-item">
                  <span
                    className="primitive-hos__legend-swatch"
                    style={{ background: statusSwatchToken(s) }}
                  />
                  {statusLabel(s)}
                </span>
              );
            })}
        </div>
      )}

      <div className="primitive-hos__limits">
        <div className={`primitive-hos__limit ${drivingState}`}>
          <div className="primitive-hos__limit-label">
            <span>Driving</span>
            <strong>
              {formatHM(totals.driving)} <span style={{ opacity: 0.7 }}>/ {formatHM(limits.driving)}</span>
            </strong>
          </div>
          <div className="primitive-hos__limit-track">
            <div className="primitive-hos__limit-fill" style={{ width: `${drivingPct}%` }} />
          </div>
        </div>
        <div className={`primitive-hos__limit ${onDutyState}`}>
          <div className="primitive-hos__limit-label">
            <span>On duty</span>
            <strong>
              {formatHM(totals.on_duty)} <span style={{ opacity: 0.7 }}>/ {formatHM(limits.on_duty)}</span>
            </strong>
          </div>
          <div className="primitive-hos__limit-track">
            <div className="primitive-hos__limit-fill" style={{ width: `${onDutyPct}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
