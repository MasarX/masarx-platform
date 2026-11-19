type ResourceRow = Record<string, unknown>;

type LookupBundledRow = (
  category: string,
  value: string,
) => { label?: unknown } | null;

export function projectWebhookSourceDirectory(seed: Record<string, unknown>): ResourceRow[] {
  const sources = (seed.webhook_sources ?? []) as Array<{
    id: string;
    organization_id?: string;
    source_identifier?: string;
    name?: string;
    provider_type?: string;
    auth_token?: string;
    mapping_config_id?: string | null;
    sender_id?: string | null;
    rate_limit_per_hour?: number;
    enabled?: boolean;
    created_at?: string | null;
    updated_at?: string | null;
    last_event_at?: string | null;
    lifecycle_state?: string | null;
    archived_at?: string | null;
    archived_by?: string | null;
    archive_reason?: string | null;
    managed_metadata?: Record<string, unknown> | null;
  }>;
  const senders = (seed.senders ?? []) as Array<{
    id: string;
    client_id?: string | null;
    name?: string | null;
    brand_name?: string | null;
  }>;
  const clients = (seed.clients ?? []) as Array<{
    id: string;
    name?: string | null;
  }>;
  const inbox = (seed.webhook_inbox ?? []) as Array<{
    webhook_source_id?: string;
    created_at?: string;
    processing_status?: string;
  }>;
  const rules = (seed.webhook_rules ?? []) as Array<{
    webhook_source_id?: string;
    enabled?: boolean;
  }>;
  const mappings = (seed.mapping_configs ?? []) as Array<{
    id: string;
    mapping_key?: string;
    mapping_config?: Record<string, unknown> | null;
  }>;
  const mappingById = new Map<string, (typeof mappings)[number]>();
  for (const m of mappings) mappingById.set(m.id, m);
  const senderById = new Map<string, (typeof senders)[number]>();
  for (const s of senders) senderById.set(s.id, s);
  const clientById = new Map<string, (typeof clients)[number]>();
  for (const c of clients) clientById.set(c.id, c);

  const now = Date.now();
  const cutoffMs = now - 24 * 60 * 60 * 1000;
  const ERROR_STATUSES = new Set(['failed', 'dead_letter']);

  return sources.map((ws) => {
    let lastEventAt: string | null = ws.last_event_at ?? null;
    let lastEventStatus: string | null = null;
    let eventCount24h = 0;
    let errorCount24h = 0;
    for (const wi of inbox) {
      if (wi.webhook_source_id !== ws.id) continue;
      const created = wi.created_at ?? null;
      if (!created) continue;
      if (!lastEventAt || created > lastEventAt) {
        lastEventAt = created;
        lastEventStatus = wi.processing_status ?? null;
      }
      const ms = Date.parse(created);
      if (Number.isFinite(ms) && ms >= cutoffMs) {
        eventCount24h += 1;
        if (wi.processing_status && ERROR_STATUSES.has(wi.processing_status)) {
          errorCount24h += 1;
        }
      }
    }
    let ruleCount = 0;
    let activeRuleCount = 0;
    for (const r of rules) {
      if (r.webhook_source_id !== ws.id) continue;
      ruleCount += 1;
      if (r.enabled !== false) activeRuleCount += 1;
    }
    const mapping = ws.mapping_config_id ? mappingById.get(ws.mapping_config_id) : undefined;
    const mappingConfigLabel = (() => {
      const cfg = mapping?.mapping_config;
      if (!cfg || typeof cfg !== 'object') return null;
      const label = String(cfg.label ?? cfg.name ?? '').trim();
      return label || null;
    })();
    const enabled = ws.enabled ?? true;
    const sender = ws.sender_id ? senderById.get(ws.sender_id) : undefined;
    const client = sender?.client_id ? clientById.get(sender.client_id) : undefined;
    const lifecycleState = ws.lifecycle_state ?? (
      ws.archived_at || ws.managed_metadata?.archived_at ? 'archived' : null
    );
    const authMasked = (() => {
      const t = ws.auth_token;
      if (!t) return null;
      if (t.length <= 4) return '••••';
      return t.slice(0, 4) + '••••';
    })();

    return {
      id: ws.id,
      organization_id: ws.organization_id ?? null,
      source_identifier: ws.source_identifier ?? null,
      source_label: ws.name ?? null,
      name: ws.name ?? null,
      provider_type: ws.provider_type ?? null,
      mapping_config_id: ws.mapping_config_id ?? null,
      sender_id: ws.sender_id ?? null,
      sender_label: sender?.brand_name ?? sender?.name ?? null,
      client_id: sender?.client_id ?? null,
      client_label: client?.name ?? null,
      rate_limit_per_hour: ws.rate_limit_per_hour ?? null,
      enabled,
      created_at: ws.created_at ?? null,
      updated_at: ws.updated_at ?? null,
      lifecycle_state: lifecycleState,
      archived_at: ws.archived_at ?? ws.managed_metadata?.archived_at ?? null,
      archived_by: ws.archived_by ?? null,
      archive_reason: ws.archive_reason ?? ws.managed_metadata?.archive_reason ?? null,
      managed_metadata: ws.managed_metadata ?? null,
      mapping_label: mappingConfigLabel ?? mapping?.mapping_key ?? null,
      last_event_at: lastEventAt,
      last_event_status: lastEventStatus,
      event_count_24h: eventCount24h,
      error_count_24h: errorCount24h,
      rule_count: ruleCount,
      active_rule_count: activeRuleCount,
      is_healthy: enabled && errorCount24h === 0,
      has_recent_errors: errorCount24h > 0,
      auth_token_masked: authMasked,
    } as ResourceRow;
  });
}

export function projectWebhookInboxDirectory(
  seed: Record<string, unknown>,
  lookupBundledRow: LookupBundledRow,
): ResourceRow[] {
  const inbox = (seed.webhook_inbox ?? []) as Array<{
    id: string;
    organization_id?: string | null;
    webhook_source_id?: string;
    provider_type?: string;
    external_id?: string;
    event_type?: string;
    processing_status?: string;
    correlation_id?: string;
    idempotency_key?: string | null;
    workflow_run_id?: string | null;
    lease_expires_at?: string | null;
    created_at?: string;
    processed_at?: string | null;
    error_message?: string | null;
    raw_payload?: Record<string, unknown> | null;
    transformed_payload?: Record<string, unknown> | null;
    ack_mode?: string | null;
    ack_status_code?: number | null;
    ack_outcome?: string | null;
    ack_reason?: string | null;
    ack_body?: Record<string, unknown> | null;
    ack_validation?: Record<string, unknown> | null;
    response_outcome?: string | null;
    response_reason?: string | null;
    response_mode?: string | null;
    response_status_code?: number | null;
    payload_size?: number;
  }>;
  const workflowRuns = (seed.workflow_runs ?? []) as Array<{
    id: string;
    status?: string | null;
  }>;
  const shipments = (seed.shipments ?? []) as Array<{
    id: string;
    tracking_number?: string | null;
    status?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
  const domainEvents = (seed.domain_events ?? []) as Array<{
    event_type?: string | null;
    resource_type?: string | null;
    resource_id?: string | null;
    workflow_run_id?: string | null;
  }>;
  const sources = (seed.webhook_sources ?? []) as Array<{
    id: string;
    organization_id?: string | null;
    name?: string;
    source_identifier?: string;
    provider_type?: string;
    mapping_config_id?: string | null;
  }>;
  const mappingConfigs = (seed.mapping_configs ?? []) as Array<{
    id: string;
    mapping_key?: string | null;
    mapping_config?: Record<string, unknown> | null;
    target?: string | null;
    mapping_version?: number | null;
  }>;
  const replays = (seed.webhook_inbox_replays ?? []) as Array<{
    webhook_inbox_id?: string;
    action?: string;
    created_at?: string;
    changed_by?: string;
    changed_by_label?: string;
  }>;
  const sourceById = new Map<string, (typeof sources)[number]>();
  for (const s of sources) sourceById.set(s.id, s);
  const mappingById = new Map<string, (typeof mappingConfigs)[number]>();
  for (const mapping of mappingConfigs) mappingById.set(mapping.id, mapping);
  const workflowRunById = new Map<string, (typeof workflowRuns)[number]>();
  for (const run of workflowRuns) workflowRunById.set(run.id, run);

  const TERMINAL_STATUSES = new Set([
    'succeeded',
    'failed',
    'dead_letter',
    'processed',
  ]);
  const ACTIONABLE_STATUSES = new Set([
    'pending',
    'processing',
    'failed',
    'dead_letter',
  ]);

  const now = Date.now();

  return inbox.map((wi) => {
    const source = wi.webhook_source_id ? sourceById.get(wi.webhook_source_id) : undefined;
    const mapping = source?.mapping_config_id ? mappingById.get(source.mapping_config_id) : undefined;
    const mappingConfigLabel = (() => {
      const cfg = mapping?.mapping_config;
      if (!cfg || typeof cfg !== 'object') return null;
      const label = String(cfg.label ?? cfg.name ?? '').trim();
      return label || null;
    })();
    const mappingRules = mapping?.mapping_config?.rules;
    const status = wi.processing_status ?? 'pending';
    const linkedShipmentEvent = wi.workflow_run_id
      ? domainEvents.find((event) =>
          event.workflow_run_id === wi.workflow_run_id &&
          typeof event.event_type === 'string' &&
          event.event_type.startsWith('shipment.') &&
          event.resource_type === 'shipment' &&
          typeof event.resource_id === 'string' &&
          event.resource_id.length > 0,
        )
      : undefined;
    const linkedShipment = shipments.find((shipment) => {
      const metadata = shipment.metadata ?? {};
      return metadata.source_webhook_id === wi.id
        || (!!wi.workflow_run_id && metadata.workflow_run_id === wi.workflow_run_id)
        || (!!linkedShipmentEvent?.resource_id && shipment.id === linkedShipmentEvent.resource_id);
    });
    const linkedShipmentId = linkedShipment?.id ?? linkedShipmentEvent?.resource_id ?? null;

    let replayCount = 0;
    let forceStatusCount = 0;
    let lastReplayAt: string | null = null;
    let lastReplayAction: string | null = null;
    let lastReplayActor: string | null = null;
    for (const wir of replays) {
      if (wir.webhook_inbox_id !== wi.id) continue;
      if (wir.action === 'replay') replayCount += 1;
      if (wir.action === 'force_status') forceStatusCount += 1;
      const at = wir.created_at ?? null;
      if (at && (!lastReplayAt || at > lastReplayAt)) {
        lastReplayAt = at;
        lastReplayAction = wir.action ?? null;
        lastReplayActor = wir.changed_by_label ?? wir.changed_by ?? null;
      }
    }

    const createdMs = wi.created_at ? Date.parse(wi.created_at) : NaN;
    const ageSeconds = Number.isFinite(createdMs)
      ? Math.max(0, Math.floor((now - createdMs) / 1000))
      : 0;
    const ageHours = Math.floor(ageSeconds / 3600);

    return {
      id: wi.id,
      organization_id: wi.organization_id ?? source?.organization_id ?? null,
      webhook_source_id: wi.webhook_source_id ?? null,
      provider_type: wi.provider_type ?? source?.provider_type ?? null,
      external_id: wi.external_id ?? null,
      event_type: wi.event_type ?? null,
      processing_status: status,
      correlation_id: wi.correlation_id ?? null,
      idempotency_key: wi.idempotency_key ?? null,
      workflow_run_id: wi.workflow_run_id ?? null,
      lease_expires_at: wi.lease_expires_at ?? null,
      created_at: wi.created_at ?? null,
      processed_at: wi.processed_at ?? null,
      error_message: wi.error_message ?? null,
      raw_payload: wi.raw_payload ?? null,
      transformed_payload: wi.transformed_payload ?? null,
      ack_mode: wi.ack_mode ?? null,
      ack_status_code: wi.ack_status_code ?? null,
      ack_outcome: wi.ack_outcome ?? null,
      ack_reason: wi.ack_reason ?? null,
      ack_body: wi.ack_body ?? null,
      ack_validation: wi.ack_validation ?? null,
      response_outcome: wi.response_outcome ?? null,
      response_reason: wi.response_reason ?? null,
      response_mode: wi.response_mode ?? null,
      response_status_code: wi.response_status_code ?? null,
      workflow_run_status: wi.workflow_run_id ? (workflowRunById.get(wi.workflow_run_id)?.status ?? null) : null,
      canonical_intent: typeof wi.ack_validation?.intent === 'object'
        ? ((wi.ack_validation.intent as Record<string, unknown>).canonical ?? wi.event_type ?? null)
        : wi.event_type ?? null,
      shipment_id: linkedShipmentId,
      tracking_number: linkedShipment?.tracking_number ?? null,
      shipment_status: linkedShipment?.status ?? null,
      payload_size: typeof wi.payload_size === 'number' ? wi.payload_size : 0,
      source_label: source?.name ?? null,
      source_identifier: source?.source_identifier ?? null,
      provider_type_label: lookupBundledRow(
        'webhook_provider_type',
        source?.provider_type ?? wi.provider_type ?? '',
      )?.label ?? source?.provider_type ?? wi.provider_type ?? null,
      mapping_config_id: source?.mapping_config_id ?? null,
      mapping_label: mappingConfigLabel ?? mapping?.mapping_key ?? null,
      mapping_target: typeof mapping?.mapping_config?.target === 'string'
        ? mapping.mapping_config.target
        : typeof mapping?.target === 'string'
          ? mapping.target
          : null,
      mapping_version: mapping?.mapping_version ?? null,
      mapping_rules_count: Array.isArray(mappingRules) ? mappingRules.length : 0,
      replay_count: replayCount,
      force_status_count: forceStatusCount,
      last_replay_at: lastReplayAt,
      last_replay_action: lastReplayAction,
      last_replay_actor: lastReplayActor,
      is_terminal: TERMINAL_STATUSES.has(status),
      is_actionable: ACTIONABLE_STATUSES.has(status),
      age_seconds: ageSeconds,
      age_hours: ageHours,
    } as ResourceRow;
  });
}

export function projectMappingConfigDirectory(seed: Record<string, unknown>): ResourceRow[] {
  const mappings = (seed.mapping_configs ?? []) as Array<{
    id: string;
    organization_id?: string | null;
    mapping_type?: string;
    mapping_key?: string;
    mapping_config?: Record<string, unknown> | null;
    mapping_version?: number;
    notes?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    target?: string;
  }>;
  const sources = (seed.webhook_sources ?? []) as Array<{
    mapping_config_id?: string | null;
  }>;
  const rules = (seed.webhook_rules ?? []) as Array<{
    mapping_config_id?: string | null;
  }>;
  const apiRoutes = (seed.api_routes ?? []) as Array<{
    enabled?: boolean | null;
    pack_id?: string | null;
    policy?: Record<string, unknown> | null;
  }>;
  const apiRoutePacks = (seed.api_route_packs ?? []) as Array<{
    id?: string | null;
    enabled?: boolean | null;
  }>;
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const mappingRefFromApiRoutePolicy = (
    policyValue: Record<string, unknown> | null | undefined,
  ): { id: string | null; key: string | null; type: string } => {
    const policy = asRecord(policyValue);
    const requestMapping = asRecord(policy.request_mapping);
    const mappingStudio = asRecord(policy.mapping_studio);
    const studioRequestMapping = asRecord(mappingStudio.request_mapping);
    const studioRequestConfig = asRecord(mappingStudio.request_config);
    const studioConfigRequestMapping = asRecord(studioRequestConfig.request_mapping);
    const idCandidates = [
      requestMapping.mapping_config_id,
      mappingStudio.request_mapping_config_id,
      studioRequestMapping.mapping_config_id,
      studioConfigRequestMapping.mapping_config_id,
    ];
    const keyCandidates = [
      requestMapping.mapping_key,
      mappingStudio.request_mapping_key,
      studioRequestMapping.mapping_key,
      studioConfigRequestMapping.mapping_key,
    ];
    const typeCandidates = [
      requestMapping.mapping_type,
      studioRequestMapping.mapping_type,
      studioConfigRequestMapping.mapping_type,
    ];
    const firstString = (values: unknown[]): string | null => {
      for (const candidate of values) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      }
      return null;
    };
    return {
      id: firstString(idCandidates),
      key: firstString(keyCandidates),
      type: firstString(typeCandidates) ?? 'api_gateway_inbound',
    };
  };
  const sourceCountByMapping = new Map<string, number>();
  for (const s of sources) {
    if (!s.mapping_config_id) continue;
    sourceCountByMapping.set(
      s.mapping_config_id,
      (sourceCountByMapping.get(s.mapping_config_id) ?? 0) + 1,
    );
  }
  const ruleCountByMapping = new Map<string, number>();
  for (const r of rules) {
    if (!r.mapping_config_id) continue;
    ruleCountByMapping.set(
      r.mapping_config_id,
      (ruleCountByMapping.get(r.mapping_config_id) ?? 0) + 1,
    );
  }
  const apiRouteCountByMapping = new Map<string, number>();
  const apiRouteCountByTypeKey = new Map<string, number>();
  const disabledApiRoutePackIds = new Set(
    apiRoutePacks
      .filter((pack) => pack.enabled === false && typeof pack.id === 'string' && pack.id.trim())
      .map((pack) => pack.id as string),
  );
  for (const route of apiRoutes) {
    if (route.enabled === false) continue;
    if (route.pack_id && disabledApiRoutePackIds.has(route.pack_id)) continue;
    const mappingRef = mappingRefFromApiRoutePolicy(route.policy);
    if (mappingRef.id) {
      apiRouteCountByMapping.set(
        mappingRef.id,
        (apiRouteCountByMapping.get(mappingRef.id) ?? 0) + 1,
      );
      continue;
    }
    if (!mappingRef.key) continue;
    const key = `${mappingRef.type}\u0000${mappingRef.key}`;
    apiRouteCountByTypeKey.set(key, (apiRouteCountByTypeKey.get(key) ?? 0) + 1);
  }

  const now = Date.now();

  return mappings.map((mc) => {
    const cfg = (mc.mapping_config ?? {}) as Record<string, unknown>;
    const targetFromCfg = typeof cfg.target === 'string' ? (cfg.target as string) : null;
    const targetTable = typeof cfg.target_table === 'string' ? (cfg.target_table as string) : null;
    const targetAction = typeof cfg.target_action === 'string'
      ? (cfg.target_action as string)
      : null;
    const target = targetFromCfg ?? mc.target ?? null;
    const rulesArr = Array.isArray(cfg.rules) ? (cfg.rules as unknown[]) : [];
    const rulesCount = rulesArr.length;
    const sourceCount = sourceCountByMapping.get(mc.id) ?? 0;
    const ruleUsageCount = ruleCountByMapping.get(mc.id) ?? 0;
    const typeKey = `${mc.mapping_type ?? 'api_gateway_inbound'}\u0000${mc.mapping_key ?? ''}`;
    const apiRouteCount =
      (apiRouteCountByMapping.get(mc.id) ?? 0) +
      (apiRouteCountByTypeKey.get(typeKey) ?? 0);
    const updatedAt = mc.updated_at ?? null;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
    const ageSeconds = Number.isFinite(updatedMs)
      ? Math.max(0, Math.floor((now - updatedMs) / 1000))
      : 0;
    const notes = mc.notes ?? null;
    const notesExcerpt = (() => {
      if (!notes) return null;
      if (notes.length <= 120) return notes;
      return notes.slice(0, 120) + '…';
    })();

    return {
      id: mc.id,
      organization_id: mc.organization_id ?? null,
      mapping_type: mc.mapping_type ?? null,
      mapping_key: mc.mapping_key ?? null,
      mapping_config: cfg,
      mapping_version: mc.mapping_version ?? 1,
      notes,
      created_at: mc.created_at ?? null,
      updated_at: updatedAt,
      target,
      target_table: targetTable,
      target_action: targetAction,
      rules_count: rulesCount,
      source_count: sourceCount,
      rule_usage_count: ruleUsageCount,
      api_route_count: apiRouteCount,
      is_in_use: sourceCount + ruleUsageCount + apiRouteCount > 0,
      has_rules: rulesCount > 0,
      notes_excerpt: notesExcerpt,
      age_seconds: ageSeconds,
    } as ResourceRow;
  });
}

export function projectIntegrationCredentialDirectory(seed: Record<string, unknown>): ResourceRow[] {
  const configs = (seed.provider_auth_configs ?? []) as Array<{
    id: string;
    provider_id?: string;
    auth_type?: string;
    expires_at?: string | null;
    created_at?: string | null;
    last_rotated_at?: string | null;
    status?: string;
  }>;
  const providers = (seed.providers ?? []) as Array<{
    id: string;
    organization_id?: string | null;
    name?: string;
    provider_type?: string;
    vendor?: string;
    metadata?: Record<string, unknown>;
  }>;
  const providerById = new Map<string, (typeof providers)[number]>();
  for (const p of providers) providerById.set(p.id, p);

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  return configs.map((pac) => {
    const expiresAt = pac.expires_at ?? null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    const provider = pac.provider_id ? providerById.get(pac.provider_id) : undefined;
    const providerVendor = (() => {
      if (provider?.vendor) return provider.vendor;
      const md = (provider?.metadata ?? {}) as Record<string, unknown>;
      if (typeof md.vendor === 'string') return md.vendor as string;
      return null;
    })();
    let status: 'active' | 'expiring' | 'expired';
    let daysUntilExpiry: number | null;
    let isExpiring = false;
    let isExpired = false;
    let isActive = false;
    if (!Number.isFinite(expiresMs)) {
      status = 'active';
      daysUntilExpiry = null;
      isActive = true;
    } else if (expiresMs <= now) {
      status = 'expired';
      daysUntilExpiry = Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000));
      isExpired = true;
    } else if (expiresMs - now <= THIRTY_DAYS_MS) {
      status = 'expiring';
      daysUntilExpiry = Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000));
      isExpiring = true;
    } else {
      status = 'active';
      daysUntilExpiry = Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000));
      isActive = true;
    }
    const createdAt = pac.created_at ?? null;

    return {
      id: pac.id,
      organization_id: provider?.organization_id ?? null,
      provider_id: pac.provider_id ?? null,
      auth_type: pac.auth_type ?? null,
      auth_type_label: pac.auth_type ?? null,
      expires_at: expiresAt,
      created_at: createdAt,
      last_rotated_at: pac.last_rotated_at ?? createdAt,
      status,
      days_until_expiry: daysUntilExpiry,
      provider_label: provider?.name ?? null,
      provider_kind: provider?.provider_type ?? null,
      provider_vendor: providerVendor,
      is_expiring: isExpiring,
      is_expired: isExpired,
      is_active: isActive,
      mask_state: true,
    } as ResourceRow;
  });
}
