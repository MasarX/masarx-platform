// useScopedSearch — typed wrapper over TanStack Router's `useSearch({ strict: false })`.
// Modules can opt into a search-param shape without forcing every route to declare a schema.
// If a route hasn't defined a `validateSearch`, this returns `{}` cast to T — safe no-op fallback.
//
// Defensive against being mounted OUTSIDE a `<RouterProvider>` (test harnesses
// that don't include the router). In that case `useSearch({ strict: false })`
// reaches into a null match context and throws. We catch that and return `{}`
// so consumers degrade safely. The hook is still invoked unconditionally on
// every render, preserving the rules of hooks.
import { useSearch } from '@tanstack/react-router';

export function useScopedSearch<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  try {
    const search = useSearch({ strict: false }) as Partial<T> | undefined;
    return (search ?? {}) as T;
  } catch {
    return {} as T;
  }
}
