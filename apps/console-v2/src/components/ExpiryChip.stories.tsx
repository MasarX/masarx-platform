// ExpiryChip.stories.tsx — sample states across the threshold ladder.
// Future module agents: Drivers (license expiry), Vehicles (registration),
// Customers (insurance), Integrations (API key) all consume this directly.
import { ExpiryChip } from './ExpiryChip';

const NOW = new Date();
function inDays(n: number): string {
  return new Date(NOW.getTime() + n * 86_400_000).toISOString();
}

export function ExpiryChipDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
      <ExpiryChip expiresAt={null} prefix="No-expiry contract" />
      <ExpiryChip expiresAt={inDays(120)} prefix="License A1234" />
      <ExpiryChip expiresAt={inDays(22)} prefix="License A5678" />
      <ExpiryChip expiresAt={inDays(4)} prefix="Insurance INS-9912" />
      <ExpiryChip expiresAt={inDays(0)} prefix="Permit P-001" />
      <ExpiryChip expiresAt={inDays(-12)} prefix="Permit P-XX9" />
    </div>
  );
}

export default ExpiryChipDemo;
