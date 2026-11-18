// MaintenanceCalendar.stories.tsx — demo render functions for the
// week-grid scheduler. Future module agents (Vehicles → Maintenance window
// editor; Hubs → blackout planner) can copy these patterns directly.
import { useState } from 'react';
import { MaintenanceCalendar, type MaintenanceWindow } from './MaintenanceCalendar';

const NEXT_MONDAY = (() => {
  const d = new Date();
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
})();

function isoOffset(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date(NEXT_MONDAY);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

const SAMPLE: MaintenanceWindow[] = [
  { id: 'm1', title: 'Sorter calibration', start: isoOffset(0, 8), end: isoOffset(0, 10), tone: 'warn' },
  { id: 'm2', title: 'Network upgrade', start: isoOffset(2, 22), end: isoOffset(3, 1), tone: 'danger' },
  { id: 'm3', title: 'Parts delivery', start: isoOffset(3, 14), end: isoOffset(3, 15, 30), tone: 'good' },
  { id: 'm4', title: 'Generator service', start: isoOffset(5, 9), end: isoOffset(5, 12), tone: 'neutral' },
];

export function MaintenanceCalendarDemo() {
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div style={{ padding: 16, maxWidth: 920 }}>
      <MaintenanceCalendar
        windows={SAMPLE}
        weekStart={NEXT_MONDAY}
        onWindowClick={(id) => setSelected(id)}
        onCellClick={(day, hour) => setPicked(`${day}/${hour}`)}
      />
      <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-3)' }}>
        Selected window: {selected ?? '—'} · Last cell: {picked ?? '—'}
      </p>
    </div>
  );
}

export default MaintenanceCalendarDemo;
