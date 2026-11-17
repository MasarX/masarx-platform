import type {
  JsonRecord,
  NormalizedPolicy,
  PolicyAssignments,
  PolicyCapability,
  PolicyDeny,
  PolicyRole,
} from "./types";

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const toUniqueStrings = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const normalizeCapabilities = (value: unknown): PolicyCapability[] => {
  return asArray(value)
    .map(asRecord)
    .filter(Boolean)
    .map((capability) => {
      const key = asString(capability?.key);
      if (!key) return null;
      return {
        ...capability,
        key,
        label: asString(capability?.label) || key,
        description: asString(capability?.description) || "",
      } as PolicyCapability;
    })
    .filter(Boolean) as PolicyCapability[];
};

const normalizeRoles = (value: unknown): PolicyRole[] => {
  return asArray(value)
    .map(asRecord)
    .filter(Boolean)
    .map((role) => {
      const key = asString(role?.key);
      if (!key) return null;
      const capabilityKeys = toUniqueStrings(
        asArray(role?.capability_keys).map(asString)
      );
      return {
        ...role,
        key,
        label: asString(role?.label) || key,
        description: asString(role?.description) || "",
        capability_keys: capabilityKeys,
      } as PolicyRole;
    })
    .filter(Boolean) as PolicyRole[];
};

const normalizeAssignments = (value: unknown): PolicyAssignments => {
  const record = asRecord(value);
  const userType = asRecord(record?.user_type);
  const userId = asRecord(record?.user_id);
  const normalizeMap = (map: JsonRecord | null) => {
    if (!map) return undefined;
    const next: Record<string, string[]> = {};
    Object.entries(map).forEach(([key, raw]) => {
      const roles = toUniqueStrings(asArray(raw).map(asString));
      if (roles.length > 0) {
        next[key] = roles;
      }
    });
    return next;
  };
  return {
    user_type: normalizeMap(userType),
    user_id: normalizeMap(userId),
  };
};

const normalizeDenies = (value: unknown): PolicyDeny[] => {
  return asArray(value)
    .map(asRecord)
    .filter(Boolean)
    .map((deny) => {
      const capabilityKey = asString(deny?.capability_key);
      if (!capabilityKey) return null;
      return {
        ...deny,
        capability_key: capabilityKey,
        scope_type: asString(deny?.scope_type),
        scope_id: asString(deny?.scope_id),
        reason: asString(deny?.reason),
      } as PolicyDeny;
    })
    .filter(Boolean) as PolicyDeny[];
};

export const normalizePolicy = (policy: unknown): NormalizedPolicy => {
  const base = asRecord(policy) ?? {};
  return {
    base,
    capabilities: normalizeCapabilities(base.capabilities),
    roles: normalizeRoles(base.roles),
    assignments: normalizeAssignments(base.assignments),
    denies: normalizeDenies(base.denies),
  };
};

export const replaceRoleKey = (
  assignments: PolicyAssignments,
  from: string,
  to: string
) => {
  const updateMap = (map?: Record<string, string[]>) => {
    if (!map) return undefined;
    const next: Record<string, string[]> = {};
    Object.entries(map).forEach(([key, roles]) => {
      const updated = roles.map((role) => (role === from ? to : role));
      const unique = toUniqueStrings(updated);
      if (unique.length > 0) next[key] = unique;
    });
    return next;
  };
  return {
    user_type: updateMap(assignments.user_type),
    user_id: updateMap(assignments.user_id),
  };
};

export const removeRoleKey = (assignments: PolicyAssignments, roleKey: string) => {
  const updateMap = (map?: Record<string, string[]>) => {
    if (!map) return undefined;
    const next: Record<string, string[]> = {};
    Object.entries(map).forEach(([key, roles]) => {
      const filtered = roles.filter((role) => role !== roleKey);
      if (filtered.length > 0) next[key] = filtered;
    });
    return next;
  };
  return {
    user_type: updateMap(assignments.user_type),
    user_id: updateMap(assignments.user_id),
  };
};

export const toUniqueStringsFromRaw = (values: unknown[]) =>
  toUniqueStrings(values.map(asString));

