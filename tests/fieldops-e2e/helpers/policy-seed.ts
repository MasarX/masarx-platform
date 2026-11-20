import type { Pool, PoolClient } from "pg";

type MobilePolicyCategory =
  | "pod_policy"
  | "scan_policy"
  | "driver_safety_policy"
  | "mobile_sync_policy"
  | "mobile_visibility_policy"
  | "mobile_diagnostics_policy"
  | "device_policy"
  | "navigation_policy"
  | "mobile_attestation_policy"
  | "cod_policy"
  | "settlement_policy";

type MobilePolicyScopeType =
  | "global"
  | "tenant"
  | "client"
  | "sender"
  | "source"
  | "resource";

type MobilePolicyScope =
  | {
      scopeType?: "global";
      scopeId?: undefined;
    }
  | {
      scopeType: Exclude<MobilePolicyScopeType, "global">;
      scopeId: string;
    };

type PolicyResolutionScopeInput = {
  organizationId?: string | null;
  clientId?: string | null;
  senderId?: string | null;
  sourceId?: string | null;
  resourceId?: string | null;
  includeGlobal?: boolean;
};

type PolicySnapshot = {
  category: MobilePolicyCategory;
  scopeType: MobilePolicyScopeType;
  scopeId: string | null;
  previousValue: Record<string, unknown> | null;
};

type PolicyModule = {
  pool: Pool;
  upsertSettings: (
    category: string,
    scopeType: string,
    scopeId: string | null,
    value: Record<string, unknown>,
    changeReason?: string,
    client?: PoolClient | null,
  ) => Promise<void>;
};

type ScopedSettingsRow = {
  cached_value: Record<string, unknown> | null;
};

function getPolicyModule(): PolicyModule {
  return require("../../utils/policies.js") as PolicyModule;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MOBILE_POLICY_CATEGORIES = new Set<MobilePolicyCategory>([
  "pod_policy",
  "scan_policy",
  "driver_safety_policy",
  "mobile_sync_policy",
  "mobile_visibility_policy",
  "mobile_diagnostics_policy",
  "device_policy",
  "navigation_policy",
  "mobile_attestation_policy",
  "cod_policy",
  "settlement_policy",
]);
const MOBILE_POLICY_SCOPE_TYPES = new Set<MobilePolicyScopeType>([
  "global",
  "tenant",
  "client",
  "sender",
  "source",
  "resource",
]);
const policySnapshots = new Map<string, PolicySnapshot>();

function assertCategory(category: string): MobilePolicyCategory {
  const normalized = String(category || "")
    .trim()
    .toLowerCase() as MobilePolicyCategory;
  if (!MOBILE_POLICY_CATEGORIES.has(normalized)) {
    throw new Error(
      `[fieldops-policy-seed] Unsupported mobile policy category: ${category}`,
    );
  }
  return normalized;
}

function normalizeScope(scope?: MobilePolicyScope) {
  const scopeType = String(scope?.scopeType || "global")
    .trim()
    .toLowerCase() as MobilePolicyScopeType;
  const scopeId =
    String(scope && "scopeId" in scope ? scope.scopeId || "" : "").trim() ||
    null;

  if (!MOBILE_POLICY_SCOPE_TYPES.has(scopeType)) {
    throw new Error(
      `[fieldops-policy-seed] Unsupported scopeType "${scopeType}"`,
    );
  }

  if (scopeType === "global") {
    return { scopeType, scopeId: null as string | null };
  }
  if (!scopeId) {
    throw new Error(
      `[fieldops-policy-seed] scopeId is required for scopeType "${scopeType}"`,
    );
  }
  return { scopeType, scopeId };
}

function uniqueScopes(scopes: MobilePolicyScope[]) {
  const out: MobilePolicyScope[] = [];
  const seen = new Set<string>();

  for (const scope of scopes) {
    const normalized = normalizeScope(scope);
    const key = `${normalized.scopeType}:${normalized.scopeId ?? NIL_UUID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (normalized.scopeType === "global") {
      out.push({ scopeType: "global" });
      continue;
    }
    out.push({
      scopeType: normalized.scopeType,
      scopeId: normalized.scopeId,
    });
  }

  return out;
}

function createSnapshotKey(
  category: MobilePolicyCategory,
  scopeType: MobilePolicyScopeType,
  scopeId: string | null,
) {
  return `${category}:${scopeType}:${scopeId ?? NIL_UUID}`;
}

async function readScopedCachedValue(
  client: Pool | PoolClient,
  category: MobilePolicyCategory,
  scopeType: MobilePolicyScopeType,
  scopeId: string | null,
) {
  const scopeHash = scopeType === "global" ? NIL_UUID : scopeId;
  const { rows } = await client.query<ScopedSettingsRow>(
    `SELECT s.cached_value
       FROM public.settings s
      WHERE s.category = $1
        AND s.scope_type = $2
        AND s.scope_hash = $3::uuid
      LIMIT 1`,
    [category, scopeType, scopeHash],
  );
  return rows[0]?.cached_value ?? null;
}

async function deleteScopedPolicy(
  client: PoolClient,
  category: MobilePolicyCategory,
  scopeType: MobilePolicyScopeType,
  scopeId: string | null,
) {
  const scopeHash = scopeType === "global" ? NIL_UUID : scopeId;
  await client.query(
    `DELETE FROM public.settings
      WHERE category = $1
        AND scope_type = $2
        AND scope_hash = $3::uuid`,
    [category, scopeType, scopeHash],
  );
  await client.query(
    `DELETE FROM public.settings_versions
      WHERE category = $1
        AND scope_type = $2
        AND scope_hash = $3::uuid
        AND effective_until IS NULL`,
    [category, scopeType, scopeHash],
  );
}

export async function seedMobilePolicy(
  category: string,
  overrides: Record<string, unknown>,
  scope?: MobilePolicyScope,
): Promise<void> {
  const { pool, upsertSettings } = getPolicyModule();
  const normalizedCategory = assertCategory(category);
  const normalizedScope = normalizeScope(scope);
  const snapshotKey = createSnapshotKey(
    normalizedCategory,
    normalizedScope.scopeType,
    normalizedScope.scopeId,
  );

  if (!policySnapshots.has(snapshotKey)) {
    const previousValue = await readScopedCachedValue(
      pool,
      normalizedCategory,
      normalizedScope.scopeType,
      normalizedScope.scopeId,
    );
    policySnapshots.set(snapshotKey, {
      category: normalizedCategory,
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
      previousValue,
    });
  }

  await upsertSettings(
    normalizedCategory,
    normalizedScope.scopeType,
    normalizedScope.scopeId,
    overrides,
    "fieldops e2e mobile policy seed",
  );
}

export function buildMobilePolicyResolutionScopes(
  input: PolicyResolutionScopeInput,
): MobilePolicyScope[] {
  const scopes: MobilePolicyScope[] = [];

  if (input.resourceId) {
    scopes.push({ scopeType: "resource", scopeId: String(input.resourceId).trim() });
  }
  if (input.sourceId) {
    scopes.push({ scopeType: "source", scopeId: String(input.sourceId).trim() });
  }
  if (input.senderId) {
    scopes.push({ scopeType: "sender", scopeId: String(input.senderId).trim() });
  }
  if (input.clientId) {
    scopes.push({ scopeType: "client", scopeId: String(input.clientId).trim() });
  }
  if (input.organizationId) {
    scopes.push({ scopeType: "tenant", scopeId: String(input.organizationId).trim() });
  }
  if (input.includeGlobal !== false) {
    scopes.push({ scopeType: "global" });
  }

  return uniqueScopes(scopes);
}

export async function seedMobilePolicyForResolution(
  category: string,
  overrides: Record<string, unknown>,
  input: PolicyResolutionScopeInput,
): Promise<void> {
  const scopes = buildMobilePolicyResolutionScopes(input);
  for (const scope of scopes) {
    await seedMobilePolicy(category, overrides, scope);
  }
}

export async function resetMobilePolicy(category: string): Promise<void> {
  const { pool, upsertSettings } = getPolicyModule();
  const normalizedCategory = assertCategory(category);
  const snapshots = [...policySnapshots.entries()]
    .filter(([, snapshot]) => snapshot.category === normalizedCategory)
    .map(([key, snapshot]) => ({ key, snapshot }));

  if (snapshots.length === 0) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const { snapshot } of snapshots) {
      await deleteScopedPolicy(
        client,
        snapshot.category,
        snapshot.scopeType,
        snapshot.scopeId,
      );

      if (snapshot.previousValue == null) {
        continue;
      }

      await upsertSettings(
        snapshot.category,
        snapshot.scopeType,
        snapshot.scopeId,
        snapshot.previousValue,
        "fieldops e2e mobile policy reset",
        client,
      );
    }

    await client.query("COMMIT");
    for (const { key } of snapshots) {
      policySnapshots.delete(key);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
