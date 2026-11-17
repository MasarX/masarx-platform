import {
  isWorkflowRunLogStepIssue,
  type WorkflowRunLogStep,
} from "./workflow-run-logs-model";

export type WorkflowRunStepReplayConfig = {
  workflowTemplateId: string;
  workflowRunId: string;
  payload?: unknown;
  capabilities?: string[] | null;
};

export type WorkflowRunReplayAudit = {
  mode: string;
  sourceRunId: string | null;
  sourceWorkflowRunStepId: string | null;
  sourceWorkflowTemplateStepId: string | null;
  sourceWorkflowRunStepIds: string[];
  sourceWorkflowTemplateStepIds: string[];
};

function normalizeReplayPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeReplayIdList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry.length > 0)
    )
  );
}

function normalizeReplayId(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function extractReplayAudit(payload: unknown): WorkflowRunReplayAudit | null {
  const base = normalizeReplayPayload(payload);
  const raw = base._ui_replay;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const replay = raw as Record<string, unknown>;
  const mode = normalizeReplayId(replay.mode);
  if (!mode) return null;
  return {
    mode,
    sourceRunId: normalizeReplayId(replay.source_run_id),
    sourceWorkflowRunStepId: normalizeReplayId(
      replay.source_workflow_run_step_id
    ),
    sourceWorkflowTemplateStepId: normalizeReplayId(
      replay.source_workflow_template_step_id
    ),
    sourceWorkflowRunStepIds: normalizeReplayIdList(
      replay.source_workflow_run_step_ids
    ),
    sourceWorkflowTemplateStepIds: normalizeReplayIdList(
      replay.source_workflow_template_step_ids
    ),
  };
}

export function buildReplayPayload(
  basePayload: unknown,
  step: WorkflowRunLogStep,
  workflowRunId: string
) {
  const base = normalizeReplayPayload(basePayload);
  return {
    ...base,
    _ui_replay: {
      mode: "from_step",
      source_run_id: workflowRunId,
      source_workflow_run_step_id: step.id,
      source_workflow_template_step_id: step.workflowTemplateStepId,
    },
  };
}

export function buildBatchReplayPayload(
  basePayload: unknown,
  steps: WorkflowRunLogStep[],
  workflowRunId: string
) {
  const base = normalizeReplayPayload(basePayload);
  const stepIds = Array.from(
    new Set(
      steps
        .map((step) => step.id?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
  const templateStepIds = Array.from(
    new Set(
      steps
        .map((step) => step.workflowTemplateStepId?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
  return {
    ...base,
    _ui_replay: {
      mode: "failed_steps_batch",
      source_run_id: workflowRunId,
      source_workflow_run_step_ids: stepIds,
      source_workflow_template_step_ids: templateStepIds,
    },
  };
}

export function resolveReplayIssueSteps(
  steps: WorkflowRunLogStep[],
  stepReplay?: WorkflowRunStepReplayConfig | null
) {
  if (!stepReplay?.workflowTemplateId || !stepReplay.workflowRunId) return [];
  return [...steps]
    .filter(
      (step) =>
        isWorkflowRunLogStepIssue(step) &&
        typeof step.workflowTemplateStepId === "string" &&
        step.workflowTemplateStepId.trim().length > 0
    )
    .sort((left, right) => {
      const leftOrder =
        typeof left.sequenceOrder === "number"
          ? left.sequenceOrder
          : Number.MAX_SAFE_INTEGER;
      const rightOrder =
        typeof right.sequenceOrder === "number"
          ? right.sequenceOrder
          : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.id.localeCompare(right.id);
    });
}
