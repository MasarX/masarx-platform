import {
  livePArgsMutationResult,
  type LookupDefinitionMutationResult,
  type LookupValueMutationResult,
  nextCorrelationIdHex,
  requireLiveStringField,
  seed,
  type ServiceLevelMutationResult,
  type ServiceOfferingMutationResult,
  sleep,
  state,
  withRequiredLiveStringField,
} from '../data-source';

export async function service_offering_create_v1(args: {
  service_level_id: string;
  branch_id?: string | null;
  zone_id?: string | null;
  priority?: number;
  metadata?: Record<string, unknown>;
}): Promise<ServiceOfferingMutationResult> {
  const live = await livePArgsMutationResult('service_offering_create_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_create_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_level_id) throw new Error('service_offering_create_v1 requires service_level_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown>>;
  const id = 'sof_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  offerings.unshift({
    id,
    service_level_id: args.service_level_id,
    branch_id: args.branch_id ?? null,
    zone_id: args.zone_id ?? null,
    priority: Math.max(args.priority ?? 0, 0),
    is_active: true,
    metadata: args.metadata ?? {},
    effective_from: now,
    effective_to: null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    service_offering_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_offering_update_v1(args: {
  service_offering_id: string;
  zone_id?: string | null;
  priority?: number;
  effective_from?: string;
  effective_to?: string | null;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
  price?: { base_price: number; currency: string };
}): Promise<ServiceOfferingMutationResult> {
  const live = await livePArgsMutationResult('service_offering_update_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_update_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_offering_id) throw new Error('service_offering_update_v1 requires service_offering_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = offerings.find((r) => r.id === args.service_offering_id);
  if (!row) throw new Error(`service_offering_update_v1 service_offering ${args.service_offering_id} not found`);
  if (args.zone_id !== undefined) row.zone_id = args.zone_id;
  if (args.priority !== undefined) row.priority = args.priority;
  if (args.effective_from !== undefined) row.effective_from = args.effective_from;
  if (args.effective_to !== undefined) row.effective_to = args.effective_to;
  if (args.is_active !== undefined) row.is_active = args.is_active;
  if (args.metadata !== undefined) {
    row.metadata = { ...((row.metadata as Record<string, unknown> | undefined) ?? {}), ...args.metadata };
  }
  if (args.price !== undefined) {
    row.metadata = { ...((row.metadata as Record<string, unknown> | undefined) ?? {}), ...args.price };
  }
  row.updated_at = new Date().toISOString();
  return {
    ok: true,
    service_offering_id: args.service_offering_id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_offering_archive_v1(args: {
  service_offering_id: string;
  reason?: string;
}): Promise<ServiceOfferingMutationResult> {
  const live = await livePArgsMutationResult('service_offering_archive_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_archive_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_offering_id) throw new Error('service_offering_archive_v1 requires service_offering_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown> & { id: string; is_active: boolean; metadata?: Record<string, unknown> }>;
  const row = offerings.find((r) => r.id === args.service_offering_id);
  if (!row) throw new Error(`service_offering_archive_v1 service_offering ${args.service_offering_id} not found`);
  const wasArchived = row.is_active === false;
  if (!wasArchived) {
    row.is_active = false;
    row.metadata = { ...(row.metadata ?? {}), retired_reason: args.reason ?? null };
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    service_offering_id: args.service_offering_id,
    idempotent_no_op: wasArchived,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_offering_toggle_v1(args: {
  service_offering_id: string;
  is_active?: boolean;
}): Promise<ServiceOfferingMutationResult> {
  const live = await livePArgsMutationResult('service_offering_toggle_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_toggle_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_offering_id) throw new Error('service_offering_toggle_v1 requires service_offering_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown> & { id: string; is_active: boolean }>;
  const row = offerings.find((r) => r.id === args.service_offering_id);
  if (!row) throw new Error(`service_offering_toggle_v1 service_offering ${args.service_offering_id} not found`);
  const target = args.is_active !== undefined ? args.is_active : !row.is_active;
  const idempotent = row.is_active === target;
  if (!idempotent) {
    row.is_active = target;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    service_offering_id: args.service_offering_id,
    idempotent_no_op: idempotent,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_level_create_v1(args: {
  key: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  organization_id?: string;
}): Promise<ServiceLevelMutationResult> {
  const live = await livePArgsMutationResult('service_level_create_v1', args, ['service_level_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceLevelMutationResult>(
      live,
      ['service_level_id', 'id'],
      'service_level_id',
      'service_level_create_v1 did not return service_level_id',
    );
  }
  await sleep(120);
  if (!args?.key || !args?.name) throw new Error('service_level_create_v1 requires key and name');
  const levels = (seed.service_levels ?? []) as Array<Record<string, unknown>>;
  const id = 'svl_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
  levels.unshift({
    id,
    organization_id: args.organization_id ?? scopeCtx.tenant?.id ?? null,
    key: args.key.toLowerCase(),
    name: args.name,
    description: args.description ?? null,
    is_active: true,
    metadata: args.metadata ?? {},
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    service_level_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_level_update_v1(args: {
  service_level_id: string;
  name?: string;
  description?: string;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<ServiceLevelMutationResult> {
  const live = await livePArgsMutationResult('service_level_update_v1', args, ['service_level_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceLevelMutationResult>(
      live,
      ['service_level_id', 'id'],
      'service_level_id',
      'service_level_update_v1 did not return service_level_id',
    );
  }
  await sleep(120);
  if (!args?.service_level_id) throw new Error('service_level_update_v1 requires service_level_id');
  const levels = (seed.service_levels ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = levels.find((r) => r.id === args.service_level_id);
  if (!row) throw new Error(`service_level_update_v1 service_level ${args.service_level_id} not found`);
  if (args.name !== undefined) row.name = args.name;
  if (args.description !== undefined) row.description = args.description;
  if (args.is_active !== undefined) row.is_active = args.is_active;
  if (args.metadata !== undefined) {
    row.metadata = { ...((row.metadata as Record<string, unknown> | undefined) ?? {}), ...args.metadata };
  }
  row.updated_at = new Date().toISOString();
  return {
    ok: true,
    service_level_id: args.service_level_id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_definition_create_v1(args: {
  category: string;
  description?: string;
  owner_role?: string;
  approval_policy?: string;
  is_mutable?: boolean;
  scope_type?: string;
  organization_id?: string;
}): Promise<LookupDefinitionMutationResult> {
  const live = await livePArgsMutationResult('lookup_definition_create_v1', args, ['lookup_definition_id', 'id']);
  if (live) {
    const rec = withRequiredLiveStringField<LookupDefinitionMutationResult>(
      live,
      ['lookup_definition_id', 'id'],
      'lookup_definition_id',
      'lookup_definition_create_v1 did not return lookup_definition_id',
    );
    const category = requireLiveStringField(
      live,
      ['category'],
      'lookup_definition_create_v1 did not return category',
    );
    return { ...rec, category } as LookupDefinitionMutationResult;
  }
  await sleep(120);
  if (!args?.category) throw new Error('lookup_definition_create_v1 requires category');
  const id = 'lkd_new_' + Math.floor(Math.random() * 90000);
  return {
    ok: true,
    lookup_definition_id: id,
    category: args.category.toLowerCase(),
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_value_create_v1(args: {
  lookup_definition_id?: string;
  category?: string;
  value: string;
  label: string;
  description?: string;
  sort_order?: number;
  metadata?: Record<string, unknown>;
  status?: 'draft' | 'active' | 'archived';
}): Promise<LookupValueMutationResult> {
  const live = await livePArgsMutationResult('lookup_value_create_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_create_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.value || !args?.label) {
    throw new Error('lookup_value_create_v1 requires value and label');
  }
  const id = 'lkv_new_' + Math.floor(Math.random() * 90000);
  return {
    ok: true,
    lookup_value_id: id,
    status: args.status ?? 'draft',
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_value_update_v1(args: {
  lookup_value_id: string;
  label?: string;
  description?: string;
  sort_order?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<LookupValueMutationResult> {
  const live = await livePArgsMutationResult('lookup_value_update_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_update_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.lookup_value_id) throw new Error('lookup_value_update_v1 requires lookup_value_id');
  return {
    ok: true,
    lookup_value_id: args.lookup_value_id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_value_archive_v1(args: {
  lookup_value_id: string;
  reason?: string;
}): Promise<LookupValueMutationResult> {
  const live = await livePArgsMutationResult('lookup_value_archive_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_archive_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.lookup_value_id) throw new Error('lookup_value_archive_v1 requires lookup_value_id');
  return {
    ok: true,
    lookup_value_id: args.lookup_value_id,
    status: 'archived',
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_value_promote_v1(args: {
  lookup_value_id: string;
  effective_from?: string;
  effective_until?: string | null;
}): Promise<LookupValueMutationResult> {
  const live = await livePArgsMutationResult('lookup_value_promote_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_promote_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.lookup_value_id) throw new Error('lookup_value_promote_v1 requires lookup_value_id');
  return {
    ok: true,
    lookup_value_id: args.lookup_value_id,
    status: 'active',
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}
