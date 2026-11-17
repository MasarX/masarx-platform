"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { Select } from "./select";
import { Textarea } from "./textarea";
import {
  buildScopeMeta,
  reportUiEvent,
  resolveScopeDigest,
  type UiScopeMetaInput,
} from "./reporting";

export type ManualReviewResolveState = {
  status: "idle" | "error" | "success";
  message?: string;
};

type ManualReviewResolveFormProps = {
  action: (
    prevState: ManualReviewResolveState,
    formData: FormData
  ) => Promise<ManualReviewResolveState>;
  taskId: string;
  disabled?: boolean;
  disabledMessage?: string;
  testIdPrefix: string;
  telemetry?: UiScopeMetaInput | null;
};

const initialState: ManualReviewResolveState = { status: "idle" };

export function ManualReviewResolveForm({
  action,
  taskId,
  disabled,
  disabledMessage,
  testIdPrefix,
  telemetry,
}: ManualReviewResolveFormProps) {
  const t = useTranslations("ui.manualReview.form");
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const blockedMessage = disabled
    ? disabledMessage ?? t("blocked")
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
    ]
  );
  const scopeDigest = React.useMemo(
    () => resolveScopeDigest(telemetry ?? null),
    [telemetry?.settingsResolutionId]
  );
  const lastStatus = React.useRef(state.status);

  React.useEffect(() => {
    if (state.status === "idle" || lastStatus.current === state.status) return;
    lastStatus.current = state.status;
    reportUiEvent({
      type: "ui.manual_review.resolve.result",
      timestamp: new Date().toISOString(),
      name: state.status,
      message: state.status === "error" ? state.message : undefined,
      digest: scopeDigest,
      meta: scopeMeta,
    });
  }, [scopeDigest, scopeMeta, state.message, state.status]);

  return (
    <form
      action={formAction}
      className="space-y-4"
      data-testid={`${testIdPrefix}-form`}
      onSubmit={() => {
        reportUiEvent({
          type: "ui.manual_review.resolve.submit",
          timestamp: new Date().toISOString(),
          name: "submit",
          digest: scopeDigest,
          meta: scopeMeta,
        });
      }}
    >
      <input type="hidden" name="task_id" value={taskId} />
      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          {t("outcome.label")}
        </span>
        <Select
          name="resolution_outcome"
          defaultValue=""
          disabled={disabled || isPending}
          required
          data-testid={`${testIdPrefix}-outcome`}
        >
          <option value="" disabled>
            {t("outcome.placeholder")}
          </option>
          <option value="approved">{t("outcome.approved")}</option>
          <option value="rejected">{t("outcome.rejected")}</option>
        </Select>
      </label>
      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          {t("notes.label")}
        </span>
        <Textarea
          name="resolution_notes"
          rows={4}
          placeholder={t("notes.placeholder")}
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-notes`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={disabled || isPending}
          data-testid={`${testIdPrefix}-submit`}
        >
          {isPending ? t("actions.resolving") : t("actions.resolve")}
        </Button>
        <span className="text-xs text-ui-muted">
          {t("hint")}
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
          {state.message ?? t("errors.generic")}
        </div>
      ) : null}
      {state.status === "success" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
          data-testid={`${testIdPrefix}-success`}
        >
          {t("success")}
        </div>
      ) : null}
    </form>
  );
}
