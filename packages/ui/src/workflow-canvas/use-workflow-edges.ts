import { useMemo } from "react";
import {
  buildOperationNameIndex,
  resolveOperationNameMatches,
} from "../workflow-template-operation-index";
import { resolveNextOperationRoute } from "../workflow-routing";
import type { WorkflowEdge, WorkflowEdgeData } from "./workflow-canvas-types";

/* ---------------------------------------------------------------------------
 * Helpers.
 * -------------------------------------------------------------------------*/

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/* ---------------------------------------------------------------------------
 * Convert step routing → React Flow Edge[].
 *
 * Uses the existing `buildOperationNameIndex` + `resolveNextOperationRoute`
 * functions unchanged, so edge derivation is identical to the legacy canvas.
 * -------------------------------------------------------------------------*/

export type UseWorkflowEdgesOptions = {
  steps: Record<string, unknown>[];
  idKey: string;
  hasTriggers?: boolean;
};

export function useWorkflowEdges({
  steps,
  idKey,
  hasTriggers,
}: UseWorkflowEdgesOptions): WorkflowEdge[] {
  return useMemo(() => {
    const edges: WorkflowEdge[] = [];
    const operationNameIndex = buildOperationNameIndex(steps, idKey);

    /* Trigger → first step edge ----------------------------------------*/
    if (hasTriggers && steps.length > 0) {
      const firstStepId = normalizeText(steps[0]![idKey]);
      if (firstStepId) {
        edges.push({
          id: `edge-trigger-${firstStepId}`,
          source: "__workflow_triggers__",
          target: firstStepId,
          type: "workflowEdge",
          animated: true,
          data: {
            sourceStepId: "__workflow_triggers__",
            targetStepId: firstStepId,
            conditionJsonlogic: null,
            routeStatus: "target",
          },
        });
      }
    }

    /* Step → next-operation edges --------------------------------------*/
    steps.forEach((step) => {
      const sourceId = normalizeText(step[idKey]);
      if (!sourceId) return;

      const nextOperationName = normalizeText(step.next_operation_name);
      if (!nextOperationName) return;

      const matches = resolveOperationNameMatches(operationNameIndex, nextOperationName);
      const route = resolveNextOperationRoute({
        currentStepId: sourceId,
        nextOperationName,
        matches,
      });

      const conditionJsonlogic = normalizeRecord(step.condition_jsonlogic);

      if (route.status === "target" && route.match) {
        const targetId = route.match.stepId;
        const edgeData: WorkflowEdgeData = {
          sourceStepId: sourceId,
          targetStepId: targetId,
          conditionJsonlogic,
          routeStatus: "target",
        };
        edges.push({
          id: `edge-${sourceId}-${targetId}`,
          source: sourceId,
          target: targetId,
          type: conditionJsonlogic ? "conditionalEdge" : "workflowEdge",
          animated: false,
          data: edgeData,
        });
      } else if (route.status === "self" && route.match) {
        const edgeData: WorkflowEdgeData = {
          sourceStepId: sourceId,
          targetStepId: sourceId,
          conditionJsonlogic,
          routeStatus: "self",
        };
        edges.push({
          id: `edge-self-${sourceId}`,
          source: sourceId,
          target: sourceId,
          type: "workflowEdge",
          animated: false,
          data: edgeData,
        });
      } else if (route.status === "ambiguous") {
        matches.forEach((match) => {
          const targetId = match.stepId;
          const edgeData: WorkflowEdgeData = {
            sourceStepId: sourceId,
            targetStepId: targetId,
            conditionJsonlogic,
            routeStatus: "ambiguous",
          };
          edges.push({
            id: `edge-${sourceId}-${targetId}-amb`,
            source: sourceId,
            target: targetId,
            type: "workflowEdge",
            animated: false,
            style: { strokeDasharray: "6 3" },
            data: edgeData,
          });
        });
      }
      // "missing" and "none" produce no edges (matching legacy behavior).
    });

    return edges;
  }, [steps, idKey, hasTriggers]);
}
