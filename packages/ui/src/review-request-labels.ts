import { labelFromKey } from "./resource-query";

export function humanizeReviewRequestLabel(value: string | null) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const label = labelFromKey(normalized).trim();
  return label || normalized;
}

export function resolveReviewRequestBadgeTone(value: string | null) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "approved") return "success" as const;
  if (normalized === "rejected") return "danger" as const;
  if (normalized === "pending") return "neutral" as const;
  return "accent" as const;
}
