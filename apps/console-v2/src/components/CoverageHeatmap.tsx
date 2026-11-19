// CoverageHeatmap.tsx — 7-day × 24-hour density grid.
//
// Pure SVG. Cell color is interpolated from --paper-3 (intensity = 0) to
// --accent (intensity = 1) by mapping intensity onto opacity inside an
// `<rect>` with `fill="var(--accent)"`. Each cell is a focusable button-role
// rect with an accessible label of the form
// "<Day> <HH>:00 · NN% saturation". Day labels render on the left axis,
// hour labels on the top axis. Optional gradient legend renders below.
import { useMemo, type CSSProperties } from 'react';

export interface HeatmapCell {
  /** 0 = Monday … 6 = Sunday. */
  dayIndex: number;
  /** 0 … 23. */
  hourIndex: number;
  /** Density 0..1. Values outside this range are clamped. */
  intensity: number;
}

export interface CoverageHeatmapProps {
  cells: HeatmapCell[];
  onCellClick?: (day: number, hour: number) => void;
  legend?: boolean;
  className?: string;
  /** Optional fixed cell width override; defaults to a responsive layout. */
  cellSize?: number;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_AXIS_PADDING_TOP = 18;
const DAY_AXIS_PADDING_LEFT = 32;

function clamp(n: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, n));
}

export function CoverageHeatmap({
  cells,
  onCellClick,
  legend = true,
  className,
  cellSize = 18,
}: CoverageHeatmapProps) {
  const intensityMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) {
      m.set(`${c.dayIndex}:${c.hourIndex}`, clamp(c.intensity));
    }
    return m;
  }, [cells]);

  const gridWidth = DAY_AXIS_PADDING_LEFT + cellSize * 24 + 4;
  const gridHeight = HOUR_AXIS_PADDING_TOP + cellSize * 7 + 4;

  const wrapClasses = ['primitive-heat', className].filter(Boolean).join(' ');

  return (
    <div className={wrapClasses}>
      <svg
        className="primitive-heat__svg"
        viewBox={`0 0 ${gridWidth} ${gridHeight}`}
        preserveAspectRatio="xMidYMid meet"
        role="grid"
        aria-label="Coverage by day and hour"
        aria-rowcount={7}
        aria-colcount={24}
      >
        {/* Hour axis (every 4h to avoid noise) */}
        {Array.from({ length: 24 }, (_, h) =>
          h % 4 === 0 ? (
            <text
              key={`h${h}`}
              x={DAY_AXIS_PADDING_LEFT + h * cellSize + cellSize / 2}
              y={12}
              className="primitive-heat__axis"
              textAnchor="middle"
            >
              {String(h).padStart(2, '0')}
            </text>
          ) : null,
        )}

        {/* Day axis */}
        {DAY_LABELS.map((label, d) => (
          <text
            key={label}
            x={DAY_AXIS_PADDING_LEFT - 6}
            y={HOUR_AXIS_PADDING_TOP + d * cellSize + cellSize / 2 + 3}
            className="primitive-heat__axis"
            textAnchor="end"
          >
            {label}
          </text>
        ))}

        {/* Cells */}
        {DAY_LABELS.map((label, d) =>
          Array.from({ length: 24 }, (_, h) => {
            const intensity = intensityMap.get(`${d}:${h}`) ?? 0;
            const pct = Math.round(intensity * 100);
            const x = DAY_AXIS_PADDING_LEFT + h * cellSize;
            const y = HOUR_AXIS_PADDING_TOP + d * cellSize;
            const cellStyle: CSSProperties = {
              fill: 'var(--accent)',
              fillOpacity: 0.05 + intensity * 0.95,
            };
            return (
              <rect
                key={`${d}-${h}`}
                x={x + 1}
                y={y + 1}
                width={cellSize - 2}
                height={cellSize - 2}
                rx={2}
                ry={2}
                className="primitive-heat__cell"
                role="gridcell"
                tabIndex={d === 0 && h === 0 ? 0 : -1}
                aria-label={`${label} ${String(h).padStart(2, '0')}:00 · ${pct}% saturation`}
                onClick={() => onCellClick?.(d, h)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onCellClick?.(d, h);
                  }
                }}
                style={cellStyle}
              >
                <title>
                  {label} {String(h).padStart(2, '0')}:00 · {pct}% saturation
                </title>
              </rect>
            );
          }),
        )}
      </svg>

      {legend && (
        <div className="primitive-heat__legend" aria-hidden="true">
          <span>0%</span>
          <span className="primitive-heat__legend-bar" />
          <span>100%</span>
        </div>
      )}
    </div>
  );
}
