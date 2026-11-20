function assertQueryable(queryable, label = 'queryable') {
  if (!queryable || typeof queryable.query !== 'function') {
    throw new TypeError(`${label} must expose a query(sql, params) function`);
  }

  return queryable;
}

function normalizeUuid(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }

  return normalized;
}

function normalizeObject(value, label) {
  if (value == null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }

  return value;
}

async function resolveTemplateId(queryable, templateName) {
  assertQueryable(queryable, 'queryable');

  const normalizedTemplateName = String(templateName || '').trim();
  if (!normalizedTemplateName) {
    throw new Error('templateName is required');
  }

  const { rows } = await queryable.query(
    `
      SELECT wt.id
      FROM public.workflow_templates wt
      WHERE wt.name = $1
      ORDER BY
        CASE WHEN wt.status = 'active' THEN 0 ELSE 1 END,
        wt.version DESC,
        wt.updated_at DESC NULLS LAST,
        wt.created_at DESC NULLS LAST
      LIMIT 1
    `,
    [normalizedTemplateName],
  );

  const templateId = rows[0]?.id ?? null;
  if (!templateId) {
    throw new Error(`workflow template not found: ${normalizedTemplateName}`);
  }

  return templateId;
}

async function startWorkflowRun(queryable, templateName, context = {}) {
  assertQueryable(queryable, 'queryable');

  const templateId = await resolveTemplateId(queryable, templateName);
  const workflowContext = normalizeObject(context, 'context');

  const { rows } = await queryable.query(
    `SELECT public.start_workflow_run($1::uuid, $2::jsonb) AS workflow_run_id`,
    [templateId, JSON.stringify(workflowContext)],
  );

  const workflowRunId = rows[0]?.workflow_run_id ?? null;
  if (!workflowRunId) {
    throw new Error(`start_workflow_run did not return a workflow run id for template ${templateName}`);
  }

  return { workflowRunId };
}

async function getWorkflowStep(queryable, workflowRunId, options = {}) {
  const normalizedWorkflowRunId = normalizeUuid(workflowRunId, 'workflowRunId');
  const preferredRunStepId = options.preferredRunStepId
    ? normalizeUuid(options.preferredRunStepId, 'preferredRunStepId')
    : null;

  if (preferredRunStepId) {
    const { rows } = await queryable.query(
      `
        SELECT
          wrs.id,
          wrs.workflow_template_step_id,
          wrs.sequence_order,
          wrs.operation_name,
          wrs.step_status AS status,
          wrs.operation_result AS output,
          wrs.handler_key,
          wrs.handler_version,
          wrs.last_error,
          wrs.run_at,
          wrs.retry_attempt,
          wrs.max_retries,
          wrs.operation_started_at,
          wrs.operation_completed_at
        FROM public.workflow_run_steps wrs
        WHERE wrs.workflow_run_id = $1::uuid
          AND wrs.id = $2::uuid
        LIMIT 1
      `,
      [normalizedWorkflowRunId, preferredRunStepId],
    );

    if (rows[0]) {
      return rows[0];
    }
  }

  const { rows: activeRows } = await queryable.query(
    `
      SELECT
        wrs.id,
        wrs.workflow_template_step_id,
        wrs.sequence_order,
        wrs.operation_name,
        wrs.step_status AS status,
        wrs.operation_result AS output,
        wrs.handler_key,
        wrs.handler_version,
        wrs.last_error,
        wrs.run_at,
        wrs.retry_attempt,
        wrs.max_retries,
        wrs.operation_started_at,
        wrs.operation_completed_at
      FROM public.workflow_run_steps wrs
      WHERE wrs.workflow_run_id = $1::uuid
        AND wrs.step_status IN ('pending', 'in_progress')
      ORDER BY
        CASE WHEN wrs.step_status = 'in_progress' THEN 0 ELSE 1 END,
        wrs.sequence_order ASC
      LIMIT 1
    `,
    [normalizedWorkflowRunId],
  );

  if (activeRows[0]) {
    return activeRows[0];
  }

  const { rows: latestRows } = await queryable.query(
    `
      SELECT
        wrs.id,
        wrs.workflow_template_step_id,
        wrs.sequence_order,
        wrs.operation_name,
        wrs.step_status AS status,
        wrs.operation_result AS output,
        wrs.handler_key,
        wrs.handler_version,
        wrs.last_error,
        wrs.run_at,
        wrs.retry_attempt,
        wrs.max_retries,
        wrs.operation_started_at,
        wrs.operation_completed_at
      FROM public.workflow_run_steps wrs
      WHERE wrs.workflow_run_id = $1::uuid
      ORDER BY wrs.sequence_order DESC
      LIMIT 1
    `,
    [normalizedWorkflowRunId],
  );

  return latestRows[0] ?? null;
}

async function progressWorkflowRun(queryable, workflowRunId, stepInput = {}) {
  assertQueryable(queryable, 'queryable');

  const normalizedWorkflowRunId = normalizeUuid(workflowRunId, 'workflowRunId');
  const normalizedStepInput = normalizeObject(stepInput, 'stepInput');

  const { rows } = await queryable.query(
    `SELECT public.progress_workflow_run($1::uuid, $2::jsonb) AS result`,
    [normalizedWorkflowRunId, JSON.stringify(normalizedStepInput)],
  );

  const result = rows[0]?.result ?? {};
  const step = await getWorkflowStep(queryable, normalizedWorkflowRunId, {
    preferredRunStepId: result.step_id ?? result.in_progress_step_id ?? null,
  });

  return {
    workflowRunId: normalizedWorkflowRunId,
    stepId: result.step_id ?? result.in_progress_step_id ?? step?.id ?? null,
    stepName: step?.operation_name ?? null,
    status: result.status ?? step?.status ?? null,
    nextRunAt: result.next_run_at ?? step?.run_at ?? null,
    reason: result.reason ?? null,
    handlerKey: result.handler_key ?? step?.handler_key ?? null,
    output: step?.output ?? null,
    result,
  };
}

async function getWorkflowRunStatus(queryable, workflowRunId) {
  assertQueryable(queryable, 'queryable');

  const normalizedWorkflowRunId = normalizeUuid(workflowRunId, 'workflowRunId');

  const { rows: workflowRunRows } = await queryable.query(
    `
      SELECT
        wr.id,
        wr.workflow_template_id,
        wt.name AS template_name,
        wt.version AS template_version,
        wr.workflow_status AS status,
        wr.current_step_id,
        wr.context,
        wr.metadata,
        wr.failure_reason,
        wr.last_error,
        wr.started_at,
        wr.completed_at,
        wr.updated_at
      FROM public.workflow_runs wr
      JOIN public.workflow_templates wt
        ON wt.id = wr.workflow_template_id
      WHERE wr.id = $1::uuid
      LIMIT 1
    `,
    [normalizedWorkflowRunId],
  );

  const workflowRun = workflowRunRows[0] ?? null;
  if (!workflowRun) {
    throw new Error(`workflow run not found: ${normalizedWorkflowRunId}`);
  }

  const { rows: stepRows } = await queryable.query(
    `
      SELECT
        wrs.id,
        wrs.workflow_template_step_id,
        wrs.sequence_order,
        wrs.operation_name,
        wrs.step_status AS status,
        wrs.operation_result AS output,
        wrs.handler_key,
        wrs.handler_version,
        wrs.last_error,
        wrs.retry_attempt,
        wrs.max_retries,
        wrs.run_at,
        wrs.operation_started_at,
        wrs.operation_completed_at
      FROM public.workflow_run_steps wrs
      WHERE wrs.workflow_run_id = $1::uuid
      ORDER BY wrs.sequence_order ASC
    `,
    [normalizedWorkflowRunId],
  );

  return {
    id: workflowRun.id,
    workflowTemplateId: workflowRun.workflow_template_id,
    templateName: workflowRun.template_name,
    templateVersion: workflowRun.template_version,
    status: workflowRun.status,
    currentStepId: workflowRun.current_step_id,
    context: workflowRun.context ?? {},
    metadata: workflowRun.metadata ?? {},
    failureReason: workflowRun.failure_reason ?? null,
    lastError: workflowRun.last_error ?? null,
    startedAt: workflowRun.started_at ?? null,
    completedAt: workflowRun.completed_at ?? null,
    updatedAt: workflowRun.updated_at ?? null,
    steps: stepRows.map((step) => ({
      id: step.id,
      workflowTemplateStepId: step.workflow_template_step_id,
      sequenceOrder: step.sequence_order,
      name: step.operation_name,
      status: step.status,
      output: step.output ?? null,
      handlerKey: step.handler_key ?? null,
      handlerVersion: step.handler_version ?? null,
      lastError: step.last_error ?? null,
      retryAttempt: step.retry_attempt,
      maxRetries: step.max_retries,
      runAt: step.run_at ?? null,
      startedAt: step.operation_started_at ?? null,
      completedAt: step.operation_completed_at ?? null,
    })),
  };
}

module.exports = {
  getWorkflowRunStatus,
  progressWorkflowRun,
  resolveTemplateId,
  startWorkflowRun,
};
