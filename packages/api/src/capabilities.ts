export const WILDCARD_CAPABILITY = "*";

export function resolveCapabilitySet(capabilities?: string[] | null) {
  return new Set(
    Array.isArray(capabilities)
      ? capabilities
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0
          )
          .map((value) => value.trim())
      : []
  );
}

export function hasCapability(
  capabilitySet: Set<string>,
  requiredCapability?: string | null
) {
  const required = requiredCapability?.trim() ?? "";
  if (!required) return true;
  if (capabilitySet.has(WILDCARD_CAPABILITY)) return true;
  return capabilitySet.has(required);
}

