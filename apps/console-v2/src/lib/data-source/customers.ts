import {
  type ClientCreateResult,
  type ClientLifecycleResult,
  type ClientUpdateResult,
  getLookups,
  livePArgsMutationResult,
  nextCorrelationIdHex,
  type RecipientCreateResult,
  type RecipientDeleteResult,
  type RecipientUpdateResult,
  requireLiveResourceAbsenceReadback,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  seed,
  type SenderCreateResult,
  type SenderLifecycleResult,
  type SenderUpdateResult,
  sleep,
  state,
  withRequiredLiveStringField,
} from '../data-source';

export async function client_suspend_v1(args: {
  client_id: string;
  organization_id?: string;
  reason?: string;
}): Promise<ClientLifecycleResult> {
  const live = await livePArgsMutationResult('client_suspend_v1', args, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientLifecycleResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_suspend_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_suspend_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(80);
  if (!args?.client_id) throw new Error('client_suspend_v1 requires client_id');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = clients.find((r) => r.id === args.client_id);
  if (!row) throw new Error(`client_suspend_v1 client ${args.client_id} not found`);
  const wasSuspended = row.status === 'suspended';
  if (!wasSuspended) {
    row.status = 'suspended';
    row.suspension_reason = args.reason ?? null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    client_id: args.client_id,
    idempotent_no_op: wasSuspended,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function client_reactivate_v1(args: {
  client_id: string;
  organization_id?: string;
}): Promise<ClientLifecycleResult> {
  const live = await livePArgsMutationResult('client_reactivate_v1', args, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientLifecycleResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_reactivate_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_reactivate_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(80);
  if (!args?.client_id) throw new Error('client_reactivate_v1 requires client_id');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = clients.find((r) => r.id === args.client_id);
  if (!row) throw new Error(`client_reactivate_v1 client ${args.client_id} not found`);
  const wasActive = row.status === 'active';
  if (!wasActive) {
    row.status = 'active';
    row.suspension_reason = null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    client_id: args.client_id,
    idempotent_no_op: wasActive,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_suspend_v1(args: {
  sender_id: string;
  reason?: string;
}): Promise<SenderLifecycleResult> {
  const live = await livePArgsMutationResult('sender_suspend_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderLifecycleResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_suspend_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_suspend_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(80);
  if (!args?.sender_id) throw new Error('sender_suspend_v1 requires sender_id');
  const senders = (seed.senders ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = senders.find((r) => r.id === args.sender_id);
  if (!row) throw new Error(`sender_suspend_v1 sender ${args.sender_id} not found`);
  const wasInactive = row.status === 'inactive';
  if (!wasInactive) {
    row.status = 'inactive';
    row.suspension_reason = args.reason ?? null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    sender_id: args.sender_id,
    idempotent_no_op: wasInactive,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_reactivate_v1(args: {
  sender_id: string;
}): Promise<SenderLifecycleResult> {
  const live = await livePArgsMutationResult('sender_reactivate_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderLifecycleResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_reactivate_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_reactivate_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(80);
  if (!args?.sender_id) throw new Error('sender_reactivate_v1 requires sender_id');
  const senders = (seed.senders ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = senders.find((r) => r.id === args.sender_id);
  if (!row) throw new Error(`sender_reactivate_v1 sender ${args.sender_id} not found`);
  const wasActive = row.status === 'active';
  if (!wasActive) {
    row.status = 'active';
    row.suspension_reason = null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    sender_id: args.sender_id,
    idempotent_no_op: wasActive,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

async function requireLiveCustomerLifecycleReadback(
  rpcName: string,
  resourceKey: string,
  projectionKey: string,
  resourceId: string,
): Promise<void> {
  await requireLiveResourceReadback(resourceKey, resourceId, rpcName);
  await requireLiveResourceReadback(projectionKey, resourceId, rpcName);
}

async function requireLiveCustomerDeletionReadback(
  rpcName: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  if (resourceType === 'recipient') {
    await requireLiveResourceAbsenceReadback('recipients', { id: resourceId }, rpcName, `recipients:${resourceId}`);
    await requireLiveResourceAbsenceReadback(
      'recipient_directory',
      { recipient_id: resourceId },
      rpcName,
      `recipient_directory:${resourceId}`,
    );
  }
  await requireLiveResourceListReadback('decision_log', { resource_type: resourceType, resource_id: resourceId }, rpcName);
}

export async function client_create_v1(args: {
  name: string;
  slug: string;
  sla_tier?: string;
  account_manager_id?: string | null;
  contract_start_date?: string | null;
  contract_end_date?: string | null;
  organization_id?: string;
  settings_override?: Record<string, unknown> | null;
}): Promise<ClientCreateResult> {
  const live = await livePArgsMutationResult('client_create_v1', args, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientCreateResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_create_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_create_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(120);
  if (!args?.name) throw new Error('client_create_v1 requires name');
  if (!args?.slug) throw new Error('client_create_v1 requires slug');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown>>;
  if (clients.some((r) => (r as { slug?: string }).slug === args.slug)) {
    throw new Error(`client_create_v1 slug "${args.slug}" already taken`);
  }
  const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
  const id = 'cl_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  // In-memory branch: derive organization_id from the explicit arg or the
  // active tenant scope. No hardcoded tenant fallback (live RPC enforces
  // organization scoping via `auth.jwt()` claims; in-memory must mirror by
  // requiring an explicit value or active scope — never bake a tenant id into
  // source).
  const inMemoryOrgId = args.organization_id ?? scopeCtx.tenant?.id;
  if (!inMemoryOrgId) {
    throw new Error(
      'client_create_v1 (in-memory): organization_id is required when no tenant scope is active',
    );
  }
  clients.unshift({
    id,
    organization_id: inMemoryOrgId,
    name: args.name,
    slug: args.slug,
    sla_tier: args.sla_tier ?? 'standard',
    status: 'active',
    account_manager_id: args.account_manager_id ?? null,
    contract_start_date: args.contract_start_date ?? null,
    contract_end_date: args.contract_end_date ?? null,
    suspension_reason: null,
    settings_override: args.settings_override ?? null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    client_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function client_update_v1(args: {
  client_id: string;
  organization_id?: string;
  patch?: Record<string, unknown>;
  name?: string;
  sla_tier?: string;
  account_manager_id?: string | null;
  contract_start_date?: string | null;
  contract_end_date?: string | null;
  billing_settings?: Record<string, unknown> | null;
  settings_override?: Record<string, unknown> | null;
}): Promise<ClientUpdateResult> {
  const patch = (args.patch ?? {}) as Record<string, unknown>;
  const normalizedArgs = { ...args, ...patch };
  delete (normalizedArgs as Record<string, unknown>).patch;
  const live = await livePArgsMutationResult('client_update_v1', normalizedArgs, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientUpdateResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_update_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_update_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(100);
  if (!args?.client_id) throw new Error('client_update_v1 requires client_id');
  if ((normalizedArgs as Record<string, unknown>).status !== undefined) {
    throw new Error('client_update_v1 cannot mutate status — use client_suspend_v1 / client_reactivate_v1');
  }
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = clients.find((r) => r.id === args.client_id);
  if (!row) throw new Error(`client_update_v1 client ${args.client_id} not found`);
  let no_op = true;
  if (normalizedArgs.name !== undefined) { row.name = normalizedArgs.name; no_op = false; }
  if (normalizedArgs.sla_tier !== undefined) { row.sla_tier = normalizedArgs.sla_tier; no_op = false; }
  if (normalizedArgs.account_manager_id !== undefined) { row.account_manager_id = normalizedArgs.account_manager_id; no_op = false; }
  if (normalizedArgs.contract_start_date !== undefined) { row.contract_start_date = normalizedArgs.contract_start_date; no_op = false; }
  if (normalizedArgs.contract_end_date !== undefined) { row.contract_end_date = normalizedArgs.contract_end_date; no_op = false; }
  if (normalizedArgs.billing_settings !== undefined) { row.billing_settings = normalizedArgs.billing_settings; no_op = false; }
  if (normalizedArgs.settings_override !== undefined) { row.settings_override = normalizedArgs.settings_override; no_op = false; }
  if (!no_op) row.updated_at = new Date().toISOString();
  return {
    ok: true,
    client_id: args.client_id,
    idempotent_no_op: no_op,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_create_v1(args: {
  client_id: string;
  name: string;
  brand_name?: string;
  auto_recreate?: boolean;
  settings_override?: Record<string, unknown> | null;
}): Promise<SenderCreateResult> {
  const live = await livePArgsMutationResult('sender_create_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderCreateResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_create_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_create_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(120);
  if (!args?.client_id) throw new Error('sender_create_v1 requires client_id');
  if (!args?.name) throw new Error('sender_create_v1 requires name');
  const senders = (seed.senders ?? []) as Array<Record<string, unknown>>;
  const id = 'snd_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  senders.unshift({
    id,
    client_id: args.client_id,
    name: args.name,
    brand_name: args.brand_name ?? null,
    auto_provisioned: false,
    auto_recreate: args.auto_recreate ?? true,
    status: 'active',
    suspension_reason: null,
    settings_override: args.settings_override ?? null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    sender_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_update_v1(args: {
  sender_id: string;
  name?: string;
  brand_name?: string | null;
  auto_recreate?: boolean;
  warehouse_address_id?: string | null;
  settings_override?: Record<string, unknown> | null;
}): Promise<SenderUpdateResult> {
  const live = await livePArgsMutationResult('sender_update_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderUpdateResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_update_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_update_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(100);
  if (!args?.sender_id) throw new Error('sender_update_v1 requires sender_id');
  if ((args as Record<string, unknown>).status !== undefined) {
    throw new Error('sender_update_v1 cannot mutate status — use sender_suspend_v1 / sender_reactivate_v1');
  }
  const senders = (seed.senders ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = senders.find((r) => r.id === args.sender_id);
  if (!row) throw new Error(`sender_update_v1 sender ${args.sender_id} not found`);
  let no_op = true;
  if (args.name !== undefined) { row.name = args.name; no_op = false; }
  if (args.brand_name !== undefined) { row.brand_name = args.brand_name; no_op = false; }
  if (args.auto_recreate !== undefined) { row.auto_recreate = args.auto_recreate; no_op = false; }
  if (args.warehouse_address_id !== undefined) { row.warehouse_address_id = args.warehouse_address_id; no_op = false; }
  if (args.settings_override !== undefined) { row.settings_override = args.settings_override; no_op = false; }
  if (!no_op) row.updated_at = new Date().toISOString();
  return {
    ok: true,
    sender_id: args.sender_id,
    idempotent_no_op: no_op,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function recipient_create_v1(args: {
  client_id: string;
  name: string;
  phone_number: string;
  email?: string | null;
  external_id?: string | null;
  preferred_language?: string;
  preferred_comm_channel?: string;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  communication_preferences?: Record<string, unknown> | null;
  organization_id?: string;
}): Promise<RecipientCreateResult> {
  const live = await livePArgsMutationResult('recipient_create_v1', args, ['recipient_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RecipientCreateResult>(
      live,
      ['recipient_id', 'id'],
      'recipient_id',
      'recipient_create_v1 did not return recipient_id',
    );
    await requireLiveCustomerLifecycleReadback('recipient_create_v1', 'recipients', 'recipient_directory', result.recipient_id);
    return result;
  }
  await sleep(120);
  if (!args?.client_id) throw new Error('recipient_create_v1 requires client_id');
  if (!args?.name) throw new Error('recipient_create_v1 requires name');
  if (!args?.phone_number) throw new Error('recipient_create_v1 requires phone_number');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string; organization_id?: string }>;
  const clientRow = clients.find((r) => r.id === args.client_id);
  if (!clientRow) throw new Error(`recipient_create_v1 client ${args.client_id} not found`);
  const recipients = (seed.recipients ?? []) as Array<Record<string, unknown>>;
  const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
  const id = 'rcp_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  const orgId = args.organization_id ?? clientRow.organization_id ?? scopeCtx.tenant?.id;
  const defaultLanguage = getLookups('preferred_language').find((r) => r.is_default)?.value;
  if (!orgId) {
    throw new Error(
      'recipient_create_v1 (in-memory): organization_id is required when client row has no organization and no tenant scope is active',
    );
  }
  if (!args.preferred_language && !defaultLanguage) {
    throw new Error('recipient_create_v1 (in-memory): preferred_language default lookup is required');
  }
  recipients.unshift({
    id,
    organization_id: orgId,
    client_id: args.client_id,
    external_id: args.external_id ?? null,
    name: args.name,
    phone_number: args.phone_number,
    phone_validation_status: 'pending',
    phone_validated_at: null,
    email: args.email ?? null,
    preferred_language: args.preferred_language ?? defaultLanguage,
    preferred_comm_channel: args.preferred_comm_channel ?? null,
    quiet_hours_start: args.quiet_hours_start ?? null,
    quiet_hours_end: args.quiet_hours_end ?? null,
    communication_preferences: args.communication_preferences ?? null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    recipient_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function recipient_update_v1(args: {
  recipient_id: string;
  name?: string;
  phone_number?: string;
  email?: string | null;
  external_id?: string | null;
  preferred_language?: string;
  preferred_comm_channel?: string;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  communication_preferences?: Record<string, unknown> | null;
}): Promise<RecipientUpdateResult> {
  const live = await livePArgsMutationResult('recipient_update_v1', args, ['recipient_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RecipientUpdateResult>(
      live,
      ['recipient_id', 'id'],
      'recipient_id',
      'recipient_update_v1 did not return recipient_id',
    );
    await requireLiveCustomerLifecycleReadback('recipient_update_v1', 'recipients', 'recipient_directory', result.recipient_id);
    return result;
  }
  await sleep(100);
  if (!args?.recipient_id) throw new Error('recipient_update_v1 requires recipient_id');
  const recipients = (seed.recipients ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = recipients.find((r) => r.id === args.recipient_id);
  if (!row) throw new Error(`recipient_update_v1 recipient ${args.recipient_id} not found`);
  let no_op = true;
  if (args.name !== undefined) { row.name = args.name; no_op = false; }
  if (args.phone_number !== undefined) {
    row.phone_number = args.phone_number;
    row.phone_validation_status = 'pending';
    row.phone_validated_at = null;
    no_op = false;
  }
  if (args.email !== undefined) { row.email = args.email; no_op = false; }
  if (args.external_id !== undefined) { row.external_id = args.external_id; no_op = false; }
  if (args.preferred_language !== undefined) { row.preferred_language = args.preferred_language; no_op = false; }
  if (args.preferred_comm_channel !== undefined) { row.preferred_comm_channel = args.preferred_comm_channel; no_op = false; }
  if (args.quiet_hours_start !== undefined) { row.quiet_hours_start = args.quiet_hours_start; no_op = false; }
  if (args.quiet_hours_end !== undefined) { row.quiet_hours_end = args.quiet_hours_end; no_op = false; }
  if (args.communication_preferences !== undefined) { row.communication_preferences = args.communication_preferences; no_op = false; }
  if (!no_op) row.updated_at = new Date().toISOString();
  return {
    ok: true,
    recipient_id: args.recipient_id,
    idempotent_no_op: no_op,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function recipient_delete_v1(args: {
  recipient_id: string;
  reason?: string;
}): Promise<RecipientDeleteResult> {
  const live = await livePArgsMutationResult('recipient_delete_v1', args, ['recipient_id', 'id', 'deleted']);
  if (live) {
    const result = withRequiredLiveStringField<RecipientDeleteResult>(
      live,
      ['recipient_id', 'id'],
      'recipient_id',
      'recipient_delete_v1 did not return recipient_id',
    );
    await requireLiveCustomerDeletionReadback('recipient_delete_v1', 'recipient', result.recipient_id);
    return result;
  }
  await sleep(100);
  if (!args?.recipient_id) throw new Error('recipient_delete_v1 requires recipient_id');
  const recipients = (seed.recipients ?? []) as Array<Record<string, unknown> & { id: string }>;
  const index = recipients.findIndex((r) => r.id === args.recipient_id);
  if (index < 0) throw new Error(`recipient_delete_v1 recipient ${args.recipient_id} not found`);
  const shipments = (seed.shipments ?? []) as Array<Record<string, unknown> & { recipient_id?: string | null }>;
  const shipmentReferenceCount = shipments.filter((s) => s.recipient_id === args.recipient_id).length;
  recipients.splice(index, 1);
  for (const shipment of shipments) {
    if (shipment.recipient_id === args.recipient_id) shipment.recipient_id = null;
  }
  return {
    ok: true,
    recipient_id: args.recipient_id,
    deleted: true,
    shipment_reference_count: shipmentReferenceCount,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}
