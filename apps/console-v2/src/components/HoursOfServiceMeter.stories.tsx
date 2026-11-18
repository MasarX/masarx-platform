// HoursOfServiceMeter.stories.tsx — sample driver-day timelines for HOS.
// Future module agents (Drivers · day card, Compliance · audit drawer)
// can lift these patterns directly.
//
// W59 Cycle E2 (P2-2) closure: stories pass `limits` + `warnPct` directly
// because the storybook is a presentation surface (no runtime
// `useResolveSettings('driver_safety_policy')` wiring). Production callers
// in modules/operate/fleet/drivers.tsx resolve both values through the
// canonical `driver_safety_policy` policy ladder.
import { HoursOfServiceMeter, type DutySegment } from './HoursOfServiceMeter';

const COMPLIANT: DutySegment[] = [
  { type: 'off_duty', durationMinutes: 60 },
  { type: 'driving', durationMinutes: 240 },
  { type: 'on_duty', durationMinutes: 30 },
  { type: 'driving', durationMinutes: 180 },
  { type: 'sleeper', durationMinutes: 90 },
];

const NEAR_LIMIT: DutySegment[] = [
  { type: 'driving', durationMinutes: 360 },
  { type: 'on_duty', durationMinutes: 90 },
  { type: 'driving', durationMinutes: 200 },
  { type: 'off_duty', durationMinutes: 30 },
];

const OVER_LIMIT: DutySegment[] = [
  { type: 'driving', durationMinutes: 420 },
  { type: 'on_duty', durationMinutes: 120 },
  { type: 'driving', durationMinutes: 300 },
];

// Storybook fixtures mirror the canonical `driver_safety_policy` seed in
// apps/console-v2/src/lib/seed-raw/policies.js (sv_100):
//   hos_limits.daily   = { driving: 660, on_duty: 840 }
//   hos_warn_pct       = 80
const STORY_LIMITS = { driving: 660, on_duty: 840 } as const;
const STORY_WARN_PCT = 80;

export function HoursOfServiceMeterDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 16, maxWidth: 540 }}>
      <section>
        <h4 style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>Compliant — Driver A</h4>
        <HoursOfServiceMeter segments={COMPLIANT} limits={STORY_LIMITS} warnPct={STORY_WARN_PCT} />
      </section>
      <section>
        <h4 style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>Near limit — Driver B</h4>
        <HoursOfServiceMeter segments={NEAR_LIMIT} limits={STORY_LIMITS} warnPct={STORY_WARN_PCT} />
      </section>
      <section>
        <h4 style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>Over limit — Driver C</h4>
        <HoursOfServiceMeter segments={OVER_LIMIT} limits={STORY_LIMITS} warnPct={STORY_WARN_PCT} />
      </section>
    </div>
  );
}

export default HoursOfServiceMeterDemo;
