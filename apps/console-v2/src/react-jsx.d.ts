import type { JSX as ReactJSX } from 'react';

declare global {
  // shortcut: React 18 JSX compatibility shim. Remove when callers use React.JSX.Element.
  namespace JSX {
    type Element = ReactJSX.Element;
  }
}
