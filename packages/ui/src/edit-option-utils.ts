export type EditOption = {
  label: string;
  value: string;
};

function normalizeOptionToken(value: unknown) {
  if (value === null || value === undefined) return "";
  const normalized = String(value).trim();
  return normalized;
}

function normalizeOptionLabel(value: string, label: string) {
  const normalizedLabel = label.trim();
  if (normalizedLabel) return normalizedLabel;
  return value;
}

export function normalizeEditOptions(
  options: readonly unknown[] | null | undefined
): EditOption[] {
  if (!Array.isArray(options) || options.length === 0) {
    return [];
  }

  const normalized = new Map<string, EditOption>();
  for (const option of options) {
    if (typeof option === "string" || typeof option === "number") {
      const value = normalizeOptionToken(option);
      if (!value || normalized.has(value)) continue;
      normalized.set(value, {
        value,
        label: normalizeOptionLabel(value, String(option)),
      });
      continue;
    }

    if (!option || typeof option !== "object") {
      continue;
    }

    const optionRecord = option as {
      label?: unknown;
      value?: unknown;
    };
    const value = normalizeOptionToken(optionRecord.value ?? optionRecord.label);
    if (!value || normalized.has(value)) continue;
    const label = normalizeOptionLabel(
      value,
      normalizeOptionToken(optionRecord.label ?? optionRecord.value)
    );
    normalized.set(value, { value, label });
  }

  return Array.from(normalized.values());
}

export function resolveEditOptionLabel(
  value: unknown,
  options: readonly EditOption[]
): string | null {
  const normalizedValue = normalizeOptionToken(value);
  if (!normalizedValue) return null;
  const match = options.find((option) => option.value === normalizedValue);
  return match?.label ?? null;
}

export function resolveEditOptionDisplayValue(
  value: unknown,
  options: readonly EditOption[]
): string | null {
  if (options.length === 0) return null;

  if (Array.isArray(value)) {
    const labels = value
      .map((entry) => resolveEditOptionLabel(entry, options) ?? normalizeOptionToken(entry))
      .filter(Boolean);
    return labels.length > 0 ? labels.join(", ") : null;
  }

  return resolveEditOptionLabel(value, options);
}
