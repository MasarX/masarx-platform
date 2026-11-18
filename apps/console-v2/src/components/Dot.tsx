// Dot.tsx — semantic status indicator (filled circle). Mirrors demo `dot()`.
export type DotKind = 'good' | 'warn' | 'danger' | 'info' | 'neutral';

export interface DotProps {
  kind?: DotKind;
  className?: string;
  title?: string;
}

export function Dot({ kind = 'neutral', className, title }: DotProps) {
  const classes = ['dot', `dot--${kind}`, className].filter(Boolean).join(' ');
  return <span className={classes} aria-hidden={title ? undefined : 'true'} title={title} />;
}
