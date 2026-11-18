// CoverageHeatmap.stories.tsx — sample density curves (rush-hour bias).
// Future module agents (Tracking · coverage tab, Vehicles · utilization view,
// Drivers · shift density) will lift this directly.
import { useMemo } from 'react';
import { CoverageHeatmap, type HeatmapCell } from './CoverageHeatmap';

function rushHourSeed(): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      // Gaussian-ish around morning + evening peaks, with weekend dampening.
      const morning = Math.exp(-Math.pow((h - 9) / 2.5, 2));
      const evening = Math.exp(-Math.pow((h - 17) / 2.8, 2));
      const base = Math.max(morning, evening * 0.85);
      const weekendAttenuation = d >= 5 ? 0.55 : 1;
      const noise = ((d * 31 + h * 7) % 13) / 100;
      const intensity = Math.max(0, Math.min(1, base * weekendAttenuation + noise - 0.05));
      cells.push({ dayIndex: d, hourIndex: h, intensity });
    }
  }
  return cells;
}

export function CoverageHeatmapDemo() {
  const cells = useMemo(() => rushHourSeed(), []);
  return (
    <div style={{ padding: 16, maxWidth: 640 }}>
      <CoverageHeatmap cells={cells} onCellClick={() => {}} />
    </div>
  );
}

export default CoverageHeatmapDemo;
