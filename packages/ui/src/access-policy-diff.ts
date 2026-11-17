type JsonRecord = Record<string, unknown>;

type RoleCapabilityDiff = {
  key: string;
  added: string[];
  removed: string[];
};

export type AccessPolicyDiff = {
  capability: {
    added: string[];
    removed: string[];
  };
  role: {
    added: string[];
    removed: string[];
    updated: RoleCapabilityDiff[];
  };
  assignments: {
    userTypeChanged: string[];
    userIdChanged: string[];
  };
  denies: {
    added: string[];
    removed: string[];
  };
};

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const toUniqueStrings = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const normalizeCapabilities = (policy: JsonRecord) => {
  const capabilities = asArray(policy.capabilities)
    .map(asRecord)
    .filter(Boolean)
    .map((capability) => asString(capability?.key))
    .filter(Boolean);
  return new Set(toUniqueStrings(capabilities));
};

const normalizeRoles = (policy: JsonRecord) => {
  const roles = asArray(policy.roles)
    .map(asRecord)
    .filter(Boolean)
    .map((role) => {
      const key = asString(role?.key);
      if (!key) return null;
      const capabilityKeys = toUniqueStrings(
        asArray(role?.capability_keys).map(asString)
      );
      return { key, capabilityKeys };
    })
    .filter(Boolean) as Array<{ key: string; capabilityKeys: string[] }>;
  return new Map(roles.map((role) => [role.key, new Set(role.capabilityKeys)]));
};

const normalizeAssignments = (policy: JsonRecord) => {
  const assignments = asRecord(policy.assignments);
  const toMap = (raw: unknown): Map<string, Set<string>> => {
    const record = asRecord(raw);
    if (!record) return new Map<string, Set<string>>();
    const entries: Array<[string, Set<string>]> = Object.entries(record).map(
      ([key, value]) => [
        key,
        new Set(toUniqueStrings(asArray(value).map(asString))),
      ]
    );
    return new Map<string, Set<string>>(entries);
  };
  return {
    userType: toMap(assignments?.user_type),
    userId: toMap(assignments?.user_id),
  };
};

const normalizeDenies = (policy: JsonRecord) => {
  const denies = asArray(policy.denies)
    .map(asRecord)
    .filter(Boolean)
    .map((deny) => {
      const capabilityKey = asString(deny?.capability_key);
      if (!capabilityKey) return null;
      const scopeType = asString(deny?.scope_type);
      const scopeId = asString(deny?.scope_id);
      const reason = asString(deny?.reason);
      return [capabilityKey, scopeType, scopeId, reason].join("|");
    })
    .filter(Boolean) as string[];
  return new Set(toUniqueStrings(denies));
};

const diffSets = (from: Set<string>, to: Set<string>) => {
  const added = Array.from(to).filter((value) => !from.has(value));
  const removed = Array.from(from).filter((value) => !to.has(value));
  return { added, removed };
};

const diffRoleCapabilities = (
  from: Map<string, Set<string>>,
  to: Map<string, Set<string>>
) => {
  const updated: RoleCapabilityDiff[] = [];
  for (const [key, nextCapabilities] of to.entries()) {
    const prevCapabilities = from.get(key);
    if (!prevCapabilities) continue;
    const { added, removed } = diffSets(prevCapabilities, nextCapabilities);
    if (added.length === 0 && removed.length === 0) continue;
    updated.push({ key, added, removed });
  }
  return updated.sort((a, b) => a.key.localeCompare(b.key));
};

const diffAssignments = (
  from: Map<string, Set<string>>,
  to: Map<string, Set<string>>
) => {
  const changed = new Set<string>();
  const keys = new Set<string>([...from.keys(), ...to.keys()]);
  for (const key of keys) {
    const before = from.get(key) ?? new Set<string>();
    const after = to.get(key) ?? new Set<string>();
    const { added, removed } = diffSets(before, after);
    if (added.length > 0 || removed.length > 0) {
      changed.add(key);
    }
  }
  return Array.from(changed).sort((a, b) => a.localeCompare(b));
};

export function summarizeAccessPolicyChanges(
  baseline: unknown,
  next: unknown
): AccessPolicyDiff | null {
  const baseRecord = asRecord(baseline);
  const nextRecord = asRecord(next);
  if (!baseRecord || !nextRecord) return null;

  const baseCaps = normalizeCapabilities(baseRecord);
  const nextCaps = normalizeCapabilities(nextRecord);
  const capability = diffSets(baseCaps, nextCaps);

  const baseRoles = normalizeRoles(baseRecord);
  const nextRoles = normalizeRoles(nextRecord);
  const role = {
    added: Array.from(nextRoles.keys()).filter((key) => !baseRoles.has(key)),
    removed: Array.from(baseRoles.keys()).filter((key) => !nextRoles.has(key)),
    updated: diffRoleCapabilities(baseRoles, nextRoles),
  };

  const baseAssignments = normalizeAssignments(baseRecord);
  const nextAssignments = normalizeAssignments(nextRecord);
  const assignments = {
    userTypeChanged: diffAssignments(
      baseAssignments.userType,
      nextAssignments.userType
    ),
    userIdChanged: diffAssignments(
      baseAssignments.userId,
      nextAssignments.userId
    ),
  };
  const baseDenies = normalizeDenies(baseRecord);
  const nextDenies = normalizeDenies(nextRecord);
  const denies = diffSets(baseDenies, nextDenies);

  return {
    capability: {
      added: capability.added.sort((a, b) => a.localeCompare(b)),
      removed: capability.removed.sort((a, b) => a.localeCompare(b)),
    },
    role: {
      added: role.added.sort((a, b) => a.localeCompare(b)),
      removed: role.removed.sort((a, b) => a.localeCompare(b)),
      updated: role.updated,
    },
    assignments,
    denies: {
      added: denies.added.sort((a, b) => a.localeCompare(b)),
      removed: denies.removed.sort((a, b) => a.localeCompare(b)),
    },
  };
}
