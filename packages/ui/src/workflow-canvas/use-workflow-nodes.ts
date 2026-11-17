import { useMemo } from "react";
import type { WorkflowStepNode, WorkflowTriggerNode, WorkflowNode } from "./workflow-canvas-types";

/* ---------------------------------------------------------------------------
 * Helpers to extract typed values from untyped step/trigger records.
 * -------------------------------------------------------------------------*/

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/* ---------------------------------------------------------------------------
 * Default horizontal layout constants.
 * -------------------------------------------------------------------------*/

const NODE_GAP_X = 320;
const NODE_GAP_Y = 0;
const NODE_START_X = 300;
const NODE_START_Y = 120;
const TRIGGER_NODE_X = 40;
const TRIGGER_NODE_Y = 120;

/* ---------------------------------------------------------------------------
 * Convert workflow_template_steps[] → React Flow Node[].
 * -------------------------------------------------------------------------*/

export type UseWorkflowNodesOptions = {
  steps: Record<string, unknown>[];
  idKey: string;
  triggers?: Record<string, unknown>[] | null;
  runStepMap?: Map<string, Record<string, unknown>> | null;
};

export function useWorkflowNodes({
  steps,
  idKey,
  triggers,
  runStepMap,
}: UseWorkflowNodesOptions): WorkflowNode[] {
  return useMemo(() => {
    const nodes: WorkflowNode[] = [];

    /* Trigger aggregation node -----------------------------------------*/
    const triggerItems = Array.isArray(triggers) ? triggers : [];
    if (triggerItems.length > 0) {
      const first = triggerItems[0]!;
      const triggerNode: WorkflowTriggerNode = {
        id: "__workflow_triggers__",
        type: "workflowTrigger",
        position: { x: TRIGGER_NODE_X, y: TRIGGER_NODE_Y },
        data: {
          triggerId: normalizeText(first.webhook_source_id ?? first.id) ?? "__trigger__",
          kind: "webhook",
          label: `${triggerItems.length} trigger${triggerItems.length === 1 ? "" : "s"}`,
          enabled: true,
        },
        draggable: false,
      };
      nodes.push(triggerNode);
    }

    /* Step nodes -------------------------------------------------------*/
    steps.forEach((step, index) => {
      const stepId = normalizeText(step[idKey]);
      if (!stepId) return;

      const runStep = runStepMap?.get(stepId) ?? null;
      const runStatus = runStep ? normalizeText(runStep.status) : null;
      const runDurationMs = runStep ? normalizeNumber(runStep.duration_ms) : null;

      const stepNode: WorkflowStepNode = {
        id: stepId,
        type: "workflowStep",
        position: {
          x: NODE_START_X + index * NODE_GAP_X,
          y: NODE_START_Y + index * NODE_GAP_Y,
        },
        data: {
          stepId,
          operationName: normalizeText(step.operation_name) ?? "",
          handlerKey: normalizeText(step.handler_key),
          enabled: normalizeBoolean(step.enabled ?? true),
          manualActionRequired: normalizeBoolean(step.manual_action_required),
          transitionCondition: normalizeText(step.transition_condition),
          nextOperationName: normalizeText(step.next_operation_name),
          nextOperationPriority: normalizeNumber(step.next_operation_priority),
          nextOperationDelaySeconds: normalizeNumber(step.next_operation_delay_seconds),
          conditionJsonlogic: normalizeRecord(step.condition_jsonlogic),
          metadata: normalizeRecord(step.metadata),
          runStatus,
          runDurationMs,
          stepIndex: index + 1,
        },
      };
      nodes.push(stepNode);
    });

    return nodes;
  }, [steps, idKey, triggers, runStepMap]);
}
