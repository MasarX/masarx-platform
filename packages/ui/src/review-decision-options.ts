export type ReviewDecisionOption = {
  value: string;
  label: string;
};

export type ReviewDecisionLookupRow = {
  value?: string | null;
  label?: string | null;
  name?: string | null;
  display_name?: string | null;
};

const defaultAllowedReviewDecisionValues = ["approved", "rejected"] as const;

function humanizeLookupValue(value: string): string {
  return value
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

export function normalizeReviewDecisionOptions(
  rows: readonly ReviewDecisionLookupRow[] | null | undefined,
  allowedValues: readonly string[] = defaultAllowedReviewDecisionValues,
): ReviewDecisionOption[] {
  const allowed = new Set(
    allowedValues
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const options: ReviewDecisionOption[] = [];

  for (const row of rows ?? []) {
    const value = String(row?.value ?? "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    if (allowed.size > 0 && !allowed.has(value)) continue;

    const label =
      String(row?.label ?? "").trim() ||
      String(row?.display_name ?? "").trim() ||
      String(row?.name ?? "").trim() ||
      humanizeLookupValue(value);

    options.push({ value, label });
    seen.add(value);
  }

  return options;
}

export function resolveReviewDecisionValue(
  rawValue: unknown,
  options: readonly ReviewDecisionOption[] | null | undefined,
): "approved" | "rejected" | "" {
  const value = String(rawValue ?? "").trim().toLowerCase();
  if (value !== "approved" && value !== "rejected") return "";
  return options?.some((option) => option.value === value) ? value : "";
}
