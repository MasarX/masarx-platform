// ZoneMap.stories.tsx — sample multi-district canvas with normalized 0..1
// coordinates (so the demo is self-contained and not Mapbox-dependent).
// Future module agents (Routes · service-zone editor, Hubs · territory map,
// Carriers · coverage view) consume this directly.
import { useState } from 'react';
import { ZoneMap, type ZonePolygon } from './ZoneMap';

const ZONES: ZonePolygon[] = [
  {
    id: 'r-north',
    name: 'Riyadh-N',
    paths: [
      [0.50, 0.95],
      [0.85, 0.95],
      [0.92, 0.78],
      [0.78, 0.65],
      [0.55, 0.70],
    ],
    tone: 'good',
  },
  {
    id: 'r-east',
    name: 'Riyadh-E',
    paths: [
      [0.55, 0.65],
      [0.78, 0.62],
      [0.90, 0.40],
      [0.65, 0.35],
      [0.50, 0.45],
    ],
    tone: 'warn',
  },
  {
    id: 'r-south',
    name: 'Riyadh-S',
    paths: [
      [0.40, 0.45],
      [0.65, 0.35],
      [0.62, 0.10],
      [0.30, 0.08],
      [0.25, 0.30],
    ],
    tone: 'danger',
  },
  {
    id: 'r-west',
    name: 'Riyadh-W',
    paths: [
      [0.10, 0.85],
      [0.50, 0.95],
      [0.55, 0.65],
      [0.40, 0.45],
      [0.18, 0.55],
      [0.05, 0.70],
    ],
    tone: 'neutral',
  },
];

export function ZoneMapDemo() {
  const [selected, setSelected] = useState<string | undefined>('r-east');
  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <ZoneMap zones={ZONES} selectedId={selected} onSelect={setSelected} />
      <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-3)' }}>
        Selected: <strong>{selected ?? '—'}</strong>
      </p>
    </div>
  );
}

export default ZoneMapDemo;
