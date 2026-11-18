// Kbd.tsx — inline keyboard hint (e.g. "esc", "⌘K"). Class `kbd` styled in shell.css.
import type { ReactNode } from 'react';

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  const classes = ['kbd', className].filter(Boolean).join(' ');
  return <span className={classes}>{children}</span>;
}
