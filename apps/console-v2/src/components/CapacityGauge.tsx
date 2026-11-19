// CapacityGauge.tsx — circular saturation gauge.
//
// SVG donut: outer ring shows used/total, center shows percent. Tone changes
// by saturation:
//   0 .. 0.70  → good
//   0.70 .. 0.90 → warn
//   0.90+        → danger
// Exposes role="progressbar" + aria-valuenow/min/max/text so screen readers
// announce the saturation as a numeric percentage.
import { useMemo } from 'react';

export type GaugeSize = 'sm' | 'md' | 'lg';

export interface CapacityGaugeProps {
  used: number;
  total: number;
  size?: GaugeSize;
  label?: string;
  className?: string;
}

const SIZE_PX: Record<GaugeSize, number> = { sm: 56, md: 96, lg: 144 };
const STROKE_BY_SIZE: Record<GaugeSize, number> = { sm: 6, md: 9, lg: 12 };
const FONT_BY_SIZE: Record<GaugeSize, number> = { sm: 13, md: 22, lg: 30 };
const SUB_FONT_BY_SIZE: Record<GaugeSize, number> = { sm: 7, md: 9, lg: 11 };

function toneFor(pct: number): 'good' | 'warn' | 'danger' {
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warn';
  return 'good';
}

export function CapacityGauge({
  used,
  total,
  size = 'md',
  label,
  className,
}: CapacityGaugeProps) {
  const dim = SIZE_PX[size];
  const stroke = STROKE_BY_SIZE[size];
  const fontPx = FONT_BY_SIZE[size];
  const subFontPx = SUB_FONT_BY_SIZE[size];
  const radius = dim / 2 - stroke;
  const circumference = 2 * Math.PI * radius;

  const safeTotal = total > 0 ? total : 1;
  const ratio = useMemo(() => Math.max(0, Math.min(1, used / safeTotal)), [used, safeTotal]);
  const pct = Math.round(ratio * 100);
  const tone = toneFor(pct);
  const dashOffset = circumference - ratio * circumference;

  const wrapClasses = ['primitive-gauge', className].filter(Boolean).join(' ');
  const ariaText = `${used} of ${total} used (${pct}%)`;

  return (
    <div className={wrapClasses}>
      <svg
        className="primitive-gauge__svg"
        width={dim}
        height={dim}
        viewBox={`0 0 ${dim} ${dim}`}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={ariaText}
        aria-label={label ?? 'Capacity'}
      >
        <circle
          className="primitive-gauge__track"
          cx={dim / 2}
          cy={dim / 2}
          r={radius}
          strokeWidth={stroke}
        />
        <circle
          className={`primitive-gauge__fill primitive-gauge__fill--${tone}`}
          cx={dim / 2}
          cy={dim / 2}
          r={radius}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${dim / 2} ${dim / 2})`}
        />
        <text
          className={`primitive-gauge__pct primitive-gauge__pct--${tone}`}
          x={dim / 2}
          y={dim / 2 + fontPx / 3}
          textAnchor="middle"
          fontSize={fontPx}
        >
          {pct}%
        </text>
        {size !== 'sm' && (
          <text
            className="primitive-gauge__sub"
            x={dim / 2}
            y={dim / 2 + fontPx / 3 + subFontPx + 4}
            textAnchor="middle"
            fontSize={subFontPx}
          >
            {used} / {total}
          </text>
        )}
      </svg>
      {label ? <div className="primitive-gauge__label">{label}</div> : null}
    </div>
  );
}
