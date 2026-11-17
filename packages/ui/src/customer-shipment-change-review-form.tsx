"use client";

import * as React from "react";
import { createUiClient } from "@masarx/api";
import { useRouter } from "next/navigation";
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
};

type CustomerShipmentChangeReviewFormProps = {
  supportCaseId: string;
  disabled?: boolean;
  disabledMessage?: string;
  testIdPrefix: string;
};

const initialState: CustomerShipmentChangeReviewState = { status: "idle" };

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
  const [isRefreshing, startRefreshTransition] = React.useTransition();
  const [resolvedLocally, setResolvedLocally] = React.useState(false);
  const refreshTimerRef = React.useRef<number | null>(null);
  const hardReloadTimerRef = React.useRef<number | null>(null);
  const blockedMessage =
    resolvedLocally
      ? "This shipment change is already resolved."
      : disabled
        ? disabledMessage ?? "Review is blocked for this change request."
        : null;

  const clearRefreshTimers = React.useCallback(() => {
    if (typeof window === "undefined") return;
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (hardReloadTimerRef.current !== null) {
      window.clearTimeout(hardReloadTimerRef.current);
      hardReloadTimerRef.current = null;
    }
  }, []);

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (disabled || resolvedLocally || isPending) return;

      const form = event.currentTarget;
      const submitter =
        (event.nativeEvent as SubmitEvent | undefined)?.submitter ?? null;
      const formData = new FormData(
        form,
        submitter instanceof HTMLElement ? submitter : undefined,
      );
      const decision = String(formData.get("decision") ?? "")
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
        const { data, error } = await ui.rpc<ReviewPayload>(
          "public_tracking_review_request_v1",
          {
            p_input: {
              support_case_id: supportCaseId,
              decision,
              reason: reason || null,
            },
          },
        );

        if (error) {
          setState({
            status: "error",
            message: formatUiError(
              error,
              "Customer shipment change review failed.",
            ),
          });
          return;
        }

        const payload =
          data && typeof data === "object" && !Array.isArray(data)
            ? (data as ReviewPayload)
            : null;
        const responseError =
          payload?.error &&
          typeof payload.error === "object" &&
          !Array.isArray(payload.error)
            ? (payload.error as Record<string, unknown>)
            : null;

        if (payload?.ok === false || responseError) {
          setState({
            status: "error",
            message:
              (typeof responseError?.message === "string" &&
                responseError.message.trim()) ||
              (typeof responseError?.code === "string" &&
                responseError.code.trim()) ||
              "Customer shipment change review failed.",
          });
          return;
        }

        const outcome =
          typeof payload?.outcome === "string" && payload.outcome.trim()
            ? payload.outcome.trim()
            : decision === "approved"
              ? "applied"
              : decision === "rejected"
                ? "rejected"
                : "";
        setResolvedLocally(true);
        setState({
          status: "success",
          message:
            outcome === "applied"
              ? "Shipment change approved and applied."
              : outcome === "rejected"
                ? "Shipment change rejected."
                : "Shipment change updated.",
        });
        clearRefreshTimers();
        if (typeof window !== "undefined") {
          refreshTimerRef.current = window.setTimeout(() => {
            startRefreshTransition(() => {
              router.refresh();
            });
          }, 50);
          hardReloadTimerRef.current = window.setTimeout(() => {
            window.location.reload();
          }, 3000);
        }
      } catch (error) {
        setState({
          status: "error",
          message: formatUiError(
            error,
            "Customer shipment change review failed.",
          ),
        });
      } finally {
        setIsPending(false);
      }
    },
    [
      clearRefreshTimers,
      disabled,
      isPending,
      resolvedLocally,
      router,
      supportCaseId,
      ui,
    ],
  );

  React.useEffect(() => {
    clearRefreshTimers();
    setState(initialState);
    setResolvedLocally(false);
  }, [clearRefreshTimers, supportCaseId]);

  React.useEffect(() => () => clearRefreshTimers(), [clearRefreshTimers]);

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
          disabled={Boolean(blockedMessage) || isPending || isRefreshing}
          data-testid={`${testIdPrefix}-reason`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          name="decision"
          value="approved"
          disabled={Boolean(blockedMessage) || isPending || isRefreshing}
          data-testid={`${testIdPrefix}-approve`}
        >
          {isPending || isRefreshing ? "Applying..." : "Approve and apply"}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="rejected"
          variant="soft"
          disabled={Boolean(blockedMessage) || isPending || isRefreshing}
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
          data-testid={`${testIdPrefix}-blocked`}
        >
          {blockedMessage}
        </div>
      ) : null}

      {state.status === "error" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${testIdPrefix}-error`}
        >
          {state.message ?? "Review failed."}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
          data-testid={`${testIdPrefix}-success`}
        >
          {state.message ?? "Shipment change updated."}
        </div>
      ) : null}
    </form>
  );
}
