import type { MobileV2PodFailReason, MobileV2PodMethod } from "./mobile-v2-pod-policy";

export interface MobileV2PodCloseoutCodInput {
  readonly amount?: number | null;
  readonly currency?: string | null;
  readonly method?: string | null;
  readonly receiptContext?: string | null;
  readonly tenderedAmount?: number | null;
}

export interface BuildMobileV2PodCloseoutEvidenceInput {
  readonly methods: ReadonlyArray<MobileV2PodMethod>;
  readonly capturedAt: string;
  readonly artifactIds?: ReadonlyArray<string> | null;
  readonly scanCodes?: ReadonlyArray<string> | null;
  readonly deliveredBoxIds?: ReadonlyArray<string> | null;
  readonly deliveredBoxNumbers?: ReadonlyArray<number> | null;
  readonly otpCode?: string | null;
  readonly cod?: MobileV2PodCloseoutCodInput | null;
}

export interface MobileV2PodFailureContext {
  readonly note: string | null;
  readonly photoCaptured: boolean;
  readonly escalateAcknowledged: boolean;
  readonly artifactIds?: ReadonlyArray<string> | null;
}

export interface BuildMobileV2PodFailureEvidenceInput {
  readonly reason: MobileV2PodFailReason;
  readonly context: MobileV2PodFailureContext;
  readonly capturedAt: string;
}

function finitePositiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeUuidList(value: ReadonlyArray<string> | null | undefined): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const id of value ?? []) {
    const trimmed = id.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return Object.freeze([...seen]);
}

export function extractMobileV2BoxNumberFromBarcode(code: string): number | null {
  const suffix = code.trim().split(":").pop() ?? "";
  if (!/^[1-9][0-9]*$/.test(suffix)) return null;
  const parsed = Number(suffix);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeMobileV2DeliveredBoxNumbers(
  explicitNumbers: ReadonlyArray<number> | null | undefined,
  scanCodes: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<number> {
  const seen = new Set<number>();
  for (const value of explicitNumbers ?? []) {
    if (Number.isSafeInteger(value) && value > 0) seen.add(value);
  }
  for (const code of scanCodes ?? []) {
    const parsed = extractMobileV2BoxNumberFromBarcode(code);
    if (parsed !== null) seen.add(parsed);
  }
  return Object.freeze([...seen].sort((a, b) => a - b));
}

export function buildMobileV2PodCloseoutEvidence(
  input: BuildMobileV2PodCloseoutEvidenceInput,
): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    pod_methods: input.methods.join("+"),
    captured_at: input.capturedAt,
  };
  const artifactIds = normalizeUuidList(input.artifactIds);
  if (artifactIds.length > 0) {
    evidence.artifact_ids = artifactIds;
    evidence.pod = {
      artifact_ids: artifactIds,
    };
  }
  const scanCodes = (input.scanCodes ?? []).map((code) => code.trim()).filter((code) => code !== "");
  if (scanCodes.length > 0) {
    evidence.scan_codes = scanCodes;
    evidence.scan = {
      codes: scanCodes,
      count: scanCodes.length,
    };
  }
  const deliveredBoxIds = normalizeUuidList(input.deliveredBoxIds);
  const deliveredBoxNumbers = normalizeMobileV2DeliveredBoxNumbers(
    input.deliveredBoxNumbers,
    scanCodes,
  );
  if (deliveredBoxIds.length > 0 || deliveredBoxNumbers.length > 0) {
    if (deliveredBoxIds.length > 0) {
      evidence.delivered_box_ids = deliveredBoxIds;
    }
    if (deliveredBoxNumbers.length > 0) {
      evidence.delivered_box_numbers = deliveredBoxNumbers;
    }
    evidence.pod = {
      ...((typeof evidence.pod === "object" && evidence.pod !== null && !Array.isArray(evidence.pod))
        ? evidence.pod as Record<string, unknown>
        : {}),
      ...(deliveredBoxIds.length > 0 ? { delivered_box_ids: deliveredBoxIds } : {}),
      ...(deliveredBoxNumbers.length > 0 ? { delivered_box_numbers: deliveredBoxNumbers } : {}),
    };
    evidence.delivery_completion = {
      ...(deliveredBoxIds.length > 0 ? { delivered_box_ids: deliveredBoxIds } : {}),
      ...(deliveredBoxNumbers.length > 0 ? { delivered_box_numbers: deliveredBoxNumbers } : {}),
    };
  }
  const otpCode = input.otpCode?.replace(/\D/g, "").slice(0, 12) ?? "";
  if (otpCode.length > 0) {
    evidence.otp_code = otpCode;
    evidence.otp = {
      entered: true,
      code_length: otpCode.length,
    };
  }

  const amount = finitePositiveNumber(input.cod?.amount);
  if (amount === null) {
    return evidence;
  }

  const tenderedAmount = finitePositiveNumber(input.cod?.tenderedAmount) ?? amount;
  const changeDue = Math.max(tenderedAmount - amount, 0);
  const method = input.cod?.method?.trim().toLowerCase() || "cash";
  const currency = input.cod?.currency?.trim().toUpperCase() || "SAR";
  const receiptContext = input.cod?.receiptContext?.trim() || "fieldops_mobile_v2_pod";

  return {
    ...evidence,
    payment_outcome: "collected",
    payment_method: method,
    payment_amount: amount,
    payment_receipt_context: receiptContext,
    payment_collection: {
      outcome: "collected",
      method,
      expected_amount: amount,
      collected_amount: amount,
      tendered_amount: tenderedAmount,
      change_due_amount: changeDue,
      currency,
      receipt_context: receiptContext,
    },
  };
}

export function buildMobileV2PodFailureEvidence(
  input: BuildMobileV2PodFailureEvidenceInput,
): Record<string, unknown> {
  const note = input.context.note?.trim() ?? "";
  const required = {
    photo: input.reason.photo,
    note: input.reason.note,
    escalate_acknowledgement: input.reason.escalate,
  };
  const captured = {
    photo: input.context.photoCaptured,
    note: note.length > 0,
    escalate_acknowledgement: input.context.escalateAcknowledged,
  };
  const failure: Record<string, unknown> = {
    reason_code: input.reason.code,
    reason_label: input.reason.label,
    reattempt: input.reason.reattempt,
    escalate: input.reason.escalate,
    cod_only: input.reason.codOnly,
    required,
    captured,
  };
  if (note.length > 0) {
    failure.note = note;
  }
  const artifactIds = (input.context.artifactIds ?? []).filter((id) => id.trim() !== "");
  if (artifactIds.length > 0) {
    failure.artifact_ids = artifactIds;
  }
  const exceptionEvidence = {
    proof_artifact_count: artifactIds.length,
    artifact_ids: artifactIds,
  };

  const evidence: Record<string, unknown> = {
    reason_code: input.reason.code,
    reason_label: input.reason.label,
    exception_reason: input.reason.code,
    reattempt: input.reason.reattempt,
    escalate: input.reason.escalate,
    captured_at: input.capturedAt,
    exception_notes: note.length > 0 ? note : null,
    exception_evidence: exceptionEvidence,
    failure_note: note.length > 0 ? note : null,
    failure_required: required,
    failure_captured: captured,
    failed_delivery: failure,
  };
  if (artifactIds.length > 0) {
    evidence.failure_artifact_ids = artifactIds;
  }
  return evidence;
}
