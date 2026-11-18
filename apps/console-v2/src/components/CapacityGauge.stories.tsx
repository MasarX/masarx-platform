// CapacityGauge.stories.tsx — a small grid of all sizes + tones.
// Future module agents (Hubs · saturation tile, Vehicles · load-out summary,
// Drivers · roster utilization) consume the same `<CapacityGauge>` directly.
import { CapacityGauge } from './CapacityGauge';

export function CapacityGaugeDemo() {
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: 16 }}>
      <CapacityGauge size="sm" used={32} total={100} label="branch" />
      <CapacityGauge size="md" used={84} total={120} label="hub-east" />
      <CapacityGauge size="md" used={144} total={150} label="dock-3 (over)" />
      <CapacityGauge size="lg" used={310} total={500} label="today's load" />
    </div>
  );
}

export default CapacityGaugeDemo;
