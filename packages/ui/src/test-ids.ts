export type TestIdState =
  | "ready"
  | "error"
  | "loading"
  | "auth-required"
  | "context-unavailable"
  | "blocked"
  | "not-found"
  | "success"
  | "form"
  | "preview"
  | "request"
  | "command-center"
  | "metrics";

export function buildTestId(prefix: string, state: TestIdState) {
  return `${prefix}-${state}`;
}
