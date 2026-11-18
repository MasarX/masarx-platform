// MaintenanceCalendar.tsx — week-grid scheduler (7 columns × 24 rows).
//
// Each window renders as a colored block spanning its time range. Cells
// highlight on hover; click fires `onCellClick(dayIndex, hourIndex)`. Header
// shows day labels with a "Today" indicator for the matching column. Full
// keyboard nav: arrow keys move focus between hour cells; Enter activates the
// focused cell.
//
// API is purely presentational — caller supplies `windows` and (optionally)
// the `weekStart`. Defaults to the Monday of the current week (UTC). All
// rendering reads from CSS tokens via `.primitive-cal*` classes.
import { useCallback, useMemo, useRef, type KeyboardEvent } from 'react';

export type MaintenanceTone = 'good' | 'warn' | 'danger' | 'neutral';

export interface MaintenanceWindow {
  id: string;
  title: string;
  /** ISO 8601 timestamp. */
  start: string;
  /** ISO 8601 timestamp. */
  end: string;
  tone?: MaintenanceTone;
}

export interface MaintenanceCalendarProps {
  windows: MaintenanceWindow[];
  /** ISO timestamp of the Monday for the displayed week. Defaults to current week (UTC). */
  weekStart?: string;
  onCellClick?: (dayIndex: number, hourIndex: number) => void;
  onWindowClick?: (id: string) => void;
  className?: string;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 22; // mirrors .primitive-cal__hour-cell height

function startOfWeekUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Convert Sunday(0) to 7 so Monday becomes index 1.
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dayDiff(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function formatHourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

function formatTimeRange(start: Date, end: Date): string {
  const f = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${f(start)}–${f(end)}`;
}

export function MaintenanceCalendar({
  windows,
  weekStart,
  onCellClick,
  onWindowClick,
  className,
}: MaintenanceCalendarProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const weekAnchor = useMemo(() => {
    if (weekStart) return startOfWeekUTC(new Date(weekStart));
    return startOfWeekUTC(new Date());
  }, [weekStart]);

  const todayIndex = useMemo(() => {
    const today = startOfWeekUTC(new Date());
    if (today.getTime() === weekAnchor.getTime()) {
      const now = new Date();
      const dow = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
      return dow - 1;
    }
    return -1;
  }, [weekAnchor]);

  const placedWindows = useMemo(() => {
    type Placed = MaintenanceWindow & {
      dayIndex: number;
      topPx: number;
      heightPx: number;
    };
    const out: Placed[] = [];
    for (const w of windows) {
      const start = new Date(w.start);
      const end = new Date(w.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const startDay = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
      );
      const dayIndex = dayDiff(weekAnchor, startDay);
      if (dayIndex < 0 || dayIndex > 6) continue;
      const minutesFromTop = start.getUTCHours() * 60 + start.getUTCMinutes();
      const durationMin = Math.max(20, (end.getTime() - start.getTime()) / 60_000);
      const topPx = (minutesFromTop / 60) * HOUR_HEIGHT;
      const heightPx = (durationMin / 60) * HOUR_HEIGHT;
      out.push({ ...w, dayIndex, topPx, heightPx });
    }
    return out;
  }, [windows, weekAnchor]);

  const groupedByDay = useMemo(() => {
    const groups: Record<number, typeof placedWindows> = {};
    for (let i = 0; i < 7; i++) groups[i] = [];
    for (const w of placedWindows) groups[w.dayIndex]?.push(w);
    return groups;
  }, [placedWindows]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, day: number, hour: number) => {
      const wrap = bodyRef.current;
      if (!wrap) return;
      let nextDay = day;
      let nextHour = hour;
      switch (event.key) {
        case 'ArrowLeft':
          nextDay = Math.max(0, day - 1);
          break;
        case 'ArrowRight':
          nextDay = Math.min(6, day + 1);
          break;
        case 'ArrowUp':
          nextHour = Math.max(0, hour - 1);
          break;
        case 'ArrowDown':
          nextHour = Math.min(23, hour + 1);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          onCellClick?.(day, hour);
          return;
        default:
          return;
      }
      event.preventDefault();
      const sel = `[data-cell-day="${nextDay}"][data-cell-hour="${nextHour}"]`;
      const target = wrap.querySelector<HTMLDivElement>(sel);
      target?.focus();
    },
    [onCellClick],
  );

  const dates = useMemo(() => {
    return DAY_LABELS.map((_, i) => {
      const d = new Date(weekAnchor.getTime());
      d.setUTCDate(d.getUTCDate() + i);
      return d;
    });
  }, [weekAnchor]);

  const wrapClasses = ['primitive-cal', className].filter(Boolean).join(' ');

  return (
    <div
      className={wrapClasses}
      role="grid"
      aria-label="Maintenance window schedule, 7 days by 24 hours"
      aria-rowcount={25}
      aria-colcount={8}
    >
      <div className="primitive-cal__head" role="row">
        <div className="primitive-cal__head-corner" role="presentation" />
        {DAY_LABELS.map((label, i) => {
          const date = dates[i]!;
          return (
            <div
              key={label}
              role="columnheader"
              className={
                'primitive-cal__head-cell' + (i === todayIndex ? ' is-today' : '')
              }
            >
              <span>{label}</span>
              <span className="primitive-cal__head-day">{date.getUTCDate()}</span>
            </div>
          );
        })}
      </div>
      <div className="primitive-cal__body" ref={bodyRef}>
        <div className="primitive-cal__hour-col" role="presentation">
          {HOURS.map((h) => (
            <div
              key={h}
              className={'primitive-cal__hour-label' + (h % 4 === 0 ? ' is-major' : '')}
            >
              {h % 4 === 0 ? formatHourLabel(h) : ''}
            </div>
          ))}
        </div>
        {DAY_LABELS.map((label, day) => (
          <div key={label} className="primitive-cal__day-col" role="presentation">
            {HOURS.map((hour) => (
              <div
                key={hour}
                role="gridcell"
                tabIndex={day === 0 && hour === 0 ? 0 : -1}
                data-cell-day={day}
                data-cell-hour={hour}
                aria-label={`${label} ${formatHourLabel(hour)}`}
                className={
                  'primitive-cal__hour-cell' + (hour % 4 === 3 ? ' is-major' : '')
                }
                onClick={() => onCellClick?.(day, hour)}
                onKeyDown={(e) => handleKeyDown(e, day, hour)}
              />
            ))}
          </div>
        ))}
        <div className="primitive-cal__windows">
          {DAY_LABELS.map((label, day) => (
            <div key={label} className="primitive-cal__win-col" role="presentation">
              {(groupedByDay[day] ?? []).map((w) => {
                const start = new Date(w.start);
                const end = new Date(w.end);
                return (
                  <button
                    type="button"
                    key={w.id}
                    className={`primitive-cal__window primitive-cal__window--${w.tone ?? 'neutral'}`}
                    style={{ top: `${w.topPx}px`, height: `${w.heightPx}px` }}
                    onClick={() => onWindowClick?.(w.id)}
                    aria-label={`${w.title}, ${formatTimeRange(start, end)}`}
                    title={`${w.title} · ${formatTimeRange(start, end)}`}
                  >
                    <span>{w.title}</span>
                    <span className="primitive-cal__window-time">
                      {formatTimeRange(start, end)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
