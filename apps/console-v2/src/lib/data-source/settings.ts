import {
  hasWildcardCapability,
  isWildcardCapability,
} from '../capabilities';
import {
  type AccessPolicyResolutionResult,
  type ApplySettingsValueResult,
  firstRpcRow,
  liveRpc,
  liveRpcTarget,
  type MobilePolicyResolutionResult,
  normalizePolicyContext,
  normalizeSettingsScope,
  seed,
  type SettingsResolutionResult,
  sleep,
  state,
  type UserCapabilityEvalArgs,
  type UserCapabilityEvalResult,
} from '../data-source';

function mobilePolicyResolverName(category: string): string {
  if (!/^[a-z][a-z0-9_]*_policy$/.test(category)) {
    throw new Error(`Invalid mobile policy category: ${category}`);
  }
  return `resolve_${category}`;
}

function mobilePolicyResolutionFromRow(
  category: string,
  resolver: string,
  row: Record<string, unknown>,
): MobilePolicyResolutionResult {
  const scopePath = Array.isArray(row.scope_path) ? (row.scope_path as Array<Record<string, unknown>>) : [];
  const resolvedFrom = String(row.scope_type ?? 'global');
  const resolvedScopeId = (row.scope_id as string | null | undefined) ?? null;
  const ladderPath = scopePath.length > 0
    ? scopePath.map((step, index) => {
        const scopeType = String(step.scope_type ?? '');
        const scopeId = (step.scope_id as string | null | undefined) ?? null;
        const isWinner = scopeType === resolvedFrom && (scopeId ?? null) === (resolvedScopeId ?? null);
        return {
          rank: typeof step.rank === 'number' ? step.rank : index,
          scope_type: scopeType,
          scope_id: scopeId,
          has_value: isWinner,
          value: isWinner ? row.value : null,
        };
      })
    : [{
        rank: 0,
        scope_type: resolvedFrom,
        scope_id: resolvedScopeId,
        has_value: true,
        value: row.value,
      }];

  return {
    category,
    value: row.value,
    resolved_from: resolvedFrom,
    ladder_path: ladderPath,
    settings_resolution_id: String(row.settings_resolution_id ?? row.settings_version_id ?? row.settings_id ?? ''),
    override_of: null,
    resolver,
  };
}

export async function resolveSettings(
  category: string,
  scopeContext: Record<string, unknown> = state.scope,
): Promise<SettingsResolutionResult> {
  const live = await liveRpc<unknown>('resolve_settings_row_from_policy_context_v1', {
    p_category: category,
    p_context: normalizePolicyContext(scopeContext),
  });
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data);
    if (!row) throw new Error(`resolve_settings_row_from_policy_context_v1 returned no row for ${category}`);
    const scopePath = Array.isArray(row.scope_path) ? (row.scope_path as Array<Record<string, unknown>>) : [];
    const resolvedFrom = String(row.scope_type ?? 'global');
    const resolvedScopeId = (row.scope_id as string | null | undefined) ?? null;
    return {
      value: row.value,
      resolved_from: resolvedFrom,
      ladder_path: scopePath.map((step, index) => {
        const scopeType = String(step.scope_type ?? '');
        const scopeId = (step.scope_id as string | null | undefined) ?? null;
        const isWinner = scopeType === resolvedFrom && (scopeId ?? null) === (resolvedScopeId ?? null);
        return {
          rank: index,
          scope_type: scopeType,
          scope_id: scopeId,
          has_value: isWinner,
          version: isWinner ? row.version : undefined,
          value: isWinner ? row.value : undefined,
        };
      }),
      settings_resolution_id: String(row.settings_resolution_id ?? row.settings_version_id ?? row.settings_id ?? ''),
      override_of: null,
    };
  }

  await sleep(30);
  // AGENTS.md §3 (ROW-DRIVEN) + §4 (SSOT): derive the ladder ordering from
  // the canonical `scope_type_registry` rows (sorted by `ladder_rank`)
  // instead of an inline literal tuple. Adding a new tier or re-ranking is
  // a row mutation; the FE picks it up without source change.
  type ScopeRegistryRow = {
    scope_type: string;
    ladder_rank: number;
    is_enabled: boolean;
  };
  const scopeRegistry = (seed.scope_type_registry as ScopeRegistryRow[]) ?? [];
  const enabledScopes = scopeRegistry
    .filter((r) => r.is_enabled !== false)
    .slice()
    .sort((a, b) => a.ladder_rank - b.ladder_rank);
  // Highest specificity first (descending ladder_rank) so we pick the most
  // specific override before falling through to less specific scopes.
  const ranksDesc = enabledScopes.slice().reverse();

  const path: SettingsResolutionResult['ladder_path'] = [];
  let winning: { scope_type: string; scope_id: string | null; version: unknown; value: unknown; ladder_rank: number } | null = null;
  const settingsVersions = seed.settings_versions as Array<{
    category: string;
    scope_type: string;
    scope_id: string;
    status: string;
    version: unknown;
    value: unknown;
  }>;

  for (let i = 0; i < enabledScopes.length; i++) {
    // Walk LSB-first (global → tenant → ...) for path order; reverse for
    // pick-most-specific-first uses below.
    const reg = enabledScopes[i]!;
    const scopeType = reg.scope_type;
    const scopeIdRaw = (scopeContext as Record<string, { id?: string } | undefined>)[scopeType]?.id ?? (scopeType === 'global' ? 'global' : null);
    const scopeId: string | null = scopeIdRaw ?? null;
    const row = scopeId
      ? settingsVersions.find(
          (s) => s.category === category && s.scope_type === scopeType && s.scope_id === scopeId && s.status === 'active',
        )
      : null;
    path.push({
      rank: reg.ladder_rank,
      scope_type: scopeType,
      scope_id: scopeId,
      has_value: !!row,
      version: row?.version,
      value: row?.value,
    });
  }

  // Pick winner — most specific (highest ladder_rank) row that has a value.
  for (const reg of ranksDesc) {
    const entry = path.find((p) => p.scope_type === reg.scope_type);
    if (entry?.has_value) {
      winning = {
        scope_type: reg.scope_type,
        scope_id: entry.scope_id,
        version: entry.version,
        value: entry.value,
        ladder_rank: reg.ladder_rank,
      };
      break;
    }
  }

  // override_of: the next-most-specific row that ALSO had a value (the row
  // that the winner overrides).
  let override_of: unknown = null;
  if (winning) {
    const lessSpecific = ranksDesc
      .filter((reg) => reg.ladder_rank < winning!.ladder_rank)
      .map((reg) => path.find((p) => p.scope_type === reg.scope_type))
      .filter((entry): entry is NonNullable<typeof entry> => entry?.has_value === true);
    if (lessSpecific.length > 0) override_of = lessSpecific[0];
  }

  return {
    value: winning?.value,
    resolved_from: winning?.scope_type ?? 'global',
    ladder_path: path,
    settings_resolution_id: `srlv_${Math.floor(Math.random() * 9000) + 1000}`,
    override_of,
  };
}

// Mobile policies share the canonical ladder shape with `resolveSettings` so
// the same `LadderViz` primitive can render them. Live mode calls the
// category-specific api-schema resolver (`resolve_<category>`). Seed mode keeps
// the local `mobile_policy_resolved` snapshot as the fallback.
export async function resolveMobilePolicy(
  category: string,
  scopeContext: Record<string, unknown> = state.scope,
): Promise<MobilePolicyResolutionResult | null> {
  const resolver = mobilePolicyResolverName(category);
  const live = await liveRpc<unknown>(resolver, {
    p_context: normalizePolicyContext(scopeContext),
  });
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data);
    return row ? mobilePolicyResolutionFromRow(category, resolver, row) : null;
  }

  await sleep(20);
  const resolvedSeed = (seed.mobile_policy_resolved?.[category] as Record<string, unknown> | undefined) ?? null;
  if (resolvedSeed == null) return null;
  const value = resolvedSeed.value ?? resolvedSeed;
  const seedResolvedFrom = typeof resolvedSeed.resolved_from === 'string'
    ? resolvedSeed.resolved_from
    : null;
  // Walk the canonical ladder for visualization. Seed snapshots store the
  // winning value only, so non-winning steps intentionally render as inherited.
  const reg = (seed.settings_category_registry as Array<{ category: string; scopes?: string[] }>).
    find((c) => c.category === category);
  const allowedScopes = (reg?.scopes ?? ['global', 'tenant']) as string[];
  const scopeRanks: Record<string, number> = { global: 0, tenant: 1, client: 2, sender: 3, source: 4, resource: 5 };
  const winningScope = seedResolvedFrom ?? 'global';
  const ladder_path = allowedScopes.map((scopeType) => {
    const scopeId = scopeType === 'global'
      ? 'global'
      : ((scopeContext as Record<string, { id?: string } | undefined>)[scopeType]?.id ?? null);
    const isWinning = scopeType === winningScope;
    return {
      rank: scopeRanks[scopeType] ?? 99,
      scope_type: scopeType,
      scope_id: scopeId,
      has_value: isWinning,
      value: isWinning ? value : null,
    };
  });
  // override_of: the next-lower-rank scope below winning that also "had" a value
  // (always null in synthetic mode — production will compute correctly).
  return {
    category,
    value,
    resolved_from: winningScope,
    ladder_path,
    settings_resolution_id: String(resolvedSeed.settings_resolution_id ?? resolvedSeed.srlv ?? `srlv_${Math.floor(Math.random() * 9000) + 1000}`),
    override_of: typeof resolvedSeed.overrides === 'string' ? resolvedSeed.overrides : null,
    resolver,
  };
}

export async function resolve_access_control_policy_v1(
  args: { scope_type?: string; scope_id?: string | null } = {},
): Promise<AccessPolicyResolutionResult> {
  const live = await liveRpc<AccessPolicyResolutionResult & { ok?: boolean }>('resolve_access_control_policy_v2', {
    p_args: {
      scope_type: args.scope_type ?? null,
      scope_id: args.scope_id ?? null,
    },
  });
  if (live) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `resolve_access_control_policy_v2` (migration
    // 202605020200_w44_rpc_v2_normalizations.sql). Envelope:
    // { ok, policy, settings_id, settings_version_id, scope_type, scope_id,
    //   scope_path, settings_resolution_id }. The exported adapter signature
    // is unchanged.
    const envelope = (live.data ?? null) as
      | (AccessPolicyResolutionResult & { ok?: boolean })
      | null;
    if (!envelope || envelope.settings_id == null) {
      throw new Error('resolve_access_control_policy_v1 returned no rows');
    }
    return {
      policy: envelope.policy,
      settings_id: envelope.settings_id,
      settings_version_id: envelope.settings_version_id,
      scope_type: envelope.scope_type,
      scope_id: envelope.scope_id,
      scope_path: envelope.scope_path,
      settings_resolution_id: envelope.settings_resolution_id,
    };
  }

  await sleep(30);

  // Resolve effective scope: caller-provided -> user's access_scope -> 'global'.
  const effectiveScopeType =
    args.scope_type ??
    (state.user.access_scope_type === 'platform' ? 'global' : state.user.access_scope_type) ??
    'global';
  const effectiveScopeId = args.scope_id ?? state.user.access_scope_id ?? null;

  // Synthesize ladder scope_path from current scope context (matches the
  // backend `resolve_scope_path_v1` shape: ordered ancestor walk
  // most-specific -> root). We mirror the JSONB array contract verbatim.
  const scope_path: Array<{ scope_type: string; scope_id: string | null }> = [];
  if (effectiveScopeType === 'global') {
    scope_path.push({ scope_type: 'global', scope_id: null });
  } else {
    const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
    const ladderOrder: string[] = ['tenant', 'client', 'sender', 'source', 'resource'];
    const includeUpTo = ladderOrder.indexOf(effectiveScopeType);
    if (includeUpTo >= 0) {
      // Most-specific-first walk down to root for canonical scope_path order.
      for (let i = includeUpTo; i >= 0; i--) {
        const key = ladderOrder[i] as string;
        const id = key === effectiveScopeType ? effectiveScopeId : (scopeCtx[key]?.id ?? null);
        scope_path.push({ scope_type: key, scope_id: id });
      }
    } else {
      scope_path.push({ scope_type: effectiveScopeType, scope_id: effectiveScopeId });
    }
    // Always include 'global' as the root.
    scope_path.push({ scope_type: 'global', scope_id: null });
  }

  // Build a representative `policy` JSONB body that mirrors the canonical
  // access_control_policy seed shape (capabilities catalog + roles +
  // resource_map). The capability catalog comes from registry.capabilities
  // (re-exported through seed.js) which is itself pinned to the backend SSOT
  // in 202601022113_access_control_policy_core.sql.
  const seedCapabilities = (seed.capabilities ?? []) as string[];
  const capabilities = seedCapabilities.map((key) => ({ key, label: key }));
  const devRoles = (seed.dev_roles ?? []) as Array<{ id: string; label: string; capabilities: string[] | string }>;
  const roles = devRoles.map((r) => ({
    key: r.id,
    label: r.label,
    capability_keys:
      typeof r.capabilities === 'string' && isWildcardCapability(r.capabilities)
        ? ['*']
        : Array.isArray(r.capabilities)
          ? r.capabilities
          : [r.capabilities],
  }));
  const readRegistry = (seed.ui_read_registry ?? {}) as Record<
    string,
    { capability_read?: string; capability_write?: string }
  >;
  const resource_map: Record<string, { read?: string; write?: string }> = {};
  for (const [resourceKey, def] of Object.entries(readRegistry)) {
    const r = def?.capability_read;
    const w = def?.capability_write;
    if (r || w) {
      resource_map[resourceKey] = {
        ...(r ? { read: r } : {}),
        ...(w ? { write: w } : {}),
      };
    }
  }

  const policy = {
    capabilities,
    roles,
    assignments: { user_type: Object.fromEntries(roles.map((r) => [r.key, [r.key]])) },
    resource_map,
    denies: [] as unknown[],
  };

  return {
    policy,
    settings_id: 'set_access_control_policy_demo',
    settings_version_id: 'sv_access_control_policy_demo',
    scope_type: effectiveScopeType,
    scope_id: effectiveScopeId,
    scope_path,
    settings_resolution_id: `srlv_${Math.floor(Math.random() * 9000) + 1000}`,
  };
}

export async function user_capability_eval_v1(
  args: UserCapabilityEvalArgs,
): Promise<UserCapabilityEvalResult> {
  const rpcName = args.user_id ? 'user_capability_eval_for_user_v1' : 'user_capability_eval_v2';
  const live = await liveRpc<{ ok?: boolean; eval?: UserCapabilityEvalResult } | UserCapabilityEvalResult>(rpcName, {
    p_args: {
      capability_key: args.capability_key,
      scope_type: args.scope_type ?? null,
      scope_id: args.scope_id ?? null,
      target_user_id: args.user_id ?? null,
      user_id: args.user_id ?? null,
    },
  });
  if (live) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `user_capability_eval_v2` (migration
    // 202605020200_w44_rpc_v2_normalizations.sql). Envelope:
    // { ok, eval: <UserCapabilityEvalResult> }. The exported adapter
    // signature is unchanged.
    const envelope = (live.data ?? {}) as { ok?: boolean; eval?: UserCapabilityEvalResult };
    return (envelope.eval ?? (live.data as UserCapabilityEvalResult));
  }

  // Demo synthesis — reuses the in-memory access-control resolver to derive a
  // canonical-shaped envelope. Mirrors the SQL evaluator path:
  //   resolve_access_control_policy_v1 -> access_eval_capability_v1 ->
  //   user_capability_eval_v1.
  await sleep(20);

  const resolution = await resolve_access_control_policy_v1({
    scope_type: args.scope_type,
    scope_id: args.scope_id ?? null,
  });

  // Determine the role keys for the evaluated user. In demo mode we evaluate
  // against the current logged-in user (data-source state) — the production
  // RPC always evaluates for `auth.uid()`. When `user_id` is supplied, we
  // log it but still use the current user's role/cap set since the demo
  // `users` table is single-user.
  const userRole = state.user.role;
  const userCaps = new Set<string>(state.capabilities);

  // `granted_capabilities` mirrors the backend resolver: the union of all
  // capability keys produced by the user's role assignments inside the
  // resolved policy. In demo mode, the in-memory `state.capabilities` is the
  // SSOT for this user × scope.
  const grantedCapabilities = Array.from(userCaps);

  // Wildcard role (`WILDCARD_CAPABILITY` = '*') — backend's `super_admin`
  // analog — short-circuits to allowed. Otherwise check explicit catalog
  // membership.
  const wildcard = hasWildcardCapability(userCaps);
  const allowed = wildcard || userCaps.has(args.capability_key);

  // Reason taxonomy mirrors `access_eval_capability_v1`:
  //   - 'allowed_by_role'        -> capability granted via role assignment
  //   - 'allowed_by_wildcard'    -> role has '*' (super_admin)
  //   - 'denied_no_role_grant'   -> resolved policy has no grant for this cap
  //   - 'unauthenticated'        -> no auth.uid() (not reachable in demo)
  const reason = wildcard
    ? 'allowed_by_wildcard'
    : allowed
      ? 'allowed_by_role'
      : 'denied_no_role_grant';

  return {
    allowed,
    reason,
    capability_key: args.capability_key,
    scope_type: resolution.scope_type,
    scope_id: resolution.scope_id,
    role_keys: [userRole],
    granted_capabilities: grantedCapabilities,
    policy_source: {
      settings_id: resolution.settings_id,
      settings_version_id: resolution.settings_version_id,
      policy_scope_type: resolution.scope_type,
      policy_scope_id: resolution.scope_id,
      scope_path: resolution.scope_path,
    },
  };
}

export async function proposeSettingsChange(
  category: string,
  scope: unknown,
  value: unknown,
  opts: { dryRun?: boolean; justification?: string } = {},
): Promise<{
  diff: { from: string; to: unknown };
  blast_radius: string;
  approval_required: boolean;
  settings_resolution_id: string;
  dry_run: boolean;
  justification: string | null;
}> {
  const normalizedScope = normalizeSettingsScope(scope);
  const liveTarget = liveRpcTarget();
  if (liveTarget) {
    if (opts.dryRun) {
      const current = await resolveSettings(category, {
        [normalizedScope.scope_type]: normalizedScope.scope_id ? { id: normalizedScope.scope_id } : undefined,
      });
      return {
        diff: { from: 'current', to: value },
        blast_radius:
          normalizedScope.scope_type === 'global'
            ? 'global · all tenants'
            : `${normalizedScope.scope_type} · ${normalizedScope.scope_id ?? 'unscoped'}`,
        approval_required: true,
        settings_resolution_id: current.settings_resolution_id,
        dry_run: true,
        justification: opts.justification ?? null,
      };
    }
    const { data, error } = await liveTarget.rpc('request_settings_change_v1', {
      p_category: category,
      p_scope_type: normalizedScope.scope_type,
      p_scope_id: normalizedScope.scope_id,
      p_value: value,
      p_change_reason: opts.justification ?? 'requested via Console V2',
      p_effective_from: null,
    });
    if (error) throw new Error(error.message);
    const rec = firstRpcRow<Record<string, unknown>>(data) ?? ((data ?? {}) as Record<string, unknown>);
    return {
      diff: { from: 'current', to: value },
      blast_radius:
        normalizedScope.scope_type === 'global'
          ? 'global · all tenants'
          : `${normalizedScope.scope_type} · ${normalizedScope.scope_id ?? 'unscoped'}`,
      approval_required: Boolean(rec.approval_required ?? true),
      settings_resolution_id: String(
        rec.settings_resolution_id ??
          rec.settings_version_id ??
          rec.settings_change_request_id ??
          rec.id ??
          '',
      ),
      dry_run: false,
      justification: opts.justification ?? null,
    };
  }

  await sleep(80);
  const seedScope = normalizeSettingsScope(scope);
  const reg = (seed.settings_category_registry as Array<{
    category: string;
    scopes?: string[];
    approval_required?: boolean;
  }>).find((c) => c.category === category);
  return {
    diff: { from: 'previous', to: value },
    blast_radius:
      reg?.scopes?.indexOf(seedScope.scope_type) === 0 ? 'global · all tenants' : `${seedScope.scope_type} · ${seedScope.scope_id}`,
    approval_required: !!reg?.approval_required,
    settings_resolution_id: `srlv_${Math.floor(Math.random() * 9000) + 1000}`,
    dry_run: !!opts.dryRun,
    justification: opts.justification ?? null,
  };
}

export async function applySettingsValue(
  category: string,
  scope: unknown,
  value: unknown,
  opts: { justification?: string } = {},
): Promise<ApplySettingsValueResult> {
  const normalizedScope = normalizeSettingsScope(scope);
  const liveTarget = liveRpcTarget();
  if (liveTarget) {
    const { data, error } = await liveTarget.rpc('ui_apply_settings_value_v1', {
      p_category: category,
      p_scope_type: normalizedScope.scope_type,
      p_scope_id: normalizedScope.scope_id,
      p_value: value,
      p_change_reason: opts.justification ?? 'applied via Console V2',
    });
    if (error) throw new Error(error.message);
    const rec = firstRpcRow<Record<string, unknown>>(data) ?? ((data ?? {}) as Record<string, unknown>);
    return {
      ok: Boolean(rec.ok ?? true),
      applied: Boolean(rec.applied ?? true),
      category: String(rec.category ?? category),
      scope_type: String(rec.scope_type ?? normalizedScope.scope_type),
      scope_id: (rec.scope_id as string | null | undefined) ?? normalizedScope.scope_id,
      settings_id: rec.settings_id ? String(rec.settings_id) : undefined,
      settings_version_id: String(rec.settings_version_id ?? rec.settings_resolution_id ?? ''),
      settings_version_number:
        typeof rec.settings_version_number === 'number' ? rec.settings_version_number : undefined,
      settings_resolution_id: String(rec.settings_resolution_id ?? rec.settings_version_id ?? ''),
      domain_event_id: rec.domain_event_id ? String(rec.domain_event_id) : undefined,
    };
  }

  await sleep(80);
  const settingsVersions = seed.settings_versions as Array<{
    category: string;
    scope_type: string;
    scope_id: string;
    status: string;
    version: number;
    value: unknown;
  }>;
  for (const row of settingsVersions) {
    if (
      row.category === category &&
      row.scope_type === normalizedScope.scope_type &&
      row.scope_id === (normalizedScope.scope_id ?? 'global') &&
      row.status === 'active'
    ) {
      row.status = 'superseded';
    }
  }
  const version =
    Math.max(
      0,
      ...settingsVersions
        .filter(
          (row) =>
            row.category === category &&
            row.scope_type === normalizedScope.scope_type &&
            row.scope_id === (normalizedScope.scope_id ?? 'global'),
        )
        .map((row) => Number(row.version) || 0),
    ) + 1;
  const settingsVersionId = `sv_apply_${Date.now()}`;
  settingsVersions.push({
    category,
    scope_type: normalizedScope.scope_type,
    scope_id: normalizedScope.scope_id ?? 'global',
    status: 'active',
    version,
    value,
  });
  return {
    ok: true,
    applied: true,
    category,
    scope_type: normalizedScope.scope_type,
    scope_id: normalizedScope.scope_id,
    settings_version_id: settingsVersionId,
    settings_version_number: version,
    settings_resolution_id: settingsVersionId,
  };
}
