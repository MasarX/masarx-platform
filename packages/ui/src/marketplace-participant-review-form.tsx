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
        <span className="text-xs uppercase tracking-wide text-ui-muted">
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
          <option value="approved">Approve</option>
          <option value="rejected">Reject</option>
        </Select>
      </label>

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
