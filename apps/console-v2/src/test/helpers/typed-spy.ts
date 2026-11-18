// typed-spy.ts — typed wrapper around `vi.spyOn` for precisely-typed test mocks.
//
// W56-E — Wave 56-B-2 retired the api.seed namespace and the api.ts wrappers
// are now precisely typed. The previous workaround (`ReturnType<typeof
// vi.spyOn<any, any>>`) widened the spy variable type so test files would still
// compile under stricter wrappers. That escape hatch is no longer necessary
// once we route all spy declarations through this helper, which preserves the
// canonical `MockInstance<T[K]>` shape returned by `vi.spyOn`.
//
// Usage:
//   import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';
//   import * as apiMod from '@/lib/api';
//
//   let suspendSpy: TypedSpy<typeof apiMod, 'sender_suspend_v1'>;
//   beforeEach(() => {
//     suspendSpy = typedSpy(apiMod, 'sender_suspend_v1');
//   });
//
// Both `typedSpy(...)` and `TypedSpy<...>` are first-class — the helper hands
// back the same `MockInstance` shape that `vi.spyOn` would have produced, so
// chained methods (`.mockResolvedValue`, `.mockRestore`, `.mock.calls`) keep
// their canonical signatures.

import { vi, type MockInstance } from 'vitest';

/**
 * Type alias for the spy variable: `TypedSpy<typeof apiMod, 'method_name'>`.
 *
 * Resolves to `MockInstance<(...args) => R>` derived from the method's actual
 * signature on the target object — no `any` widening, no signature drift.
 */
export type TypedSpy<T, K extends keyof T> = T[K] extends (
  ...args: infer A
) => infer R
  ? MockInstance<(...args: A) => R>
  : never;

/**
 * Creates a precisely-typed `vi.spyOn` for `obj[method]`.
 *
 * Equivalent to `vi.spyOn(obj, method)` at runtime, but the return type is
 * narrowed to `TypedSpy<T, K>` so call-site `let` declarations no longer need
 * the `<any, any>` widening that W54-F introduced as a temporary workaround.
 */
export function typedSpy<T extends object, K extends keyof T>(
  obj: T,
  method: K,
): TypedSpy<T, K> {
  // The cast is local to this helper and never leaks to callers; vitest's own
  // overload set already produces a `MockInstance<T[K]>` for callable methods,
  // we just expose it under a single named alias.
  return vi.spyOn(
    obj as Parameters<typeof vi.spyOn>[0],
    method as Parameters<typeof vi.spyOn>[1],
  ) as unknown as TypedSpy<T, K>;
}
