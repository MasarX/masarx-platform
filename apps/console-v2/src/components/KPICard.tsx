// KPICard.tsx — single KPI tile (label, value, optional delta + sparkline).
// Mirrors demo `kpiCard({ label, value, tone, delta, spark })`.
import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

export type KPITone = 'good' | 'warn' | 'danger' | 'info' | 'neutral';

export interface KPICardProps {
  label: string;
  value: string | number;
  tone?: KPITone;
  delta?: ReactNode;
  spark?: number[];
  className?: string;
}

export function KPICard({ label, value, tone = 'neutral', delta, spark, className }: KPICardProps) {
  const classes = ['kpi', `kpi--${tone}`, className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value-row">
        <span className="kpi__value">{value}</span>
      </div>
      {delta != null && delta !== '' ? <div className="kpi__delta mono">{delta}</div> : null}
      {spark && spark.length > 0 ? <Sparkline values={spark} /> : null}
    </div>
  );
}
