const { setTimeout: delay } = require('node:timers/promises');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TERMINAL_STATUSES = ['completed', 'failed', 'skipped'];

const DOMAIN_EVENT_COLUMNS = {
  id: 'de.id',
  organization_id: 'de.organization_id',
  event_type: 'de.event_type',
  resource_type: 'de.resource_type',
  resource_id: 'de.resource_id',
  workflow_run_id: 'de.workflow_run_id',
  correlation_id: 'de.correlation_id',
};

function assertQueryable(queryable, label = 'queryable') {
  if (!queryable || typeof queryable.query !== 'function') {
    throw new TypeError(`${label} must expose a query(sql, params) function`);
  }

  return queryable;
}

function normalizePositiveInteger(value, fallback, label) {
  const normalized = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }

  return normalized;
}

function normalizeStatusList(statuses, fallback) {
  const list = Array.isArray(statuses) ? statuses : fallback;
  const normalized = list
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error('terminalStatuses must include at least one status');
  }

  return normalized;
}

function buildCriteriaQuery(criteria, terminalStatuses) {
  const normalizedCriteria = criteria && typeof criteria === 'object' && !Array.isArray(criteria)
    ? criteria
    : null;

  if (!normalizedCriteria) {
    throw new TypeError('criteria must be a plain object');
  }

  const clauses = [`de.status = ANY($1::text[])`];
  const values = [terminalStatuses];
  let parameterIndex = 2;

  for (const [key, column] of Object.entries(DOMAIN_EVENT_COLUMNS)) {
    const rawValue = normalizedCriteria[key];
    if (rawValue == null || rawValue === '') {
      continue;
    }

    const value =
      key === 'event_type' || key === 'resource_type'
        ? String(rawValue).trim().toLowerCase()
        : String(rawValue).trim();

    if (!value) {
      continue;
    }

    if (key.endsWith('_id') || key === 'id' || key === 'correlation_id') {
      clauses.push(`${column} = $${parameterIndex}::uuid`);
    } else {
      clauses.push(`${column} = $${parameterIndex}`);
    }
    values.push(value);
    parameterIndex += 1;
  }

  if (clauses.length === 1) {
    throw new Error('waitForDomainEvent requires at least one concrete match criterion');
  }

  return { clauses, values };
}

async function findDomainEvent(queryable, criteria, terminalStatuses) {
  const { clauses, values } = buildCriteriaQuery(criteria, terminalStatuses);
  const { rows } = await queryable.query(
    `
      SELECT
        de.id,
        de.status,
        de.organization_id,
        de.event_type,
        de.resource_type,
        de.resource_id,
        de.workflow_run_id,
        de.correlation_id,
        de.error_reason,
        de.payload,
        de.created_at,
        de.updated_at,
        de.processed_at
      FROM public.domain_events de
      WHERE ${clauses.join(' AND ')}
      ORDER BY de.created_at DESC, de.updated_at DESC, de.id DESC
      LIMIT 1
    `,
    values,
  );

  const row = rows[0] ?? null;
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    organizationId: row.organization_id ?? null,
    eventType: row.event_type,
    resourceType: row.resource_type ?? null,
    resourceId: row.resource_id ?? null,
    workflowRunId: row.workflow_run_id ?? null,
    correlationId: row.correlation_id ?? null,
    errorReason: row.error_reason ?? null,
    payload: row.payload ?? {},
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    processedAt: row.processed_at ?? null,
  };
}

async function findLatestMatchingDomainEvent(queryable, criteria) {
  const normalizedCriteria = criteria && typeof criteria === 'object' && !Array.isArray(criteria)
    ? criteria
    : null;

  if (!normalizedCriteria) {
    return null;
  }

  const clauses = [];
  const values = [];
  let parameterIndex = 1;

  for (const [key, column] of Object.entries(DOMAIN_EVENT_COLUMNS)) {
    const rawValue = normalizedCriteria[key];
    if (rawValue == null || rawValue === '') {
      continue;
    }

    const value =
      key === 'event_type' || key === 'resource_type'
        ? String(rawValue).trim().toLowerCase()
        : String(rawValue).trim();

    if (!value) {
      continue;
    }

    if (key.endsWith('_id') || key === 'id' || key === 'correlation_id') {
      clauses.push(`${column} = $${parameterIndex}::uuid`);
    } else {
      clauses.push(`${column} = $${parameterIndex}`);
    }
    values.push(value);
    parameterIndex += 1;
  }

  if (clauses.length === 0) {
    return null;
  }

  const { rows } = await queryable.query(
    `
      SELECT
        de.id,
        de.status,
        de.event_type,
        de.resource_type,
        de.resource_id,
        de.workflow_run_id,
        de.processed_at
      FROM public.domain_events de
      WHERE ${clauses.join(' AND ')}
      ORDER BY de.created_at DESC, de.updated_at DESC, de.id DESC
      LIMIT 1
    `,
    values,
  );

  return rows[0] ?? null;
}

async function processPendingDomainEvents(queryable) {
  assertQueryable(queryable, 'queryable');

  await queryable.query(
    `
      INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
      VALUES ('domain_events_worker', 60, 50, true, 'integration helper: domain_events_worker')
      ON CONFLICT (worker_name)
      DO UPDATE SET
        interval_seconds = EXCLUDED.interval_seconds,
        batch_size = EXCLUDED.batch_size,
        enabled = true,
        notes = EXCLUDED.notes
    `,
  );

  await queryable.query(
    `
      UPDATE public.cron_config
      SET last_run_at = now() - make_interval(secs => GREATEST(COALESCE(interval_seconds, 60), 1) * 5)
      WHERE worker_name = 'domain_events_worker'
    `,
  );

  const { rows } = await queryable.query(
    `SELECT public.run_domain_events_worker() AS result`,
  );

  const result = rows[0]?.result ?? {};
  const processedCount = Number(result.items_processed ?? result.processed_count ?? result.count ?? 0);
  return Number.isFinite(processedCount) ? processedCount : 0;
}

async function waitForDomainEventWorkflowRun(queryable, domainEventId, options = {}) {
  assertQueryable(queryable, 'queryable');

  const normalizedDomainEventId = String(domainEventId || '').trim();
  if (!normalizedDomainEventId) {
    throw new Error('waitForDomainEventWorkflowRun requires domainEventId');
  }

  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const pollIntervalMs = normalizePositiveInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const shouldProcessPending = options.processPending !== false;

  const deadline = Date.now() + timeoutMs;
  let lastSeenEvent = null;

  while (Date.now() <= deadline) {
    if (shouldProcessPending) {
      await processPendingDomainEvents(queryable);
    }

    const { rows } = await queryable.query(
      `
        SELECT id, status, workflow_run_id, error_reason
        FROM public.domain_events
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [normalizedDomainEventId],
    );

    const row = rows[0] ?? null;
    if (row?.workflow_run_id) {
      return row.workflow_run_id;
    }

    lastSeenEvent = row;
    if (row && ['failed', 'skipped'].includes(String(row.status || '').toLowerCase())) {
      break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(pollIntervalMs, remainingMs), undefined, { ref: false });
  }

  const lastSeenSummary = lastSeenEvent
    ? ` last_status=${lastSeenEvent.status} last_error=${lastSeenEvent.error_reason ?? 'null'}`
    : ' last_status=missing';

  throw new Error(
    `Timed out waiting for domain event ${normalizedDomainEventId} to attach workflow_run_id after ${timeoutMs}ms.${lastSeenSummary}`,
  );
}

async function waitForDomainEvent(queryable, criteria, options = {}) {
  assertQueryable(queryable, 'queryable');

  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const pollIntervalMs = normalizePositiveInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const terminalStatuses = normalizeStatusList(options.terminalStatuses, DEFAULT_TERMINAL_STATUSES);
  const shouldProcessPending = options.processPending !== false;

  const deadline = Date.now() + timeoutMs;
  let lastSeenEvent = null;

  while (Date.now() <= deadline) {
    if (shouldProcessPending) {
      await processPendingDomainEvents(queryable);
    }

    const event = await findDomainEvent(queryable, criteria, terminalStatuses);
    if (event) {
      return event;
    }

    lastSeenEvent = await findLatestMatchingDomainEvent(queryable, criteria);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(pollIntervalMs, remainingMs), undefined, { ref: false });
  }

  const criteriaJson = JSON.stringify(criteria);
  const lastSeenSummary = lastSeenEvent
    ? ` last_seen_status=${lastSeenEvent.status} last_seen_id=${lastSeenEvent.id}`
    : '';

  throw new Error(
    `Timed out waiting for domain event terminal state after ${timeoutMs}ms: criteria=${criteriaJson}.${lastSeenSummary}`,
  );
}

module.exports = {
  processPendingDomainEvents,
  waitForDomainEvent,
  waitForDomainEventWorkflowRun,
};
