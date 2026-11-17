export type OperationNameStepMatch = {
  index: number;
  stepId: string;
};

export function buildOperationNameIndex(
  steps: Record<string, unknown>[],
  idKey: string
) {
  const index = new Map<string, OperationNameStepMatch[]>();

  steps.forEach((step, stepIndex) => {
    const stepIdRaw = step[idKey];
    const stepId = typeof stepIdRaw === "string" ? stepIdRaw.trim() : "";
    if (!stepId) return;
    const operationNameRaw = step.operation_name;
    const operationName =
      typeof operationNameRaw === "string" ? operationNameRaw.trim() : "";
    if (!operationName) return;
    const existing = index.get(operationName);
    const match = { index: stepIndex, stepId };
    if (existing) {
      existing.push(match);
      return;
    }
    index.set(operationName, [match]);
  });

  return index;
}

export function resolveOperationNameMatches(
  index: Map<string, OperationNameStepMatch[]>,
  operationName: string
) {
  const key = operationName.trim();
  if (!key) return [];
  const matches = index.get(key);
  return matches ? [...matches] : [];
}

