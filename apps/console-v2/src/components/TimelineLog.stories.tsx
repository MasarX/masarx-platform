// TimelineLog.stories.tsx — sample event mix across all four buckets +
// tones. Future module agents (Customers · activity, Shipments · audit log,
// Compliance · investigation trail) consume this directly.
import { TimelineLog, type TimelineEvent } from './TimelineLog';

const NOW = new Date();
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const SAMPLE: TimelineEvent[] = [
  {
    id: 'e1',
    at: ago(1000 * 60 * 12),
    type: 'invoice.sent',
    actor: 'Mona',
    summary: 'Invoice INV-2102 sent to acme.sa',
    tone: 'good',
    detail: 'Total SAR 1,240.50 · Method: EmailV2 · Delivery: succeeded',
  },
  {
    id: 'e2',
    at: ago(1000 * 60 * 60 * 4),
    type: 'shipment.delivered',
    actor: 'Driver D-014',
    summary: 'SHP-92011 delivered, signature captured',
    tone: 'good',
  },
  {
    id: 'e3',
    at: ago(1000 * 60 * 60 * 22),
    type: 'shipment.exception',
    actor: 'System',
    summary: 'SHP-92012 flagged: address mismatch',
    tone: 'warn',
    detail: 'Customer city = "Riyadh" but geocode placed pin in Jeddah.',
  },
  {
    id: 'e4',
    at: ago(1000 * 60 * 60 * 70),
    type: 'driver.assigned',
    summary: 'Route R-220 assigned to D-014',
    tone: 'neutral',
  },
  {
    id: 'e5',
    at: ago(1000 * 60 * 60 * 24 * 14),
    type: 'compliance.review',
    actor: 'Auditor',
    summary: 'Quarterly compliance review opened',
    tone: 'danger',
  },
];

export function TimelineLogDemo() {
  return (
    <div style={{ padding: 16, maxWidth: 600 }}>
      <TimelineLog events={SAMPLE} initiallyExpanded={['e3']} />
    </div>
  );
}

export default TimelineLogDemo;
