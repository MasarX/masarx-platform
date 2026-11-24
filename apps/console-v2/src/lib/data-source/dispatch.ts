import { translateAdapterMessage } from '../i18n';
import {
  backendOutcomeError,
  type BasketCreateMutationResult,
  type BasketUpdateMutationResult,
  buildEnvelope,
  compactRecord,
  CONSOLE_DISPATCH_SCAN_DEVICE_STORAGE_KEY,
  type DispatchExceptionResolutionCanonicalArgs,
  type DispatchExceptionResolutionOpts,
  type DispatchExceptionResolutionResult,
  firstRpcRow,
  getLookups,
  liveBackendUnavailableError,
  liveRpc,
  type NdrBranchNextActionArgs,
  nextCorrelationId,
  nextResourceId,
  normalizeDispatchResolutionLiveResult,
  normalizeLiveListResult,
  objectRecord,
  pickupFailuresSeed,
  pickupRequestsSeed,
  pickupWavesSeed,
  requireLiveEvidence,
  requireLiveMutationResult,
  requireLiveNumberField,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  requireLiveRouteRunAssignmentReadback,
  requireLiveRpcRecord,
  requireLiveStringField,
  RESOURCE_DATA,
  type RoutePlanConstraintCheck,
  type RoutePlanCreateInput,
  type RoutePlanExecutionPack,
  type RoutePlanRebalanceInput,
  type RouteRunAssignmentResponseParams,
  type RouteRunAssignmentResponseResult,
  type RouteRunAssignTarget,
  type RouteStopReassignTarget,
  seed,
  sleep,
  state,
  ui_get_resource_v1,
  type WarehouseScanCorrectionRequestArgs,
  type WarehouseTransferManifestCreateResult,
  type WarehouseTransferUiActionResult,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';

function defaultLookupValue(category: string): string | null {
  const rows = getLookups(category) as unknown as Array<Record<string, unknown>>;
  const preferred = rows.find((row) => row.is_default === true) ?? rows[0];
  return asNonEmptyString(preferred?.value);
}

export async function basket_create_v1(
  args: Record<string, unknown>,
): Promise<BasketCreateMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('basket_create_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'basket_create_v1', [
      'basket_id',
    ]) as BasketCreateMutationResult;
  }

  await sleep(60);
  const organizationId =
    asNonEmptyString(args.organization_id) ??
    asNonEmptyString(state.user.organization_id) ??
    asNonEmptyString((state.scope?.tenant as Record<string, unknown> | undefined)?.id);
  if (!organizationId) throw new Error('basket_create_v1 requires organization_id or tenant scope');

  const basketType = asNonEmptyString(args.basket_type) ?? defaultLookupValue('basket_type');
  const basketState = asNonEmptyString(args.state) ?? defaultLookupValue('basket_state');
  if (!basketState) throw new Error('basket_create_v1 requires a basket_state lookup default');

  const capacityRaw = args.capacity_count;
  const capacity = capacityRaw === undefined || capacityRaw === null || capacityRaw === ''
    ? null
    : Number(capacityRaw);
  if (capacity != null && (!Number.isFinite(capacity) || capacity < 1)) {
    throw new Error('basket_create_v1 capacity_count must be positive');
  }

  const expiresAt =
    asNonEmptyString(args.expires_at) ??
    (() => {
      const minutesRaw = args.expires_in_minutes;
      if (minutesRaw === undefined || minutesRaw === null || minutesRaw === '') return null;
      const minutes = Number(minutesRaw);
      if (!Number.isFinite(minutes) || minutes < 1) {
        throw new Error('basket_create_v1 expires_in_minutes must be positive');
      }
      return new Date(Date.now() + minutes * 60_000).toISOString();
    })();

  const basketId = nextResourceId('basket');
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    id: basketId,
    organization_id: organizationId,
    zone_id: asNonEmptyString(args.zone_id),
    basket_type: basketType,
    state: basketState,
    current_count: 0,
    capacity_count: capacity,
    expires_at: expiresAt,
    version: 1,
    created_at: now,
    updated_at: now,
    sort_branch_id: asNonEmptyString(args.sort_branch_id),
    sort_service_key: asNonEmptyString(args.sort_service_key),
    sort_route_key: asNonEmptyString(args.sort_route_key),
    sort_priority_key: asNonEmptyString(args.sort_priority_key),
  };
  const baskets = (seed as { baskets?: Array<Record<string, unknown>> }).baskets;
  if (Array.isArray(baskets)) baskets.unshift(row);

  return buildEnvelope({
    basket_id: basketId,
    zone_id: row.zone_id,
    basket_type: basketType,
    state: basketState,
    capacity_count: capacity,
    expires_at: expiresAt,
  }) as BasketCreateMutationResult;
}

export async function basket_update_v1(
  args: Record<string, unknown>,
): Promise<BasketUpdateMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('basket_update_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'basket_update_v1', [
      'basket_id',
    ]) as BasketUpdateMutationResult;
  }

  await sleep(60);
  const basketId = asNonEmptyString(args.basket_id) ?? asNonEmptyString(args.id);
  if (!basketId) throw new Error('basket_update_v1 requires basket_id');
  const patch = objectRecord(args.patch);
  if (!Object.keys(patch).length) throw new Error('basket_update_v1 requires a non-empty patch');
  const allowedPatchKeys = new Set([
    'zone_id',
    'basket_type',
    'capacity_count',
    'expires_at',
    'sort_branch_id',
    'sort_service_key',
    'sort_route_key',
    'sort_priority_key',
  ]);
  const unsupportedPatchKeys = Object.keys(patch).filter((key) => !allowedPatchKeys.has(key)).sort();
  if (unsupportedPatchKeys.length) {
    throw new Error(`basket_update_v1 unsupported patch keys: ${unsupportedPatchKeys.join(', ')}`);
  }

  const baskets = (seed as { baskets?: Array<Record<string, unknown>> }).baskets ?? [];
  const basket = baskets.find((row) => row.id === basketId);
  if (!basket) throw new Error(`basket_not_found:${basketId}`);

  const changed: Record<string, unknown> = {};
  if (patch.zone_id !== undefined) {
    const zoneId = asNonEmptyString(patch.zone_id) ?? null;
    basket.zone_id = zoneId;
    changed.zone_id = zoneId;
  }
  if (patch.basket_type !== undefined) {
    const basketType = asNonEmptyString(patch.basket_type);
    if (!basketType) throw new Error('basket_update_v1 basket_type cannot be blank');
    basket.basket_type = basketType;
    changed.basket_type = basketType;
  }
  if (patch.capacity_count !== undefined) {
    const capacity = patch.capacity_count === null || patch.capacity_count === ''
      ? null
      : Number(patch.capacity_count);
    if (capacity != null && (!Number.isFinite(capacity) || capacity < 1)) {
      throw new Error('basket_update_v1 capacity_count must be positive');
    }
    if (capacity != null && capacity < Number(basket.current_count ?? 0)) {
      throw new Error('basket_update_v1 capacity_count cannot be below current_count');
    }
    basket.capacity_count = capacity;
    changed.capacity_count = capacity;
  }
  if (patch.expires_at !== undefined) {
    const expiresAt = asNonEmptyString(patch.expires_at) ?? null;
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('basket_update_v1 expires_at must be a valid timestamp');
    }
    basket.expires_at = expiresAt;
    changed.expires_at = expiresAt;
  }
  for (const key of ['sort_branch_id', 'sort_service_key', 'sort_route_key', 'sort_priority_key']) {
    if (patch[key] !== undefined) {
      const next = asNonEmptyString(patch[key]) ?? null;
      basket[key] = next;
      changed[key] = next;
    }
  }

  basket.version = Number(basket.version ?? 1) + 1;
  basket.updated_at = new Date().toISOString();

  return buildEnvelope({
    basket_id: basketId,
    changed,
  }) as BasketUpdateMutationResult;
}

// ----------- Route plans / runs / stops -----------
//
// Stubs mirror the cloud `api.*` surface from these migrations:
//   - 202604032350_route_plan_ui_api_contract_v1.sql        (ui_create/freeze/apply)
//   - 202604041520_route_plan_sequence_optimizer_v1.sql     (ui_solve)
//   - 202604061030_route_plan_publish_execution_pack_v1.sql (ui_publish)
//   - 202604061315_route_plan_rebalance_v1.sql              (ui_rebalance)
//   - 202604061140_route_plan_constraint_guards_v1.sql      (route_plan_validate_constraints)
//   - 202604061430_uc076_route_run_assignment_lifecycle_foundation_v1.sql
//   - 202604081330_uc077_route_run_execution_manifest_reassignment_v1.sql
//   - 202604101500_uc082_route_run_scan_out_departure_gate_v1.sql
//   - 202604101715_uc078_route_stop_mid_execution_reassignment_v1.sql

async function requireLiveRoutePlanReadback(
  routePlanId: string,
  expectedStatus: string | null,
  rpcName: string,
): Promise<Record<string, unknown>> {
  const row = await requireLiveResourceReadback('route_plans', routePlanId, rpcName);
  const readbackPlanId =
    asNonEmptyString(row.id) ??
    asNonEmptyString(row.route_plan_id) ??
    asNonEmptyString(row.plan_id);
  if (!readbackPlanId) {
    throw new Error(`${rpcName} backend readback missing route_plan_id`);
  }
  if (readbackPlanId !== routePlanId) {
    throw new Error(`${rpcName} backend readback returned route_plan_id ${readbackPlanId}`);
  }
  const status = requireLiveStringField(
    row,
    ['status', 'route_plan_status'],
    `${rpcName} backend readback missing route plan status`,
  );
  if (expectedStatus && status !== expectedStatus) {
    throw new Error(`${rpcName} backend readback status ${status} did not match ${expectedStatus}`);
  }
  return row;
}

function routePlanConstraintValidationEvidence(
  mutationRow: Record<string, unknown>,
  readbackRow: Record<string, unknown>,
): Record<string, unknown> {
  const mutationValidation = objectRecord(mutationRow.constraint_validation);
  if (Object.keys(mutationValidation).length) return mutationValidation;

  const readbackValidation = objectRecord(readbackRow.constraint_validation);
  if (Object.keys(readbackValidation).length) return readbackValidation;

  const readbackMetadata = objectRecord(readbackRow.metadata);
  const metadataValidation = objectRecord(readbackMetadata.constraint_validation);
  if (Object.keys(metadataValidation).length) return metadataValidation;

  return {};
}

function routePlanConstraintFailCount(validation: Record<string, unknown>): number {
  const explicit = Number(validation.fail_count ?? validation.failure_count ?? validation.failed_count);
  if (Number.isFinite(explicit)) return explicit;

  const violations = validation.violations;
  if (Array.isArray(violations)) return violations.length;

  const failures = validation.failures;
  if (Array.isArray(failures)) return failures.length;

  return 0;
}

async function requireLiveRoutePlanExecutionPackReadback(
  routePlanId: string,
  executionPackHash: string,
  rpcName: string,
): Promise<void> {
  const live = await liveRpc<Record<string, unknown> | null>('ui_route_plan_execution_pack_v1', {
    p_route_plan_id: routePlanId,
  });
  if (!live) throw new Error(`${rpcName} execution-pack readback requires a live backend`);
  const row = firstRpcRow<Record<string, unknown>>(live.data);
  if (!row || Object.keys(row).length === 0) {
    throw new Error(`${rpcName} backend readback missing route-plan execution pack:${routePlanId}`);
  }
  const readbackHash = requireLiveStringField(
    row,
    ['execution_pack_hash', 'published_execution_pack_hash'],
    `${rpcName} backend readback missing execution_pack_hash`,
  );
  if (readbackHash !== executionPackHash) {
    throw new Error(`${rpcName} backend readback execution_pack_hash did not match`);
  }
}

async function requireLiveRouteRunsReadback(
  routePlanId: string,
  rpcName: string,
): Promise<void> {
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'route_runs',
    p_filters: { route_plan_id: routePlanId },
    p_limit: 25,
    p_offset: 0,
    p_sort: null,
  });
  if (!live) throw new Error(`${rpcName} route-run readback requires a live backend`);
  const rows = normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 25).rows;
  if (rows.length === 0) {
    throw new Error(`${rpcName} backend readback missing materialized route_runs:${routePlanId}`);
  }
}

export async function ui_create_route_plan_v1(
  input: RoutePlanCreateInput,
): Promise<{ ok: true; route_plan_id: string; status: string; plan_id: string }> {
  const live = await liveRpc('ui_create_route_plan_v1', {
    p_input: input,
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_create_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'workflow_run_id',
    ]);
    const routePlanId = requireLiveStringField(
      row,
      ['route_plan_id', 'plan_id', 'id'],
      'Route plan create did not return route_plan_id',
    );
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan create did not return status',
    );
    await requireLiveRoutePlanReadback(routePlanId, status, 'ui_create_route_plan_v1');
    return {
      ...row,
      ok: true,
      route_plan_id: routePlanId,
      status,
      plan_id: String(row.plan_id ?? routePlanId),
    };
  }

  await sleep(180);
  const id = 'rpl_new_' + Math.floor(Math.random() * 90000);
  return {
    ok: true,
    route_plan_id: id,
    status: 'draft',
    plan_id: `PLN-${input.planned_date.replaceAll('-', '').slice(2)}-${input.branch_id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`,
  };
}

export async function ui_solve_route_plan_v1(planId: string): Promise<{ ok: true; plan_id: string; status: string }> {
  const live = await liveRpc('ui_solve_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_solve_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'workflow_run_id',
    ]);
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan solve did not return status',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    await requireLiveRoutePlanReadback(routePlanId, status, 'ui_solve_route_plan_v1');
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      status,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, status: 'solved' };
}

export async function ui_freeze_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; status: string; constraint_validation: { fail_count: number } }> {
  const live = await liveRpc('ui_freeze_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_freeze_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'workflow_run_id',
    ]);
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan freeze did not return status',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    const readback = await requireLiveRoutePlanReadback(routePlanId, status, 'ui_freeze_route_plan_v1');
    const constraintValidation = routePlanConstraintValidationEvidence(row, readback);
    if (!Object.keys(constraintValidation).length) {
      throw new Error('Route plan freeze backend readback missing constraint validation');
    }
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      status,
      constraint_validation: {
        ...constraintValidation,
        fail_count: routePlanConstraintFailCount(constraintValidation),
      },
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, status: 'frozen', constraint_validation: { fail_count: 0 } };
}

export async function ui_publish_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; execution_pack_hash: string }> {
  const live = await liveRpc('ui_publish_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_publish_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'execution_pack_hash',
    ]);
    const executionPackHash = requireLiveStringField(
      row,
      ['execution_pack_hash', 'published_execution_pack_hash'],
      'Route plan publish did not return execution_pack_hash',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    await requireLiveRoutePlanReadback(routePlanId, 'published', 'ui_publish_route_plan_v1');
    await requireLiveRoutePlanExecutionPackReadback(
      routePlanId,
      executionPackHash,
      'ui_publish_route_plan_v1',
    );
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      execution_pack_hash: executionPackHash,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, execution_pack_hash: '0x' + Math.random().toString(16).slice(2, 10) };
}

export async function ui_route_plan_execution_pack_v1(
  planId: string,
): Promise<RoutePlanExecutionPack | null> {
  const live = await liveRpc<Record<string, unknown> | null>('ui_route_plan_execution_pack_v1', {
    p_route_plan_id: planId,
  });
  if (live) {
    const rec = firstRpcRow<Record<string, unknown>>(live.data);
    if (!rec) return null;
    return {
      ...rec,
      route_plan_id: String(rec.route_plan_id ?? planId),
      execution_pack_hash: asNonEmptyString(rec.execution_pack_hash) ?? undefined,
      stop_count: Number(rec.stop_count ?? 0),
      shipment_count: Number(rec.shipment_count ?? 0),
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_route_plan_execution_pack_v1');
  await sleep(80);
  const plan = ((RESOURCE_DATA().route_plans ?? []) as Record<string, unknown>[])
    .find((row) => row.id === planId || row.plan_id === planId);
  const status = asNonEmptyString(plan?.status);
  if (!plan || (status !== 'published' && status !== 'applied')) return null;
  const stopCount = Number(plan.stops ?? 0);
  return {
    route_plan_id: String(plan.id ?? planId),
    route_plan_status: status,
    execution_pack_hash: asNonEmptyString(plan.execution_pack_hash ?? plan.published_execution_pack_hash) ?? `seed-${planId}`,
    stop_count: stopCount,
    shipment_count: stopCount,
  };
}

export async function ui_apply_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; status: string; runs_materialized: number }> {
  const live = await liveRpc('ui_apply_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const rows = Array.isArray(live.data) ? live.data : [];
    const row = requireLiveMutationResult(live.data, 'ui_apply_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'route_run_id',
      'route_run_ids',
      'runs_materialized',
    ]);
    const routeRunIds = Array.isArray(row.route_run_ids) ? row.route_run_ids : [];
    const singleRouteRunId = asNonEmptyString(row.route_run_id);
    const runsMaterialized =
      rows.length ||
      routeRunIds.length ||
      (singleRouteRunId ? 1 : Number(row.runs_materialized ?? row.run_count));
    if (!Number.isFinite(runsMaterialized) || runsMaterialized <= 0) {
      throw new Error('Route plan apply did not return materialized route-run evidence');
    }
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan apply did not return status',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    await requireLiveRoutePlanReadback(routePlanId, status, 'ui_apply_route_plan_v1');
    await requireLiveRouteRunsReadback(routePlanId, 'ui_apply_route_plan_v1');
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      status,
      runs_materialized: runsMaterialized,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, status: 'applied', runs_materialized: 18 };
}

export async function ui_rebalance_route_plan_v1(
  input: RoutePlanRebalanceInput,
): Promise<{ ok: true; plan_id: string; moves_applied: number }> {
  const shipmentIds = Array.isArray(input.shipment_ids) ? input.shipment_ids : [];
  const live = await liveRpc('ui_rebalance_route_plan_v1', {
    p_input: input,
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_rebalance_route_plan_v1', [
      'source_route_plan_id',
      'target_route_plan_id',
      'moved_stop_count',
      'moves_applied',
      'workflow_run_id',
    ]);
    const movesApplied = requireLiveNumberField(
      row,
      ['moved_stop_count', 'moves_applied', 'count', 'affected_count'],
      'Route plan rebalance did not return moved stop count',
    );
    const sourceRoutePlanId = requireLiveStringField(
      row,
      ['source_route_plan_id'],
      'Route plan rebalance did not return source_route_plan_id',
    );
    const targetRoutePlanId = requireLiveStringField(
      row,
      ['target_route_plan_id'],
      'Route plan rebalance did not return target_route_plan_id',
    );
    if (sourceRoutePlanId !== input.source_route_plan_id) {
      throw new Error('Route plan rebalance returned a different source_route_plan_id');
    }
    if (input.target_route_plan_id && targetRoutePlanId !== input.target_route_plan_id) {
      throw new Error('Route plan rebalance returned a different target_route_plan_id');
    }
    await requireLiveRoutePlanReadback(
      sourceRoutePlanId,
      asNonEmptyString(row.source_status) ?? null,
      'ui_rebalance_route_plan_v1 source',
    );
    await requireLiveRoutePlanReadback(
      targetRoutePlanId,
      asNonEmptyString(row.target_status) ?? null,
      'ui_rebalance_route_plan_v1 target',
    );
    return {
      ...row,
      ok: true,
      plan_id: sourceRoutePlanId,
      moves_applied: movesApplied,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: input.source_route_plan_id, moves_applied: shipmentIds.length };
}

function routePlanConstraintStatus(value: unknown, failed: number): RoutePlanConstraintCheck['status'] {
  const status = asNonEmptyString(value);
  if (status === 'pass' || status === 'warn' || status === 'danger') return status;
  return failed > 0 ? 'danger' : 'pass';
}

function normalizeRoutePlanConstraintItem(value: unknown, index: number): RoutePlanConstraintCheck {
  const rec = objectRecord(value);
  if (!Object.keys(rec).length) {
    throw new Error(`Route plan constraint validation check ${index + 1} missing backend evidence`);
  }
  const failed = requireLiveNumberField(
    rec,
    ['failed', 'fail_count', 'failed_count'],
    `Route plan constraint validation check ${index + 1} missing failed count`,
  );
  const passed = requireLiveNumberField(
    rec,
    ['passed', 'pass_count', 'passed_count'],
    `Route plan constraint validation check ${index + 1} missing passed count`,
  );
  return {
    name: requireLiveStringField(
      rec,
      ['name', 'check_name', 'code'],
      `Route plan constraint validation check ${index + 1} missing name`,
    ),
    passed,
    failed,
    status: routePlanConstraintStatus(rec.status, failed),
    detail: asNonEmptyString(rec.detail) ?? asNonEmptyString(rec.message) ?? undefined,
  };
}

function normalizeCanonicalRoutePlanConstraintItems(rec: Record<string, unknown>): RoutePlanConstraintCheck[] {
  if (typeof rec.valid !== 'boolean') {
    throw new Error('Route plan constraint validation did not return valid flag');
  }
  if (!Array.isArray(rec.violations)) {
    throw new Error('Route plan constraint validation did not return constraint check evidence');
  }
  if (rec.violations.length === 0) {
    if (rec.valid !== true) {
      throw new Error('Route plan constraint validation did not return violation evidence');
    }
    return [{
      name: rec.enabled === false ? 'route_plan_constraint_policy_disabled' : 'route_plan_constraints',
      passed: 1,
      failed: 0,
      status: 'pass',
    }];
  }
  return rec.violations.map((value, index) => {
    const violation = objectRecord(value);
    if (!Object.keys(violation).length) {
      throw new Error(`Route plan constraint validation violation ${index + 1} missing backend evidence`);
    }
    return {
      name: asNonEmptyString(violation.code) ?? `constraint_violation_${index + 1}`,
      passed: 0,
      failed: 1,
      status: routePlanConstraintStatus(violation.status, 1),
      detail: asNonEmptyString(violation.message) ?? asNonEmptyString(violation.detail) ?? undefined,
    };
  });
}

export async function route_plan_validate_constraints_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; fail_count: number; items: RoutePlanConstraintCheck[] }> {
  const live = await liveRpc<Record<string, unknown>>('route_plan_validate_constraints_v1', {
    p_route_plan_id: planId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'route_plan_validate_constraints_v1 returned no backend validation outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'route_plan_validate_constraints_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const routePlanId = requireLiveStringField(
      rec,
      ['route_plan_id', 'plan_id'],
      'Route plan constraint validation did not return route_plan_id',
    );
    if (routePlanId !== planId) {
      throw new Error('Route plan constraint validation returned a different route_plan_id');
    }
    requireLiveEvidence(
      rec,
      ['items', 'checks', 'validated_at', 'settings_id', 'settings_version_id', 'policy_version'],
      'route_plan_validate_constraints_v1 did not return backend validation evidence',
    );
    const directItems = Array.isArray(rec.items)
      ? rec.items
      : Array.isArray(rec.checks)
        ? rec.checks
        : [];
    const items = directItems.length > 0
      ? directItems.map(normalizeRoutePlanConstraintItem)
      : normalizeCanonicalRoutePlanConstraintItems(rec);
    if (items.length === 0) {
      throw new Error('Route plan constraint validation did not return constraint check evidence');
    }
    const failCount = Number.isFinite(Number(rec.fail_count))
      ? Number(rec.fail_count)
      : items.reduce((acc, item) => acc + Number(item.failed ?? 0), 0);
    return {
      ok: true,
      plan_id: routePlanId,
      fail_count: failCount,
      items,
    };
  }

  await sleep(120);
  const items: RoutePlanConstraintCheck[] = [
    { name: 'Driver capabilities', passed: 5, failed: 0, status: 'pass' },
    { name: 'Vehicle type fit', passed: 5, failed: 0, status: 'pass' },
    {
      name: 'Vehicle metadata (refrig / hazmat)',
      passed: 4,
      failed: 1,
      status: 'warn',
      detail: 'plan stop 18 requires refrig vehicle but assigned vehicle has no refrig metadata',
    },
    { name: 'Working-hours window', passed: 5, failed: 0, status: 'pass' },
    { name: 'Stop time-windows', passed: 5, failed: 0, status: 'pass' },
    { name: 'Hub cutoff', passed: 5, failed: 0, status: 'pass' },
  ];
  const fail_count = items.reduce((acc, c) => acc + c.failed, 0);
  return { ok: true, plan_id: planId, fail_count, items };
}

function responseStatusForRouteRunAssignmentAction(actionKey: string): string {
  switch (actionKey) {
    case 'route_runs.acknowledge_assignment':
      return 'acknowledged';
    case 'route_runs.accept_assignment':
      return 'accepted';
    case 'route_runs.refuse_assignment':
      return 'refused';
    default:
      return 'assigned';
  }
}

export async function ui_execute_route_run_assign_v1(
  runId: string,
  target: RouteRunAssignTarget | unknown,
): Promise<{ ok: true; run_id: string; target: RouteRunAssignTarget | unknown }> {
  const live = await liveRpc<Record<string, unknown>>('ui_execute_route_run_assign_v1', {
    p_action_key: 'route_runs.assign',
    p_resource_key: 'route_runs',
    p_selection_ids: [runId],
    p_selection_id: runId,
    p_selection_count: 1,
    p_params: target && typeof target === 'object' ? target as Record<string, unknown> : { target },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_route_run_assign_v1', [
      'route_run_id',
      'run_id',
      'assignment_id',
      'route_run_assignment_id',
      'count',
      'status',
    ]);
    const resolvedRunId = String(rec.route_run_id ?? rec.run_id ?? runId);
    await requireLiveRouteRunAssignmentReadback('ui_execute_route_run_assign_v1', resolvedRunId, rec);
    return { ...rec, ok: true, run_id: String(rec.route_run_id ?? rec.run_id ?? runId), target } as {
      ok: true;
      run_id: string;
      target: RouteRunAssignTarget | unknown;
    };
  }

  await sleep(80);
  return { ok: true, run_id: runId, target };
}

export async function ui_execute_route_run_assignment_response_v1(
  runId: string,
  actionKey: string,
  params: RouteRunAssignmentResponseParams = {},
): Promise<RouteRunAssignmentResponseResult> {
  const responseStatus = responseStatusForRouteRunAssignmentAction(actionKey);
  const live = await liveRpc<Record<string, unknown>>('ui_execute_route_run_assignment_response_v1', {
    p_action_key: actionKey,
    p_resource_key: 'routes',
    p_selection_ids: [runId],
    p_selection_id: runId,
    p_selection_count: 1,
    p_params: compactRecord({
      ...params,
      response_status: responseStatus,
    }),
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_route_run_assignment_response_v1', [
      'status',
      'items',
      'count',
    ]);
    const items = Array.isArray(rec.items) ? rec.items : [];
    const item = objectRecord(items[0]);
    const resolvedRunId = asNonEmptyString(item.route_run_id) ?? asNonEmptyString(rec.route_run_id) ?? runId;
    const assignmentStatus =
      asNonEmptyString(item.assignment_status) ??
      asNonEmptyString(rec.assignment_status) ??
      asNonEmptyString(rec.status) ??
      responseStatus;
    const assignmentId =
      asNonEmptyString(item.route_run_assignment_id) ??
      asNonEmptyString(rec.route_run_assignment_id) ??
      asNonEmptyString(rec.assignment_id);
    await requireLiveRouteRunAssignmentReadback(
      'ui_execute_route_run_assignment_response_v1',
      resolvedRunId,
      { ...rec, ...item, route_run_assignment_id: assignmentId },
    );
    const assignment = assignmentId
      ? await requireLiveResourceReadback(
          'route_run_assignments',
          assignmentId,
          'ui_execute_route_run_assignment_response_v1',
        )
      : (await requireLiveResourceListReadback(
          'route_run_assignments',
          { route_run_id: resolvedRunId },
          'ui_execute_route_run_assignment_response_v1',
        ))[0];
    if (assignment && asNonEmptyString(assignment.assignment_status) !== assignmentStatus) {
      throw new Error('ui_execute_route_run_assignment_response_v1 backend readback assignment_status mismatch');
    }
    return {
      ...rec,
      ...item,
      ok: true,
      run_id: resolvedRunId,
      route_run_id: resolvedRunId,
      route_run_assignment_id: assignmentId ?? undefined,
      assignment_status: assignmentStatus,
      assignment_version: Number(item.assignment_version ?? rec.assignment_version) || undefined,
      responded_by_user_id: asNonEmptyString(item.responded_by_user_id) ?? null,
      acknowledged_at: asNonEmptyString(item.acknowledged_at) ?? null,
      accepted_at: asNonEmptyString(item.accepted_at) ?? null,
      refused_at: asNonEmptyString(item.refused_at) ?? null,
      refusal_reason: asNonEmptyString(item.refusal_reason) ?? null,
      response_notes: asNonEmptyString(item.response_notes) ?? null,
      created: typeof item.created === 'boolean' ? item.created : undefined,
    };
  }

  await sleep(80);
  return {
    ok: true,
    run_id: runId,
    route_run_id: runId,
    assignment_status: responseStatus,
  };
}

export async function ui_execute_route_stop_reassign_v1(
  stopIds: string[],
  target: RouteStopReassignTarget | unknown,
): Promise<{ ok: true; count: number; target: RouteStopReassignTarget | unknown; assignment_status: string }> {
  const live = await liveRpc<Record<string, unknown>>('ui_execute_route_stop_reassign_v1', {
    p_action_key: 'route_stops.reassign',
    p_resource_key: 'route_stops',
    p_selection_ids: stopIds,
    p_selection_id: stopIds.length === 1 ? stopIds[0] : null,
    p_selection_count: stopIds.length,
    p_params: target && typeof target === 'object' ? target as Record<string, unknown> : { target },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_route_stop_reassign_v1', [
      'route_stop_reassignment_event_id',
      'route_run_assignment_id',
      'assignment_id',
      'count',
      'success_count',
      'affected_count',
      'status',
    ]);
    const count = requireLiveNumberField(
      rec,
      ['count', 'success_count', 'affected_count'],
      'Route stop reassignment did not return affected count',
    );
    const targetRecord = target && typeof target === 'object' ? target as Record<string, unknown> : {};
    const targetRouteRunId = asNonEmptyString(targetRecord.target_route_run_id);
    for (const stopId of stopIds) {
      const stop = await requireLiveResourceReadback('route_stops', stopId, 'ui_execute_route_stop_reassign_v1');
      if (targetRouteRunId && asNonEmptyString(stop.route_run_id) !== targetRouteRunId) {
        throw new Error('ui_execute_route_stop_reassign_v1 backend readback route_stop target route_run_id did not match');
      }
    }
    const assignmentId = asNonEmptyString(rec.route_run_assignment_id) ?? asNonEmptyString(rec.assignment_id);
    if (assignmentId) {
      await requireLiveResourceReadback('route_run_assignments', assignmentId, 'ui_execute_route_stop_reassign_v1');
    } else if (targetRouteRunId) {
      await requireLiveResourceListReadback(
        'route_run_assignments',
        { route_run_id: targetRouteRunId },
        'ui_execute_route_stop_reassign_v1',
      );
    }
    const eventId =
      asNonEmptyString(rec.route_stop_reassignment_event_id) ??
      asNonEmptyString(rec.reassignment_event_id) ??
      asNonEmptyString(rec.event_id);
    if (eventId) {
      await requireLiveResourceReadback('route_stop_reassignment_events', eventId, 'ui_execute_route_stop_reassign_v1');
    } else {
      for (const stopId of stopIds) {
        await requireLiveResourceListReadback(
          'route_stop_reassignment_events',
          { route_stop_id: stopId },
          'ui_execute_route_stop_reassign_v1',
        );
      }
    }
    return {
      ...rec,
      ok: true,
      count,
      target,
      assignment_status: String(rec.assignment_status ?? rec.status),
    } as { ok: true; count: number; target: RouteStopReassignTarget | unknown; assignment_status: string };
  }

  await sleep(80);
  return { ok: true, count: stopIds.length, target, assignment_status: 'reassigned' };
}

export async function ui_confirm_route_run_departure_v1(
  runId: string,
): Promise<{ ok: true; departure_confirmed_at: string; run_id: string }> {
  const live = await liveRpc<Record<string, unknown>>('ui_confirm_route_run_departure_v1', {
    p_input: { route_run_id: runId },
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Departure confirmation returned no backend outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'Departure confirmation was rejected by the backend');
    if (outcomeError) throw outcomeError;
    if (String(rec.status ?? '').trim().toLowerCase() === 'route_departure_blocked') {
      const rawError = objectRecord(rec.error);
      const message =
        asNonEmptyString(rawError.message) ??
        asNonEmptyString(rec.message) ??
        asNonEmptyString(rawError.code) ??
        'Departure confirmation was blocked by scan-out reconciliation';
      throw new Error(message);
    }
    const routeRunId = String(rec.route_run_id ?? rec.run_id ?? runId);
    const routeRun = await requireLiveResourceReadback('route_runs', routeRunId, 'ui_confirm_route_run_departure_v1');
    const metadata = objectRecord(routeRun.metadata);
    const rpcDeparture = objectRecord(rec.route_departure);
    const routeRunDeparture = objectRecord(routeRun.route_departure);
    const metadataRouteDeparture = objectRecord(metadata.route_departure);
    const readbackConfirmedAt =
      asNonEmptyString(routeRunDeparture.confirmed_at) ??
      asNonEmptyString(metadataRouteDeparture.confirmed_at);
    if (!readbackConfirmedAt) {
      throw new Error('ui_confirm_route_run_departure_v1 backend readback missing route_runs departure confirmation');
    }
    const confirmedAt =
      asNonEmptyString(rpcDeparture.confirmed_at) ??
      asNonEmptyString(rec.departure_confirmed_at) ??
      asNonEmptyString(rec.confirmed_at) ??
      readbackConfirmedAt;
    return {
      ...rec,
      ok: true,
      departure_confirmed_at: confirmedAt,
      run_id: routeRunId,
    } as { ok: true; departure_confirmed_at: string; run_id: string };
  }

  await sleep(120);
  return { ok: true, departure_confirmed_at: new Date().toISOString(), run_id: runId };
}

export async function route_run_scan_out_reconciliation_v1(
  runId: string,
): Promise<{ ok: true; expected: number; scanned: number; discrepancies: string[]; run_id: string }> {
  const live = await liveRpc<Record<string, unknown>>('route_run_scan_out_reconciliation_v1', {
    p_route_run_id: runId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Scan-out reconciliation returned no backend outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'Scan-out reconciliation was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const expected = requireLiveNumberField(
      rec,
      ['expected', 'expected_count', 'expected_stop_count', 'expected_shipment_count'],
      'Scan-out reconciliation did not return an expected count',
    );
    const scanned = requireLiveNumberField(
      rec,
      ['scanned', 'scanned_count', 'scanned_stop_count', 'scanned_shipment_count'],
      'Scan-out reconciliation did not return a scanned count',
    );
    const rawDiscrepancies = Array.isArray(rec.discrepancies) ? rec.discrepancies.map(String) : [];
    const missingCount = Number(rec.missing_stop_count ?? rec.missing_shipment_count ?? 0);
    const unexpectedCount = Number(rec.unexpected_scan_count ?? 0);
    const duplicateCount = Number(rec.duplicate_scan_count ?? 0);
    const synthesizedDiscrepancies = [
      ...rawDiscrepancies,
      ...(missingCount > 0 ? [`Missing ${missingCount} route load scan${missingCount === 1 ? '' : 's'}`] : []),
      ...(unexpectedCount > 0 ? [`Unexpected ${unexpectedCount} route load scan${unexpectedCount === 1 ? '' : 's'}`] : []),
      ...(duplicateCount > 0 ? [`Duplicate ${duplicateCount} route load scan${duplicateCount === 1 ? '' : 's'}`] : []),
    ];
    if (rec.ready_for_departure === false && synthesizedDiscrepancies.length === 0) {
      synthesizedDiscrepancies.push('Route load scan-out is not ready for departure');
    }
    const routeRunId = String(rec.route_run_id ?? rec.run_id ?? runId);
    await requireLiveResourceReadback('route_runs', routeRunId, 'route_run_scan_out_reconciliation_v1');
    if (expected > 0) {
      await requireLiveResourceListReadback(
        'route_stops',
        { route_run_id: routeRunId },
        'route_run_scan_out_reconciliation_v1',
      );
    }
    return {
      ...rec,
      ok: true,
      expected,
      scanned,
      discrepancies: synthesizedDiscrepancies,
      run_id: routeRunId,
    } as { ok: true; expected: number; scanned: number; discrepancies: string[]; run_id: string };
  }

  await sleep(80);
  return { ok: true, expected: 22, scanned: 22, discrepancies: [], run_id: runId };
}

// ----------- Pickups -----------
function pickupFilter(filter?: unknown): Record<string, unknown> {
  const rec = objectRecord(filter);
  const nested = objectRecord(rec.filter ?? rec.filters ?? rec);
  if (rec.filter == null && rec.filters == null) return nested;
  return {
    ...nested,
    limit: rec.limit ?? nested.limit,
    page_size: rec.page_size ?? nested.page_size,
    pageSize: rec.pageSize ?? nested.pageSize,
    page: rec.page ?? nested.page,
    offset: rec.offset ?? nested.offset,
    p_offset: rec.p_offset ?? nested.p_offset,
  };
}

function pickupLimit(filter: Record<string, unknown>): number {
  const raw = filter.limit ?? filter.page_size ?? filter.pageSize;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 100;
}

function pickupOffset(filter: Record<string, unknown>, limit: number): number {
  const raw = filter.offset ?? filter.p_offset;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const rawPage = filter.page;
  const page = typeof rawPage === 'number' ? rawPage : Number(rawPage);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) * limit : 0;
}

function pickupHasExplicitPagination(filter: Record<string, unknown>): boolean {
  return (
    filter.limit != null ||
    filter.page_size != null ||
    filter.pageSize != null ||
    filter.page != null ||
    filter.offset != null ||
    filter.p_offset != null
  );
}

function pickupUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return values.length ? values : null;
}

function normalizePickupRows(data: unknown, idKey: string): Record<string, unknown>[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(objectRecord(data).rows)
      ? objectRecord(data).rows as unknown[]
      : [];
  return rows.map((row) => {
    const rec = objectRecord(row);
    const id = rec.id ?? rec[idKey];
    return id == null ? rec : { id: String(id), ...rec };
  });
}

async function requireLivePickupWaveReadback(
  routeRunId: string,
  rpcName: string,
  expectedDriverUserId?: string | null,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>[] | { rows?: Record<string, unknown>[] }>(
    'pickup_waves_list_v1',
    {
      p_route_run_ids: [routeRunId],
      p_status: null,
      p_limit: 1,
      p_offset: 0,
    },
  );
  if (!live) throw new Error(`${rpcName} pickup-wave readback requires a live backend`);
  const row = normalizePickupRows(live.data, 'route_run_id')
    .find((candidate) => {
      const id =
        asNonEmptyString(candidate.route_run_id) ??
        asNonEmptyString(candidate.id);
      return id === routeRunId;
    });
  if (!row) {
    throw new Error(`${rpcName} backend readback missing pickup wave:${routeRunId}`);
  }
  if (expectedDriverUserId) {
    const readbackDriverUserId = asNonEmptyString(row.driver_user_id);
    if (readbackDriverUserId !== expectedDriverUserId) {
      throw new Error(`${rpcName} backend readback did not persist pickup driver assignment`);
    }
    const assignments = await requireLiveResourceListReadback(
      'route_run_assignments',
      { route_run_id: routeRunId },
      rpcName,
    );
    const activeAssignment = assignments.find((assignment) =>
      !['cancelled', 'canceled', 'completed'].includes(String(assignment.assignment_status ?? '').toLowerCase()),
    );
    if (asNonEmptyString(activeAssignment?.driver_user_id) !== expectedDriverUserId) {
      throw new Error(`${rpcName} backend readback did not persist Dispatch route assignment`);
    }
    await requireLiveResourceListReadback('route_run_assignment_events', { route_run_id: routeRunId }, rpcName);
    const stops = await requireLiveResourceListReadback('route_stops', { route_run_id: routeRunId }, rpcName);
    for (const stop of stops) {
      const stopId = asNonEmptyString(stop.id);
      if (!stopId) continue;
      const tasks = await requireLiveResourceListReadback(
        'tasks',
        {
          task_type_key: 'route_stop_execute',
          resource_type: 'route_stop',
          resource_id: stopId,
        },
        rpcName,
      );
      if (!tasks.some((task) =>
        asNonEmptyString(task.task_type_key ?? task.task_type) === 'route_stop_execute'
        && asNonEmptyString(task.assigned_to) === expectedDriverUserId,
      )) {
        throw new Error(`${rpcName} backend readback did not assign Dispatch route-stop task ${stopId}`);
      }
    }
  }
  return row;
}

async function livePickupRows(
  rpcName: string,
  args: Record<string, unknown>,
  idKey: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>[] | null> {
  const limit = pickupLimit(params);
  const firstOffset = pickupOffset(params, limit);
  const explicitPagination = pickupHasExplicitPagination(params);
  const rows: Record<string, unknown>[] = [];

  for (let offset = firstOffset; ; offset += limit) {
    const live = await liveRpc<Record<string, unknown>[] | { rows?: Record<string, unknown>[] }>(
      rpcName,
      {
        ...args,
        p_limit: limit,
        p_offset: offset,
      },
    );
    if (!live) return null;
    const pageRows = normalizePickupRows(live.data, idKey);
    rows.push(...pageRows);
    if (explicitPagination || pageRows.length < limit || pageRows.length === 0) break;
  }

  return rows;
}

export async function pickup_requests_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const params = pickupFilter(filter);
  const rows = await livePickupRows(
    'pickup_requests_list_v1',
    {
      p_client_id: asNonEmptyString(params.client_id) ?? null,
      p_sender_id: asNonEmptyString(params.sender_id) ?? null,
      p_status: asNonEmptyString(params.status) ?? null,
    },
    'shipment_id',
    params,
  );
  if (rows) {
    return { rows, total: rows.length };
  }

  await sleep(40);
  return { rows: pickupRequestsSeed(), total: 14 };
}

export async function pickup_waves_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const params = pickupFilter(filter);
  const rows = await livePickupRows(
    'pickup_waves_list_v1',
    {
      p_route_run_ids: pickupUuidArray(params.route_run_ids ?? params.routeRunIds ?? params.ids),
      p_status: asNonEmptyString(params.status) ?? null,
    },
    'route_run_id',
    params,
  );
  if (rows) {
    return { rows, total: rows.length };
  }

  await sleep(40);
  return { rows: pickupWavesSeed(), total: 6 };
}

export async function pickup_failures_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const params = pickupFilter(filter);
  const rows = await livePickupRows(
    'pickup_failures_list_v1',
    {
      p_shipment_ids: pickupUuidArray(params.shipment_ids ?? params.shipmentIds ?? params.ids),
      p_client_id: asNonEmptyString(params.client_id) ?? null,
      p_sender_id: asNonEmptyString(params.sender_id) ?? null,
      p_status: asNonEmptyString(params.status) ?? null,
    },
    'shipment_id',
    params,
  );
  if (rows) {
    return { rows, total: rows.length };
  }

  await sleep(40);
  return { rows: pickupFailuresSeed(), total: 3 };
}

async function requireLivePickupRequestReadback(
  shipmentId: string,
  rpcName: string,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>[] | { rows?: Record<string, unknown>[] }>(
    'pickup_requests_list_v1',
    {
      p_client_id: null,
      p_sender_id: null,
      p_status: null,
      p_limit: 100,
      p_offset: 0,
    },
  );
  if (!live) throw new Error(`${rpcName} pickup-request readback requires a live backend`);
  const row = normalizePickupRows(live.data, 'shipment_id')
    .find((candidate) => {
      const id =
        asNonEmptyString(candidate.shipment_id) ??
        asNonEmptyString(candidate.id);
      return id === shipmentId;
    });
  if (!row) {
    throw new Error(`${rpcName} backend readback missing pickup request:${shipmentId}`);
  }
  return row;
}

export async function create_pickup_request_v1(payload: unknown): Promise<{
  ok: true;
  shipment_id: string;
  tracking_number?: string;
  created?: boolean;
  operation?: string;
  [key: string]: unknown;
}> {
  const live = await liveRpc<Record<string, unknown>>('create_pickup_request_v1', {
    p_input: objectRecord(payload),
  });
  if (live) {
    const rec = (live.data ?? {}) as Record<string, unknown>;
    if (rec.ok === false) {
      const error = objectRecord(rec.error);
      throw new Error(String(error.message ?? error.code ?? 'create_pickup_request_v1 failed'));
    }
    const shipmentId = asNonEmptyString(rec.shipment_id);
    if (!shipmentId) throw new Error('create_pickup_request_v1 response missing shipment_id');
    await requireLivePickupRequestReadback(shipmentId, 'create_pickup_request_v1');
    return {
      ok: true,
      shipment_id: shipmentId,
      ...rec,
    };
  }

  await sleep(120);
  return {
    ok: true,
    shipment_id: 'shp_pickup_' + Date.now(),
    tracking_number: 'PICKUP-SEED-' + Date.now(),
    created: true,
    operation: 'created',
  };
}

export async function create_pickup_wave_v1(payload: unknown): Promise<{ ok: true; wave_id: string }> {
  const live = await liveRpc<Record<string, unknown>>('create_pickup_wave_v1', {
    p_input: objectRecord(payload),
  });
  if (live) {
    const rec = (live.data ?? {}) as Record<string, unknown>;
    if (rec.ok === false) {
      const error = objectRecord(rec.error);
      throw new Error(String(error.message ?? error.code ?? 'create_pickup_wave_v1 failed'));
    }
    const waveId = asNonEmptyString(rec.wave_id ?? rec.route_run_id);
    if (!waveId) throw new Error('create_pickup_wave_v1 response missing route_run_id');
    await requireLivePickupWaveReadback(waveId, 'create_pickup_wave_v1');
    return {
      ok: true,
      wave_id: waveId,
      ...rec,
    } as { ok: true; wave_id: string };
  }

  await sleep(120);
  return { ok: true, wave_id: 'pwv_' + Date.now() };
}

export async function assign_pickup_wave_v1(
  waveId: string,
  target: unknown,
): Promise<{ ok: true; wave_id: string; target: unknown }> {
  const targetRecord = objectRecord(target);
  const routeRunId = asNonEmptyString(targetRecord.route_run_id) ?? waveId;
  const driverTargetId = asNonEmptyString(targetRecord.driver_user_id) ?? 'partner';
  const inputRecord: Record<string, unknown> = {
    ...targetRecord,
    route_run_id: routeRunId,
    idempotency_key: asNonEmptyString(targetRecord.idempotency_key)
      ?? `console-v2:assign_pickup_wave_v1:${routeRunId}:${driverTargetId}`,
  };
  const live = await liveRpc<Record<string, unknown>>('assign_pickup_wave_v1', {
    p_input: inputRecord,
  });
  if (live) {
    const rec = (live.data ?? {}) as Record<string, unknown>;
    if (rec.ok === false) {
      const error = objectRecord(rec.error);
      throw new Error(String(error.message ?? error.code ?? 'assign_pickup_wave_v1 failed'));
    }
    const waveIdOut = asNonEmptyString(rec.wave_id ?? rec.route_run_id ?? waveId);
    if (!waveIdOut) throw new Error('assign_pickup_wave_v1 response missing route_run_id');
    await requireLivePickupWaveReadback(
      waveIdOut,
      'assign_pickup_wave_v1',
      asNonEmptyString(inputRecord.driver_user_id),
    );
    return {
      ok: true,
      wave_id: waveIdOut,
      target,
      ...rec,
    } as { ok: true; wave_id: string; target: unknown };
  }

  await sleep(80);
  return { ok: true, wave_id: waveId, target };
}

function dispatchResolutionString(resolution: unknown): string {
  if (typeof resolution === 'string' && resolution.trim()) return resolution.trim();
  const rec = objectRecord(resolution);
  return (
    asNonEmptyString(rec.resolution_action) ??
    asNonEmptyString(rec.ndr_action) ??
    asNonEmptyString(rec.resolution) ??
    'reschedule'
  );
}

function materializeDispatchResolutionArgs(
  taskId: string,
  resolution: unknown,
  opts: DispatchExceptionResolutionOpts,
): { dryRun: boolean; resolutionStr: string; canonical: DispatchExceptionResolutionCanonicalArgs } {
  const dryRun = !!opts.dryRun;
  const resolutionStr = dispatchResolutionString(resolution);
  const resolutionRec = objectRecord(resolution);
  const params = {
    ...objectRecord(opts.canonical?.params),
  };
  if (!asNonEmptyString(params.resolution_action ?? params.ndr_action)) {
    params.resolution_action = resolutionStr;
  }
  const notes = asNonEmptyString(resolutionRec.resolution_notes ?? resolutionRec.notes);
  if (notes && !asNonEmptyString(params.resolution_notes)) {
    params.resolution_notes = notes;
  }
  if (dryRun && params.dry_run === undefined) {
    params.dry_run = true;
  }

  return {
    dryRun,
    resolutionStr,
    canonical: {
      action_key: opts.canonical?.action_key ?? 'dispatch_exception_review.complete',
      resource_key: opts.canonical?.resource_key ?? 'dispatch_exception_review',
      selection_ids: opts.canonical?.selection_ids ?? [taskId],
      selection_id: opts.canonical?.selection_id ?? taskId,
      selection_count: opts.canonical?.selection_count ?? 1,
      params,
    },
  };
}

async function requireLiveDispatchExceptionResolutionReadback(
  result: DispatchExceptionResolutionResult,
  canonical: DispatchExceptionResolutionCanonicalArgs,
): Promise<void> {
  const resultRows = result.results.map((row) => objectRecord(row));
  const taskIds = new Set<string>();
  const taskEventIds = new Set<string>();
  const workflowRunIds = new Set<string>();
  const shipmentActionIds = new Set<string>();

  for (const id of [result.task_id, canonical.selection_id, ...canonical.selection_ids]) {
    const normalized = asNonEmptyString(id);
    if (normalized) taskIds.add(normalized);
  }

  for (const row of resultRows) {
    for (const key of ['task_id', 'id', 'downstream_task_id', 'manual_review_task_id', 'resolution_task_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) taskIds.add(normalized);
    }
    for (const key of ['task_event_id', 'downstream_task_event_id', 'resolution_task_event_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) taskEventIds.add(normalized);
    }
    for (const key of ['workflow_run_id', 'resolution_workflow_run_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) workflowRunIds.add(normalized);
    }
    for (const key of ['shipment_action_id', 'resolution_direct_shipment_action_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) shipmentActionIds.add(normalized);
    }
  }

  if (taskIds.size === 0) {
    throw new Error('ui_execute_dispatch_exception_resolution_v1 did not return task readback evidence');
  }

  await Promise.all([...taskIds].map((taskId) =>
    requireLiveResourceReadback('tasks', taskId, 'ui_execute_dispatch_exception_resolution_v1'),
  ));
  await Promise.all([...taskEventIds].map((taskEventId) =>
    requireLiveResourceReadback('task_events', taskEventId, 'ui_execute_dispatch_exception_resolution_v1'),
  ));
  await Promise.all([...workflowRunIds].flatMap((workflowRunId) => [
    requireLiveResourceReadback('workflow_runs', workflowRunId, 'ui_execute_dispatch_exception_resolution_v1'),
    requireLiveResourceListReadback(
      'workflow_run_steps',
      { workflow_run_id: workflowRunId },
      'ui_execute_dispatch_exception_resolution_v1',
    ),
  ]));
  await Promise.all([...shipmentActionIds].map((shipmentActionId) =>
    requireLiveResourceReadback('shipment_actions', shipmentActionId, 'ui_execute_dispatch_exception_resolution_v1'),
  ));
}

function normalizeScanEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const rec = objectRecord(payload);
  const scanType = asNonEmptyString(rec.scan_type) ?? 'scan';
  const metadataIn = objectRecord(rec.metadata);
  const barcode =
    asNonEmptyString(rec.barcode) ??
    asNonEmptyString(rec.tracking_number) ??
    asNonEmptyString(rec.trackingNumber) ??
    asNonEmptyString(rec.handling_unit_code) ??
    asNonEmptyString(rec.warehouse_transfer_code) ??
    asNonEmptyString(rec.shipment_id);
  const link =
    asNonEmptyString(rec.route_stop_id) ??
    asNonEmptyString(rec.warehouse_transfer_id) ??
    asNonEmptyString(rec.shipment_id) ??
    asNonEmptyString(rec.handling_unit_id);
  return {
    ...rec,
    scan_type: scanType,
    ...(barcode ? { barcode } : {}),
    metadata: {
      ...metadataIn,
      ...(rec.tracking_number && !metadataIn.tracking_number ? { tracking_number: rec.tracking_number } : {}),
    },
    idempotency_key:
      asNonEmptyString(rec.idempotency_key) ??
      ['console-v2', scanType, barcode ?? 'unbound', link ?? ''].filter(Boolean).join(':'),
  };
}

function dispatchScanNeedsConsoleDevice(input: Record<string, unknown>): boolean {
  if (asNonEmptyString(input.device_id)) return false;
  const metadata = objectRecord(input.metadata);
  return (
    String(input.scan_type ?? '').trim().toLowerCase() === 'load' &&
    asNonEmptyString(metadata.source) === 'console_v2_dispatch'
  );
}

function readOrCreateDispatchScanDeviceSeed(): string {
  const existing = (() => {
    try {
      return globalThis.localStorage?.getItem(CONSOLE_DISPATCH_SCAN_DEVICE_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  })();
  if (existing.trim()) return existing.trim();

  const generated =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `console-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    globalThis.localStorage?.setItem(CONSOLE_DISPATCH_SCAN_DEVICE_STORAGE_KEY, generated);
  } catch {
    // Non-browser test runtimes can still register a per-call device identifier.
  }
  return generated;
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof globalThis.TextEncoder !== 'function') return input;
  const bytes = new TextEncoder().encode(input);
  const hash = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function attachConsoleDispatchScanDevice(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!dispatchScanNeedsConsoleDevice(input)) return input;

  const origin = (() => {
    try {
      return globalThis.location?.origin ?? 'console-v2';
    } catch {
      return 'console-v2';
    }
  })();
  const identifier = await sha256Hex(`${origin}:${readOrCreateDispatchScanDeviceSeed()}`);
  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>('register_user_device_v1', {
    p_device: {
      device_platform: 'web',
      device_identifier_sha256: identifier,
      device_label: translateAdapterMessage('adapter.dispatchScanner', 'en'),
      metadata: {
        source: 'console_v2_dispatch',
        surface: 'dispatch_scan_out',
      },
    },
  });
  if (!live) return input;

  const row = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
  const deviceId = asNonEmptyString(row.device_id);
  if (!deviceId) {
    throw new Error('register_user_device_v1 did not return device_id for Dispatch scan');
  }
  return { ...input, device_id: deviceId };
}

export async function ui_execute_dispatch_exception_resolution_v1(
  taskId: string,
  resolution: unknown,
  opts: DispatchExceptionResolutionOpts = {},
): Promise<{
  ok: true;
  task_id: string;
  resolution: unknown;
  dry_run: boolean;
  canonical_entrypoint: string;
  canonical_args: DispatchExceptionResolutionCanonicalArgs;
  policy: string;
  settings_resolution_id: string;
  apply_status: 'preview' | 'completed' | 'scheduled' | 'pending_review' | 'blocked' | 'mixed';
  results: Array<{ task_id: string; outcome: string; [k: string]: unknown }>;
}> {
  const { dryRun, canonical } = materializeDispatchResolutionArgs(taskId, resolution, opts);
  const live = await liveRpc<Record<string, unknown>>(
    dryRun ? 'preview_dispatch_exception_resolution_v1' : 'ui_execute_dispatch_exception_resolution_v1',
    {
      p_action_key: canonical.action_key,
      p_resource_key: canonical.resource_key,
      p_selection_ids: canonical.selection_ids,
      p_selection_id: canonical.selection_id,
      p_selection_count: canonical.selection_count,
      p_params: canonical.params,
    },
  );
  if (live) {
    const result = normalizeDispatchResolutionLiveResult(live.data, taskId, resolution, dryRun, canonical);
    if (!dryRun) {
      await requireLiveDispatchExceptionResolutionReadback(result, canonical);
    }
    return result;
  }

  await sleep(120);
  return {
    ok: true,
    task_id: taskId,
    resolution,
    dry_run: dryRun,
    canonical_entrypoint: 'public.ui_execute_dispatch_exception_resolution_v1',
    canonical_args: canonical,
    policy: 'ndr_policy',
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
    apply_status: dryRun ? 'preview' : 'completed',
    results: [{ task_id: taskId, outcome: 'ok' }],
  };
}

export async function ui_request_warehouse_scan_correction_v1(
  args: WarehouseScanCorrectionRequestArgs,
): Promise<Record<string, unknown>> {
  const scanEventId = String(args.scan_event_id ?? '').trim();
  const correctionReason = String(args.correction_reason ?? '').trim();
  const correctedBarcode = String(args.corrected_barcode ?? '').trim();
  if (!scanEventId) throw new Error('ui_request_warehouse_scan_correction_v1 requires scan_event_id');
  if (!correctionReason) throw new Error('ui_request_warehouse_scan_correction_v1 requires correction_reason');
  if (!correctedBarcode) throw new Error('ui_request_warehouse_scan_correction_v1 requires corrected_barcode');

  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>(
    'ui_request_warehouse_scan_correction_v1',
    {
      p_scan_event_id: scanEventId,
      p_correction_reason: correctionReason,
      p_corrected_barcode: correctedBarcode,
      p_params: args.metadata ?? {},
    },
  );
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) {
      throw new Error('ui_request_warehouse_scan_correction_v1 backend readback missing task_id');
    }
    await ui_get_resource_v1<Record<string, unknown>>('tasks', taskId);
    return row;
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('ui_request_warehouse_scan_correction_v1');
  await sleep(70);
  const taskId = `tsk_scan_corr_${Date.now()}`;
  const scans = seed.warehouse_checkpoint_scans as Array<Record<string, unknown>>;
  const scan = scans.find((row) => row.id === scanEventId);
  const tasks = seed.tasks as Array<Record<string, unknown>>;
  tasks.push({
    id: taskId,
    task_id: taskId.toUpperCase(),
    task_type: 'warehouse_scan_supervisor_approval',
    task_type_key: 'warehouse_scan_supervisor_approval',
    subject: `Scan correction · ${String(scan?.barcode ?? scan?.checkpoint ?? scanEventId)}`,
    resource_type: 'scan_event',
    resource_id: scanEventId,
    queue: 'warehouse',
    queue_key: 'warehouse',
    priority: 1,
    status: 'open',
    metadata: {
      subject: `Scan correction · ${String(scan?.barcode ?? scan?.checkpoint ?? scanEventId)}`,
      source: 'console_v2.warehouse.scan_correction_request',
      task_type_key: 'warehouse_scan_supervisor_approval',
      scan_correction: {
        original_scan_event_id: scanEventId,
        warehouse_transfer_id: scan?.transfer_id ?? null,
        corrected_barcode: correctedBarcode,
        correction_reason: correctionReason,
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return {
    status: 'requested',
    task_id: taskId,
    scan_event_id: scanEventId,
    warehouse_transfer_id: scan?.transfer_id ?? null,
    corrected_barcode: correctedBarcode,
    correction_reason: correctionReason,
  };
}

export async function record_scan_event_v1(
  payload: Record<string, unknown>,
): Promise<{ ok: true; scan_event_id: string; created?: boolean }> {
  const input = await attachConsoleDispatchScanDevice(normalizeScanEventPayload(payload));
  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>(
    'record_scan_event_v1',
    { p_scan: input },
  );
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    const liveOk = row.ok == null ? true : Boolean(row.ok);
    if (!liveOk) {
      throw new Error(String(row.error ?? row.message ?? 'record_scan_event_v1 failed'));
    }
    const scanEventId = String(row.scan_event_id ?? row.id ?? '').trim();
    if (!scanEventId) {
      throw new Error('record_scan_event_v1 did not return scan_event_id');
    }
    return {
      ...row,
      ok: true,
      scan_event_id: scanEventId,
      created: row.created == null ? true : Boolean(row.created),
    };
  }

  await sleep(60);
  const scanEventId = 'sce_' + Date.now();
  if (String(input.scan_type ?? '').toLowerCase() === 'correction') {
    const scans = seed.warehouse_checkpoint_scans as Array<Record<string, unknown>>;
    scans.push({
      id: scanEventId,
      transfer_id: input.warehouse_transfer_id ?? input.transfer_id ?? null,
      warehouse_transfer_id: input.warehouse_transfer_id ?? input.transfer_id ?? null,
      shipment_id: input.shipment_id ?? null,
      scan_type: 'correction',
      barcode: input.barcode,
      checkpoint: 'correction',
      sequence: null,
      occurred_at: new Date().toISOString(),
      correction_of_scan_event_id: input.correction_of_scan_event_id ?? null,
      correction_reason: input.correction_reason ?? null,
      correction_approval_task_id: input.correction_approval_task_id ?? null,
      metadata: input.metadata ?? {},
    });
  }
  return { ok: true, scan_event_id: scanEventId };
}

export async function resolve_ndr_branch_next_action_v1(
  args: NdrBranchNextActionArgs = {},
): Promise<string> {
  const client = getSupabaseClient();
  if (client) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `resolve_ndr_branch_next_action_v2` (migration
    // 202605020200_w44_rpc_v2_normalizations.sql). Envelope: { ok, action }.
    // The exported adapter signature is unchanged.
    const { data, error } = await client.rpc('resolve_ndr_branch_next_action_v2', {
      p_args: {
        organization_id: args.organization_id ?? null,
        client_id: args.client_id ?? null,
        sender_id: args.sender_id ?? null,
        service_type: args.service_type ?? null,
        dispatch_exception_reason: args.dispatch_exception_reason ?? null,
        resolution_action: args.resolution_action ?? null,
        task_type_key: args.task_type_key ?? null,
        shipment_action_type: args.shipment_action_type ?? null,
        review_status: args.review_status ?? null,
        allowed_ndr_actions: args.allowed_ndr_actions ?? null,
      },
    });
    if (error) throw new Error(error.message);
    const envelope = (data ?? null) as { ok?: boolean; action?: string } | null;
    return envelope?.action ?? 'hold';
  }
  // In-memory fallback: read ndr_policy from seed and project a
  // recommendation. Mirrors the canonical RPC's behavior (returns 'hold' if
  // org missing; reads ndr_policy.action_map; falls back to first
  // allowed_ndr_actions entry; final fallback 'reschedule').
  await sleep(40);
  if (!args.organization_id) return 'hold';
  const allowed = (args.allowed_ndr_actions ?? []) as string[];
  const reason = (args.dispatch_exception_reason ?? '').toLowerCase();
  // Heuristic mirrors the seeded `ndr_policy.action_map` shape.
  if (reason.includes('refused') || reason.includes('damaged')) return 'customer_pickup';
  if (reason.includes('address') || reason.includes('zone')) return 'reschedule';
  if (allowed.length > 0) return allowed[0]!;
  return 'reschedule';
}

export async function create_warehouse_transfer_manifest_v1(
  args: Record<string, unknown>,
): Promise<WarehouseTransferManifestCreateResult> {
  const live = await liveRpc<Record<string, unknown>>('create_warehouse_transfer_manifest_v1', {
    p_input: args,
  });
  if (live) {
    const envelope = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    const transferCode = asNonEmptyString(envelope.transfer_code ?? args.transfer_code) ?? '';
    return {
      ...envelope,
      ok: true,
      warehouse_transfer_id: String(
        envelope.warehouse_transfer_id ??
          envelope.transfer_id ??
          envelope.id ??
          nextResourceId('warehouse_transfer'),
      ),
      transfer_code: transferCode,
      created: envelope.created !== false,
      item_count: Number(
        envelope.item_count ??
          (Array.isArray(args.shipment_ids) ? args.shipment_ids.length : 0),
      ),
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('create_warehouse_transfer_manifest_v1');
  await sleep(80);
  const transferCode =
    asNonEmptyString(args.transfer_code) ?? `WTR-${Date.now().toString(36).toUpperCase()}`;
  return {
    ok: true,
    warehouse_transfer_id: nextResourceId('warehouse_transfer'),
    transfer_code: transferCode,
    created: true,
    item_count: Array.isArray(args.shipment_ids) ? args.shipment_ids.length : 0,
    correlation_id: nextCorrelationId(),
    settings_resolution_id: 'srlv_demo',
  };
}

// W35e-4 — Aligned to canonical jsonb envelope per
// supabase/migrations/202601261740_warehouse_transfer_reconcile_finalize_v1.sql.
// Live mode routes through the api-schema `transition_warehouse_transfer_v1`
// wrapper so browser clients stay on the exposed schema boundary. Envelope:
// { ok, warehouse_transfer_id, updated, status, dispatched_at, received_at }.
// In-memory seed mode keeps the legacy minimal stub shape so existing tests
// continue to assert on adapter input only (warehouse.test.tsx W35e-4 spies
// on the adapter call, not on its return shape).
export async function transition_warehouse_transfer_v1(
  args: { warehouse_transfer_id: string; to_status: string; [k: string]: unknown },
): Promise<{ ok: true; warehouse_transfer_id: string; to_status: string; [k: string]: unknown }> {
  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>(
    'transition_warehouse_transfer_v1',
    { p_input: args },
  );
  if (live) {
    const envelope = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    return {
      ok: true,
      warehouse_transfer_id: String(envelope.warehouse_transfer_id ?? args.warehouse_transfer_id),
      to_status: String(envelope.status ?? envelope.to_status ?? args.to_status),
      updated: envelope.updated ?? false,
      status: envelope.status ?? args.to_status,
      dispatched_at: envelope.dispatched_at ?? null,
      received_at: envelope.received_at ?? null,
    };
  }
  await sleep(80);
  return {
    ok: true,
    warehouse_transfer_id: args.warehouse_transfer_id,
    to_status: args.to_status,
  };
}

function warehouseTransferUiArgs(
  actionKey: string,
  warehouseTransferId: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    p_action_key: actionKey,
    p_resource_key: 'warehouse_transfers',
    p_selection_ids: [warehouseTransferId],
    p_selection_id: warehouseTransferId,
    p_selection_count: 1,
    p_params: params,
  };
}

function normalizeWarehouseTransferUiResult(
  data: unknown,
  actionKey: string,
  warehouseTransferId: string,
): WarehouseTransferUiActionResult {
  const rec = firstRpcRow<Record<string, unknown>>(data) ?? {};
  return {
    ...rec,
    ok: true,
    action_key: String(rec.action_key ?? actionKey),
    resource_key: String(rec.resource_key ?? 'warehouse_transfers'),
    warehouse_transfer_id: String(rec.warehouse_transfer_id ?? warehouseTransferId),
    count: Number(rec.count ?? 1),
  };
}

export async function ui_execute_warehouse_transfer_dispatch_v1(
  args: { warehouse_transfer_id: string; params?: Record<string, unknown> },
): Promise<WarehouseTransferUiActionResult> {
  const params = args.params ?? {};
  const actionKey = 'warehouse_transfers.dispatch';
  const live = await liveRpc<Record<string, unknown>>(
    'ui_execute_warehouse_transfer_dispatch_v1',
    warehouseTransferUiArgs(actionKey, args.warehouse_transfer_id, params),
  );
  if (live) return normalizeWarehouseTransferUiResult(live.data, actionKey, args.warehouse_transfer_id);

  await sleep(80);
  return {
    ok: true,
    action_key: actionKey,
    resource_key: 'warehouse_transfers',
    warehouse_transfer_id: args.warehouse_transfer_id,
    count: 1,
    status: 'workflow_started',
  };
}

export async function ui_execute_warehouse_transfer_checkpoint_v1(
  args: {
    action_key: 'warehouse_transfers.scan_departure' | 'warehouse_transfers.scan_arrival';
    warehouse_transfer_id: string;
    barcode: string;
    handling_unit_code?: string | null;
    device_id?: string | null;
    ops_session_id?: string | null;
    notes?: string | null;
  },
): Promise<WarehouseTransferUiActionResult> {
  const { action_key, warehouse_transfer_id, ...params } = args;
  const live = await liveRpc<Record<string, unknown>>(
    'ui_execute_warehouse_transfer_checkpoint_v1',
    warehouseTransferUiArgs(action_key, warehouse_transfer_id, params),
  );
  if (live) return normalizeWarehouseTransferUiResult(live.data, action_key, warehouse_transfer_id);

  await sleep(80);
  return {
    ok: true,
    action_key,
    resource_key: 'warehouse_transfers',
    warehouse_transfer_id,
    count: 1,
    scan_event_id: `sce_${Date.now()}`,
    scan_created: true,
  };
}

export async function ui_execute_warehouse_transfer_reconcile_v1(
  args: {
    warehouse_transfer_id: string;
    received_shipment_count: number;
    damaged_shipment_count?: number;
    missing_shipment_count?: number;
    unmanifested_shipment_count?: number;
    reconcile_notes?: string | null;
  },
): Promise<WarehouseTransferUiActionResult> {
  const { warehouse_transfer_id, ...params } = args;
  const actionKey = 'warehouse_transfers.reconcile_destination';
  const live = await liveRpc<Record<string, unknown>>(
    'ui_execute_warehouse_transfer_reconcile_v1',
    warehouseTransferUiArgs(actionKey, warehouse_transfer_id, params),
  );
  if (live) return normalizeWarehouseTransferUiResult(live.data, actionKey, warehouse_transfer_id);

  await sleep(80);
  return {
    ok: true,
    action_key: actionKey,
    resource_key: 'warehouse_transfers',
    warehouse_transfer_id,
    count: 1,
    status: 'task_completed',
  };
}
