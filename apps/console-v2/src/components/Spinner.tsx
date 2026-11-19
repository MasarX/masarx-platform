// Spinner.tsx — workflow-style spinner. Class `wf-spinner` carries the keyframe animation.
import type { CSSProperties } from 'react';

export interface SpinnerProps {
  size?: number;
  className?: string;
  title?: string;
}

export function Spinner({ size, className, title }: SpinnerProps) {
  const classes = ['wf-spinner', className].filter(Boolean).join(' ');
  const style: CSSProperties | undefined =
    size != null ? { width: `${size}px`, height: `${size}px` } : undefined;
  return (
    <span
      className={classes}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
    />
  );
}
