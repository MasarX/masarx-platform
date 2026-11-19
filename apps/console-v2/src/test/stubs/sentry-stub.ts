// sentry-stub.ts — local stub for `@sentry/react` so the dynamic import in
// `src/lib/telemetry.ts` resolves under vitest without requiring the real
// SDK. The module surface is intentionally tiny — only the `init` shape we
// reference is provided.
export function init(_options: Record<string, unknown>): void {
  // no-op
}

export default { init };
