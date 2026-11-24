// drivers-performance-metrics.test.tsx — #409: the four driver metrics show
// "Not available" when the value is missing or not a finite number, and a real
// 0 still shows 0.
import { describe, it, expect, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { renderWithProviders } from '@/test/render';
import { PerformanceTab } from '../drivers';

type Props = ComponentProps<typeof PerformanceTab>;

const thresholds = {
  on_time_pct_good: 0.95,
  on_time_pct_warn: 0.9,
  rating_good: 4.5,
  rating_warn: 4,
  docs_expiring_days: 30,
  docs_expiring_warn_count: 1,
  score_oos_threshold: 60,
  compliance_score_bands: { good_min: 90, warn_min: 75, danger_max: 60 },
} as Props['kpiThresholds'];

const baseDriver = {
  id: 'drvp_metrics',
  user_id: 'usr_metrics',
  organization_id: 'org_metrics',
  name: 'Metrics Driver',
  deliveries_today: 12,
  deliveries_week: 35,
  on_time_pct: 0.96,
  customer_rating: 4.8,
} as Props['driver'];

function renderTab(overrides: Record<string, unknown>, locale?: 'en' | 'ar') {
  renderWithProviders(
    <PerformanceTab driver={{ ...baseDriver, ...overrides } as Props['driver']} kpiThresholds={thresholds} />,
    { locale },
  );
}

function card(label: string) {
  const el = screen.getByText(label, { selector: '.kpi__label' }).closest('.kpi');
  if (!el) throw new Error(`KPI card ${label} not found`);
  return {
    el,
    value: el.querySelector('.kpi__value')?.textContent,
    delta: el.querySelector('.kpi__delta')?.textContent,
  };
}

const METRICS = [
  { field: 'deliveries_today', label: 'Deliveries today', zero: '0', normal: 12, shown: '12' },
  { field: 'deliveries_week', label: 'Deliveries (7d)', zero: '0', normal: 35, shown: '35' },
  { field: 'on_time_pct', label: 'On-time %', zero: '0%', normal: 0.96, shown: '96%' },
  { field: 'customer_rating', label: 'Customer rating', zero: '0.0', normal: 4.8, shown: '4.8' },
] as const;

const MISSING: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['NaN', Number.NaN],
];

describe('PerformanceTab driver metrics (#409)', () => {
  afterEach(() => {
    localStorage.removeItem('console-v2.locale');
  });

  for (const m of METRICS) {
    describe(m.label, () => {
      for (const [name, value] of MISSING) {
        it(`shows Not available for ${name}`, () => {
          renderTab({ [m.field]: value });
          const c = card(m.label);
          expect(c.value).toBe('—');
          expect(c.delta).toBe('Not available');
          expect(c.el).toHaveClass('kpi--neutral');
          expect(c.el.textContent).not.toMatch(/NaN|undefined|null/);
        });
      }

      it('shows a real 0 as 0', () => {
        renderTab({ [m.field]: 0 });
        const c = card(m.label);
        expect(c.value).toBe(m.zero);
        expect(c.delta).not.toBe('Not available');
      });

      it('shows a normal value', () => {
        renderTab({ [m.field]: m.normal });
        const c = card(m.label);
        expect(c.value).toBe(m.shown);
        expect(c.delta).not.toBe('Not available');
      });
    });
  }

  it('renders the 7-day total as Not available when the weekly count is missing', () => {
    renderTab({ deliveries_week: null });
    expect(screen.queryByText(/^total /)).toBeNull();
    expect(screen.getAllByText('Not available')).toHaveLength(2);
  });

  it('keeps the weekly average and total for a real weekly count', () => {
    renderTab({});
    expect(card('Deliveries (7d)').delta).toBe('avg 5.0/day');
    expect(screen.getByText('total 35')).toBeInTheDocument();
  });

  it('uses the Arabic catalog for Not available', () => {
    renderTab(
      { deliveries_today: undefined, deliveries_week: null, on_time_pct: Number.NaN, customer_rating: null },
      'ar',
    );
    for (const m of METRICS) {
      expect(card(m.label).delta).toBe('غير متوفر');
    }
  });
});
