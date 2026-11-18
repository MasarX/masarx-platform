// vitest setup — testing-library matchers + cleanup + MSW lifecycle, plus a
// few jsdom polyfills required by the modern UI dependency tree (Radix Dialog,
// cmdk-backed Palette, etc.) that ship with browser APIs jsdom does not.
//
// MSW intercepts every outgoing HTTP request from the test process. We use
// `onUnhandledRequest: 'error'` so any future code path that starts hitting a
// real network in tests fails loudly instead of silently making external calls.
// The console-v2 demo's in-memory data-source doesn't currently make network
// requests, so this is a forward-compatibility net for the Supabase swap.
// W36 — manual extend instead of `import '@testing-library/jest-dom/vitest'`
// because the package's vitest subpath registers matchers via a side-effect
// `expect.extend(...)` against its own `vitest` module instance. In Node 24 +
// Vitest 2.1.9 that side-effect does not apply to the test runtime's `expect`
// (module-instance isolation), so 399/1009 tests previously failed with
// `Invalid Chai property: toBeInTheDocument`. Importing the matchers module
// and extending against the test's own `expect` binds correctly at runtime.
//
// Matcher types are provided through tsconfig.app.json. Keep runtime binding
// explicit so the workspace resolves Vitest from the test runner instance.
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
expect.extend(jestDomMatchers);

import { cleanup } from '@testing-library/react';
import { server } from './msw/server';

vi.stubEnv('VITE_USE_SEED', 'true');
vi.stubEnv('VITE_SUPABASE_URL', '');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

// ---------- jsdom polyfills ----------
// cmdk's CommandList uses ResizeObserver to auto-size; jsdom does not provide
// it. A no-op shim is sufficient for tests — we don't measure the surface.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = ResizeObserverPolyfill;
}

// Radix Dialog uses scrollIntoView when re-focusing dismissed elements.
// jsdom does not implement it; provide a no-op.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// Some Radix internals consult `hasPointerCapture`; jsdom lacks it on
// HTMLElement. Provide a no-op so click sequences don't throw.
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.hasPointerCapture) {
  (HTMLElement.prototype as any).hasPointerCapture = function hasPointerCapture() {
    return false;
  };
  (HTMLElement.prototype as any).releasePointerCapture = function releasePointerCapture() {};
}

// ---------- MSW lifecycle ----------
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
