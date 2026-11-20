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
  | "summary-scope"
  | "summary-scope-reference"
  | "summary-settings-resolution"
  | "command-center"
  | "metrics";

export function buildTestId(prefix: string, state: TestIdState) {
  return `${prefix}-${state}`;
}
