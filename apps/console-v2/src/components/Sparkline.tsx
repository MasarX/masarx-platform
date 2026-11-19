// Sparkline.tsx — inline SVG polyline rendered from a numeric series.
// Mirrors demo `sparkline()`: width/height defaults match (64×22) and the
// element gets the `kpi__sparkline` class so KPI tone colours cascade in.

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({ values, width = 64, height = 22, className }: SparklineProps) {
  if (!values || values.length === 0) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const denom = values.length - 1 || 1;
  const stepX = width / denom;

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const classes = ['kpi__sparkline', className].filter(Boolean).join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={classes}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
