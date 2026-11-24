export const POD_POLICY_LOADING_MESSAGE = "Proof policy is still loading. Retry in a moment.";
export const POD_POLICY_UNAVAILABLE_MESSAGE =
  "Proof policy unavailable. Connect online and retry before submitting.";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n", ""].includes(normalized)) return false;
  return false;
}

export function resolveComposerPodPolicyState(input: {
  supportsPod: boolean;
  hasPolicy: boolean;
  isLoading: boolean;
  isError: boolean;
}) {
  const pending = input.supportsPod && input.isLoading;
  const unavailable = input.supportsPod && !pending && (input.isError || !input.hasPolicy);
  const submitDisabled = pending || unavailable;
  const blockingMessage = pending
    ? POD_POLICY_LOADING_MESSAGE
    : unavailable
      ? POD_POLICY_UNAVAILABLE_MESSAGE
      : null;

  return {
    pending,
    unavailable,
    submitDisabled,
    blockingMessage,
  };
}

export function resolveComposerPodRequirements(
  commandKey: string | null | undefined,
  policy: Record<string, unknown>,
): Record<string, unknown> {
  const key = commandKey === "tasks.complete" ? "completed" : commandKey === "tasks.exception" ? "exception" : null;
  if (!key) return {};
  return { ...asRecord(asRecord(policy.requirements)[key]), ...asRecord(policy[key]) };
}

export function resolveComposerSignatureRequired(input: {
  podRequirements?: Record<string, unknown> | null;
  handoverMode?: string | null;
  handoverModes?: Array<{ value?: unknown; metadata?: unknown }> | null;
}) {
  const policyRequired = coerceBoolean(asRecord(input.podRequirements).signature_required);
  const handoverMode = String(input.handoverMode ?? "").trim().toLowerCase();
  if (!handoverMode) return policyRequired;

  const handoverModeOption = (input.handoverModes ?? []).find(
    (entry) => String(entry?.value ?? "").trim().toLowerCase() === handoverMode
  );
  const lookupRequired = coerceBoolean(asRecord(handoverModeOption?.metadata).requires_signature);
  return policyRequired || lookupRequired;
}

export function resolveComposerOtpRequired(input: {
  podRequirements?: Record<string, unknown> | null;
}) {
  return coerceBoolean(asRecord(input.podRequirements).otp_required);
}

export function resolveComposerIdentityRequired(input: {
  podRequirements?: Record<string, unknown> | null;
}) {
  return coerceBoolean(asRecord(input.podRequirements).identity_confirmation_required);
}
