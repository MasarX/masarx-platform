import type { UiCommandDefinition } from "@masarx/api";

// Row-declared evidence is separate from delivery POD requirements.
export type ComposerEvidence = {
  context: "self";
  registrationRpc: string;
  bucket: string;
  minItems: number;
  maxItems: number;
  tagField: string | null;
};
export function resolveComposerEvidence(command: UiCommandDefinition | null): ComposerEvidence | null {
  const row = command?.execution?.evidence;
  if (!row || row.context !== "self" || !row.registration_rpc || !row.bucket) return null;
  if (!Number.isInteger(row.min_items) || !Number.isInteger(row.max_items) ||
      row.min_items! < 0 || row.max_items! < Math.max(1, row.min_items!)) return null;
  return { context: "self", registrationRpc: row.registration_rpc, bucket: row.bucket,
    minItems: row.min_items!, maxItems: row.max_items!, tagField: row.tag_field || null };
}
export function composerRetryArgs(command: UiCommandDefinition, queueId: string, actor: string | null) {
  return command.execution?.idempotency === "actor_retry_v1"
    ? { p_idempotency_key: queueId, p_expected_actor_user_id: actor } : {};
}
export function buildComposerEvidenceMap(
  artifacts: Array<{ artifactId: string; evidenceTag?: string }>,
  evidence: ComposerEvidence
): Record<string, string> {
  if (artifacts.length < evidence.minItems || artifacts.length > evidence.maxItems)
    throw new Error("evidence_count");
  const result: Record<string, string> = Object.create(null);
  for (const artifact of artifacts) {
    const tag = artifact.evidenceTag?.trim() || (evidence.tagField ? "" : "document");
    if (!tag || tag.length > 100 || Object.hasOwn(result, tag)) throw new Error("evidence_tag");
    result[tag] = artifact.artifactId;
  }
  return result;
}
export function normalizeSelfKycFields(payload: Record<string, unknown>) {
  const normalized = { ...payload };
  if (typeof normalized.checked_item_ids === "string")
    normalized.checked_item_ids = [...new Set(normalized.checked_item_ids.split(",").map(v => v.trim()).filter(Boolean))];
  if (normalized.health_ok === "true") normalized.health_ok = true;
  if (normalized.health_ok === "false") normalized.health_ok = false;
  return normalized;
}

export function validateSelfKycFields(category: string, payload: Record<string, unknown>) {
  if (category === "vehicle_registration" &&
      (typeof payload.plate !== "string" || payload.plate.trim().length < 5 ||
       typeof payload.vin !== "string" || payload.vin.trim().length < 8 ||
       typeof payload.year !== "string" || !/^[0-9]{4}$/.test(payload.year) ||
       typeof payload.model !== "string" || !payload.model.trim())) throw new Error("registration_fields");
  if (category === "cleaning" &&
      (!Array.isArray(payload.checked_item_ids) || !payload.checked_item_ids.length ||
       payload.checked_item_ids.some(v => typeof v !== "string" || !v.trim()))) throw new Error("checklist");
  if (category === "pre_shift" &&
      (typeof payload.shift_id !== "string" || !payload.shift_id.trim() ||
       typeof payload.health_ok !== "boolean")) throw new Error("preshift");
}

// Pure snapshot capability retained from F584; no dismissal policy or draft storage.
// Nonempty text (including whitespace) is unsaved input, not validated submission.
export function composerHasUnsavedWork(snapshot: {
  values: Readonly<Record<string, unknown>>;
  artifacts: readonly unknown[];
  signatureStrokes: readonly (readonly unknown[])[];
}): boolean {
  return snapshot.artifacts.length > 0 || snapshot.signatureStrokes.length > 0
    || Object.values(snapshot.values).some(value => typeof value === "string" && value.length > 0);
}
