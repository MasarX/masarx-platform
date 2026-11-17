"use client";

import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";

export type MarketplaceParticipantReviewState = {
  status: "idle" | "error" | "success";
  message?: string;
};

type MarketplaceParticipantReviewFormProps = {
  action: (
    prevState: MarketplaceParticipantReviewState,
    formData: FormData,
  ) => Promise<MarketplaceParticipantReviewState>;
  requestId: string;
  participantTypeKey?: string | null;
  disabled?: boolean;
  disabledMessage?: string;
  defaultInviteRedirectTo?: string | null;
  testIdPrefix: string;
};

const initialState: MarketplaceParticipantReviewState = { status: "idle" };

export function MarketplaceParticipantReviewForm({
  action,
  requestId,
  participantTypeKey,
  disabled,
  disabledMessage,
  defaultInviteRedirectTo,
  testIdPrefix,
}: MarketplaceParticipantReviewFormProps) {
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const [decision, setDecision] = React.useState("");
  const blockedMessage = disabled
    ? disabledMessage ?? "Review is blocked for this request."
    : null;
  const inviteHint =
    participantTypeKey === "freelancer_driver"
      ? "Hosted invite redirect is required for approved freelancer drivers."
      : "Optional for provider-tenant approvals.";

  return (
    <form
      action={formAction}
      className="space-y-4"
      data-testid={`${testIdPrefix}-form`}
    >
      <input type="hidden" name="request_id" value={requestId} />
      <input
        type="hidden"
        name="participant_type_key"
        value={participantTypeKey ?? ""}
      />

      <label className="space-y-2 text-sm text-ui-ink">
        <span id={`${testIdPrefix}-decision-label`} className="text-xs uppercase tracking-wide text-ui-muted">
          Decision
        </span>
        <Select
          name="decision"
          aria-labelledby={`${testIdPrefix}-decision-label`}
          value={decision}
          onChange={(event) => setDecision(event.target.value)}
          disabled={disabled || isPending}
          required
          data-testid={`${testIdPrefix}-decision`}
        >
          <option value="" disabled>
            Select decision
          </option>
          <option value="approved">Approve</option>
          <option value="rejected">Reject</option>
          <option value="request_additional_docs">Request additional documents</option>
        </Select>
      </label>

      {decision === "request_additional_docs" ? (
        <label className="space-y-2 text-sm text-ui-ink">
          <span id={`${testIdPrefix}-documents-label`} className="text-xs uppercase tracking-wide text-ui-muted">
            Requested document types
          </span>
          <Textarea
            name="requested_documents"
            aria-labelledby={`${testIdPrefix}-documents-label`}
            rows={3}
            disabled={disabled || isPending}
            aria-describedby={`${testIdPrefix}-documents-hint`}
            data-testid={`${testIdPrefix}-requested-documents`}
          />
          <span id={`${testIdPrefix}-documents-hint`} className="text-xs text-ui-muted">
            One document type per line, up to 100 characters each. Use the applicant document types, such as license.
          </span>
        </label>
      ) : null}

      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          Reason
        </span>
        <Textarea
          name="reason"
          rows={4}
          placeholder="Review notes, risk signals, and approval context"
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-reason`}
        />
      </label>

      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          Invite redirect
        </span>
        <Input
          name="invite_redirect_to"
          type="url"
          defaultValue={defaultInviteRedirectTo ?? ""}
          placeholder="https://portal.example.com/auth/callback"
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-invite-redirect`}
        />
        <span className="text-xs text-ui-muted">{inviteHint}</span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-submit`}
        >
          {isPending ? "Applying..." : "Apply decision"}
        </Button>
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
          role="alert"
        >
          {state.message ?? "Review failed."}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
          data-testid={`${testIdPrefix}-success`}
          role="status"
        >
          {state.message ?? "Request updated."}
        </div>
      ) : null}
    </form>
  );
}
