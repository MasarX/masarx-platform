"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createUiClient } from "@masarx/api";
import { Button } from "./button";
import { Textarea } from "./textarea";
import { formatUiError } from "./utils";

export type CustomerShipmentChangeReviewState = {
  status: "idle" | "error" | "success";
  message?: string;
};

type ReviewPayload = Record<string, unknown> & {
  ok?: boolean;
  outcome?: unknown;
  error?: unknown;
  current_snapshot?: unknown;
  support_case_id?: unknown;
};

type CustomerShipmentChangeReviewFormProps = {
  supportCaseId: string;
  disabled?: boolean;
  disabledMessage?: string;
  testIdPrefix: string;
};

const initialState: CustomerShipmentChangeReviewState = { status: "idle" };

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildReviewSuccessMessage(
  payload: ReviewPayload | null,
  outcome: string,
) {
  const baseMessage =
    outcome === "applied"
      ? "Shipment change approved and applied."
      : outcome === "rejected"
        ? "Shipment change rejected."
        : "Shipment change updated.";
  const currentSnapshot = recordValue(payload?.current_snapshot);
  const trackingNumber = stringValue(currentSnapshot?.tracking_number);
  const shipmentStatus = stringValue(currentSnapshot?.shipment_status);
  const promisedDeliveryDate = stringValue(currentSnapshot?.promised_delivery_date);
  const supportCaseId = stringValue(payload?.support_case_id);
  const readbackFacts = [
    trackingNumber ? `tracking ${trackingNumber}` : null,
    shipmentStatus ? `status ${shipmentStatus}` : null,
    promisedDeliveryDate ? `delivery ${promisedDeliveryDate}` : null,
    supportCaseId ? `case ${supportCaseId}` : null,
  ].filter(Boolean);

  if (readbackFacts.length < 1) return baseMessage;
  return `${baseMessage} Backend readback: ${readbackFacts.join("; ")}.`;
}

export function CustomerShipmentChangeReviewForm({
  supportCaseId,
  disabled,
  disabledMessage,
  testIdPrefix,
}: CustomerShipmentChangeReviewFormProps) {
  const router = useRouter();
  const ui = React.useMemo(() => createUiClient(), []);
  const [state, setState] =
    React.useState<CustomerShipmentChangeReviewState>(initialState);
  const [isPending, setIsPending] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  const [resolvedLocally, setResolvedLocally] = React.useState(false);
  const pendingDecisionRef = React.useRef<string | null>(null);
  const blockedMessage =
    resolvedLocally
      ? "This shipment change is already resolved."
        : disabled
          ? disabledMessage ?? "Review is blocked for this change request."
          : null;

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!hydrated || disabled || resolvedLocally || isPending) return;

      const form = event.currentTarget;
      const submitter =
        (event.nativeEvent as SubmitEvent | undefined)?.submitter ?? null;
      const formData = new FormData(
        form,
        submitter instanceof HTMLElement ? submitter : undefined,
      );
      const submitterDecision =
        submitter instanceof HTMLButtonElement && submitter.name === "decision"
          ? submitter.value
          : null;
      const decision = String(
        formData.get("decision") ??
          submitterDecision ??
          pendingDecisionRef.current ??
          "",
      )
        .trim()
        .toLowerCase();
      const reason = String(formData.get("reason") ?? "").trim();

      if (decision !== "approved" && decision !== "rejected") {
        setState({
          status: "error",
          message: "Choose a valid review decision.",
        });
        return;
      }

      setState(initialState);
      setIsPending(true);

      try {
        const data = await ui.rpc<ReviewPayload>(
          "public_tracking_review_request_v1",
          {
            p_input: {
              support_case_id: supportCaseId,
              decision,
              reason: reason || null,
            },
          },
        );

        const payload =
          data && typeof data === "object" && !Array.isArray(data)
            ? (data as ReviewPayload)
            : null;
        const responseErrorValue = payload?.error;
        const responseError =
          responseErrorValue &&
          typeof responseErrorValue === "object" &&
          !Array.isArray(responseErrorValue)
            ? (responseErrorValue as Record<string, unknown>)
            : null;

        const outcome = stringValue(payload?.outcome);
        const responseCaseId = stringValue(payload?.support_case_id);
        const currentSnapshot = recordValue(payload?.current_snapshot);
        const expectedOutcome = decision === "approved" ? "applied" : "rejected";

        if (
          payload?.ok !== true ||
          (responseErrorValue !== null && responseErrorValue !== undefined) ||
          responseCaseId !== supportCaseId ||
          outcome !== expectedOutcome ||
          !currentSnapshot ||
          Object.keys(currentSnapshot).length < 1
        ) {
          setState({
            status: "error",
            message:
              (typeof responseError?.message === "string" &&
                responseError.message.trim()) ||
              (typeof responseError?.code === "string" &&
                responseError.code.trim()) ||
              "Customer shipment change review did not return a matching canonical readback.",
          });
          return;
        }

        setResolvedLocally(true);
        setState({
          status: "success",
          message: buildReviewSuccessMessage(payload, outcome),
        });
        router.refresh();
      } catch (error) {
        setState({
          status: "error",
          message: formatUiError(
            error,
            "Customer shipment change review failed.",
          ),
        });
      } finally {
        pendingDecisionRef.current = null;
        setIsPending(false);
      }
    },
    [
      disabled,
      hydrated,
      isPending,
      resolvedLocally,
      supportCaseId,
      router,
      ui,
    ],
  );

  React.useEffect(() => {
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    setState(initialState);
    setResolvedLocally(false);
  }, [supportCaseId]);

  return (
    <form
      className="space-y-4"
      data-testid={`${testIdPrefix}-form`}
      onSubmit={handleSubmit}
    >
      <input type="hidden" name="support_case_id" value={supportCaseId} />

      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          Review reason
        </span>
        <Textarea
          name="reason"
          rows={4}
          placeholder="Decision notes and context"
          disabled={!hydrated || Boolean(blockedMessage) || isPending}
          data-testid={`${testIdPrefix}-reason`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          name="decision"
          value="approved"
          disabled={!hydrated || Boolean(blockedMessage) || isPending}
          onClick={() => {
            pendingDecisionRef.current = "approved";
          }}
          data-testid={`${testIdPrefix}-approve`}
        >
          {isPending ? "Applying..." : "Approve and apply"}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="rejected"
          variant="soft"
          disabled={!hydrated || Boolean(blockedMessage) || isPending}
          onClick={() => {
            pendingDecisionRef.current = "rejected";
          }}
          data-testid={`${testIdPrefix}-reject`}
        >
          Reject
        </Button>
        <span className="text-xs text-ui-muted">
          Approvals use the same canonical apply engine as auto-apply.
        </span>
      </div>

      {blockedMessage ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={`${testIdPrefix}-blocked`}
        >
          {blockedMessage}
        </div>
      ) : null}

      {state.status === "error" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          role="alert"
          aria-atomic="true"
          data-testid={`${testIdPrefix}-error`}
        >
          {state.message ?? "Review failed."}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={`${testIdPrefix}-success`}
        >
          {state.message ?? "Shipment change updated."}
        </div>
      ) : null}
    </form>
  );
}
