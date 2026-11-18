"use client";

import * as React from "react";
import { useToast } from "./use-toast";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";
import type { ReviewDecisionOption } from "./review-decision-options";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";
import {
  buildScopeMeta,
  reportUiEvent,
  resolveScopeDigest,
  type UiScopeMetaInput,
} from "./reporting";

export type TenantSignupReviewState = {
  status: "idle" | "error" | "success";
  message?: string;
};

type TenantSignupReviewFormProps = {
  action: (
    prevState: TenantSignupReviewState,
    formData: FormData,
  ) => Promise<TenantSignupReviewState>;
  requestId: string;
  disabled?: boolean;
  disabledMessage?: string;
  defaultInviteRedirectTo?: string | null;
  decisionOptions?: ReviewDecisionOption[];
  testIdPrefix: string;
  telemetry?: UiScopeMetaInput | null;
};

const initialState: TenantSignupReviewState = { status: "idle" };

export function TenantSignupReviewForm({
  action,
  requestId,
  disabled,
  disabledMessage,
  defaultInviteRedirectTo,
  decisionOptions,
  testIdPrefix,
  telemetry,
}: TenantSignupReviewFormProps) {
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const [dirty, setDirty] = React.useState(false);
  const { toast } = useToast();
  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: isPending,
    hasChanges: dirty && state.status !== "success" && !disabled,
    warningMessage: "Leave this review without submitting your changes?",
  });
  const blockedMessage = disabled
    ? disabledMessage ?? "Review is blocked for this request."
    : null;

  const scopeMeta = React.useMemo(
    () =>
      buildScopeMeta({
        settingsResolutionId: telemetry?.settingsResolutionId ?? null,
        scopeType: telemetry?.scopeType ?? null,
        scopeId: telemetry?.scopeId ?? null,
        scopeValue: telemetry?.scopeValue ?? null,
      }),
    [
      telemetry?.settingsResolutionId,
      telemetry?.scopeId,
      telemetry?.scopeType,
      telemetry?.scopeValue,
    ],
  );
  const scopeDigest = React.useMemo(
    () => resolveScopeDigest(telemetry ?? null),
    [telemetry?.settingsResolutionId],
  );
  const lastStatus = React.useRef(state.status);

  React.useEffect(() => {
    if (state.status === "idle" || lastStatus.current === state.status) return;
    lastStatus.current = state.status;
    reportUiEvent({
      type: "ui.tenant_signup.review.result",
      timestamp: new Date().toISOString(),
      name: state.status,
      message: state.status === "error" ? state.message : undefined,
      digest: scopeDigest,
      meta: scopeMeta,
    });
    if (state.status === "success") toast({ tone: "success", title: "Review submitted" });
    if (state.status === "error") toast({ tone: "error", title: "Review failed" });
  }, [scopeDigest, scopeMeta, state.message, state.status, toast]);

  return (
    <form
      onChange={() => setDirty(true)}
      action={formAction}
      className="space-y-4"
      data-testid={`${testIdPrefix}-form`}
      onSubmit={() => {
        reportUiEvent({
          type: "ui.tenant_signup.review.submit",
          timestamp: new Date().toISOString(),
          name: "submit",
          digest: scopeDigest,
          meta: scopeMeta,
        });
      }}
    >
      <input type="hidden" name="request_id" value={requestId} />
      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs tracking-wide text-ui-muted">
          Decision
        </span>
        <Select
          name="decision"
          defaultValue=""
          disabled={disabled || isPending}
          required
          data-testid={`${testIdPrefix}-decision`}
        >
          <option value="" disabled>
            Select decision
          </option>
          {decisionOptions?.length ? decisionOptions.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          )) : (
            <>
              <option value="approved">Approve</option>
              <option value="rejected">Reject</option>
            </>
          )}
        </Select>
      </label>

      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs tracking-wide text-ui-muted">
          Reason
        </span>
        <Textarea
          name="reason"
          rows={4}
          placeholder="Decision notes and context"
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-reason`}
        />
      </label>

      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs tracking-wide text-ui-muted">
          Invite redirect (required for approval)
        </span>
        <Input
          name="invite_redirect_to"
          type="url"
          defaultValue={defaultInviteRedirectTo ?? ""}
          placeholder="https://app.example.com/auth/callback"
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-invite-redirect`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-submit`}
        >
          {isPending ? "Applying..." : "Apply decision"}
        </Button>
        <span className="text-xs text-ui-muted">
          Approval creates and activates the organization account.
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
          {state.message ?? "Request updated."}
        </div>
      ) : null}
    </form>
  );
}
