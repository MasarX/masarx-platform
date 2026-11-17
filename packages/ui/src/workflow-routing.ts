import type { OperationNameStepMatch } from "./workflow-template-operation-index";

export type NextOperationRouteStatus =
  | "none"
  | "missing"
  | "ambiguous"
  | "self"
  | "target";

export type NextOperationRouteResolution = {
  status: NextOperationRouteStatus;
  match: OperationNameStepMatch | null;
  indexes: number[];
};

export function resolveNextOperationRoute(params: {
  currentStepId: string;
  nextOperationName: string;
  matches: OperationNameStepMatch[];
}): NextOperationRouteResolution {
  const nextOperationName = params.nextOperationName.trim();
  if (!nextOperationName) {
    return { status: "none", match: null, indexes: [] };
  }

  if (params.matches.length === 0) {
    return { status: "missing", match: null, indexes: [] };
  }

  if (params.matches.length > 1) {
    return {
      status: "ambiguous",
      match: null,
      indexes: params.matches.map((entry) => entry.index),
    };
  }

  const match = params.matches[0] ?? null;
  if (!match) {
    return { status: "missing", match: null, indexes: [] };
  }

  if (match.stepId === params.currentStepId) {
    return { status: "self", match, indexes: [match.index] };
  }

  return { status: "target", match, indexes: [match.index] };
}
