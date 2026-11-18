export function workflowRunTraceSearch(
  run: { correlation_id?: string | null },
): { cor: string } | undefined {
  return run.correlation_id ? { cor: run.correlation_id } : undefined;
}
