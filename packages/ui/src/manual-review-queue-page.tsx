import { normalizeReviewDecisionOptions } from "./review-decision-options";
import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { UiMe } from "@masarx/api";
import { revalidatePath } from "next/cache";
import { Badge } from "./badge";
import {
  ManualReviewResolveForm,
  ManualReviewResolveState,
} from "./manual-review-resolve-form";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import { createUiTranslator } from "./i18n";
import { formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type SearchParams = Record<string, string | string[] | undefined>;

type ManualReviewQueuePageProps = {
  searchParams: SearchParams;
  appKey: "console" | "portal";
  appBasePath: string;
  baseHref: string;
  testIdPrefix: string;
  description?: string;
  defaultAssignedToCurrentUser?: boolean;
};

const t = createUiTranslator("ui.manualReview");

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

/**
 * Manual review queue page for workflow approvals.
 */
export async function ManualReviewQueuePage({
  searchParams,
  appKey,
  appBasePath,
  baseHref,
  testIdPrefix,
  description,
  defaultAssignedToCurrentUser,
}: ManualReviewQueuePageProps) {
  const ui = createUiServerClient();
  const outcomeOptions = normalizeReviewDecisionOptions(
    await (ui.listLookupValues?.("manual_review_resolution_outcome") ?? Promise.resolve([])).catch(() => []),
  );
  let me: UiMe | null = null;
  let meError: string | null = null;

  try {
    me = await ui.me();
  } catch (error) {
    meError = formatUiError(error, t("errors.loadUser"));
  }

  const assignedFilter = firstValue(searchParams.assigned_to);
  const canResolve = hasCapability(
    resolveCapabilitySet(me?.capabilities ?? null),
    "manual_review.resolve"
  );
  const resolveTelemetry = me
    ? {
        settingsResolutionId: me.settings_resolution_id ?? null,
        scopeType: me.access_scope?.scope_type ?? null,
        scopeId: me.access_scope?.scope_id ?? null,
        scopeValue: null,
      }
    : null;
  const defaultAssigned =
    !assignedFilter && defaultAssignedToCurrentUser && me?.user?.id
      ? me.user.id
      : null;
  const effectiveSearchParams = defaultAssigned
    ? { ...searchParams, assigned_to: defaultAssigned }
    : searchParams;

  async function resolveTask(
    _prevState: ManualReviewResolveState,
    formData: FormData
  ): Promise<ManualReviewResolveState> {
    "use server";
    const taskId = String(formData.get("task_id") ?? "").trim();
    const outcome = String(formData.get("resolution_outcome") ?? "")
      .trim()
      .toLowerCase();
    const notes = String(formData.get("resolution_notes") ?? "").trim();

    if (!uuidRegex.test(taskId)) {
      return { status: "error", message: t("errors.invalidTaskId") };
    }
    if (outcome !== "approved" && outcome !== "rejected") {
      return { status: "error", message: t("errors.selectOutcome") };
    }

    const submitClient = createUiServerClient();
    try {
      await submitClient.resolveManualReviewTask(
        taskId,
        outcome,
        notes || null
      );
      revalidatePath(baseHref);
      return { status: "success" };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, t("errors.resolveFailed")),
      };
    }
  }

  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="manual_review_tasks"
      searchParams={effectiveSearchParams}
      appBasePath={appBasePath}
      baseHref={baseHref}
      description={
        description ??
        t("description")
      }
      testIdPrefix={testIdPrefix}
      renderDetailFooter={({ detail, detailError, detailId }) => {
        if (!detail || detailError) return null;
        const status = stringValue(detail.status) ?? t("status.unknown");
        const outcome = stringValue(detail.resolution_outcome);
        const resolvedAt = stringValue(detail.resolved_at);
        const isResolved = status === "resolved" || outcome !== null;
        const assignedTo = stringValue(detail.assigned_to);
        const queue = stringValue(detail.queue_assignment);

        let blockedMessage: string | undefined;
        if (!canResolve) {
          blockedMessage = meError
            ? t("blocked.unavailable", { error: meError })
            : t("blocked.noPermission");
        } else if (isResolved) {
          blockedMessage = t("blocked.alreadyResolved");
        }

        return (
          <Section
            title={t("sections.resolveTitle")}
            description={t("sections.resolveDescription")}
            collapsible
            collapseKey="manual-review.resolve"
          >
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-ui-muted">
                <span>{t("labels.status")}</span>
                <Badge tone={isResolved ? "accent" : "neutral"}>{status}</Badge>
                {outcome ? (
                  <Badge tone="accent">{outcome}</Badge>
                ) : null}
                {assignedTo ? (
                  <span className="text-xs">
                    {t("labels.assignedTo", { assignee: assignedTo })}
                  </span>
                ) : null}
                {queue ? (
                  <span className="text-xs">
                    {t("labels.queue", { queue })}
                  </span>
                ) : null}
                {resolvedAt ? (
                  <span className="text-xs">
                    {t("labels.resolvedAt", { time: resolvedAt })}
                  </span>
                ) : null}
              </div>
              <ManualReviewResolveForm
                outcomeOptions={outcomeOptions}
                action={resolveTask}
                taskId={detailId}
                disabled={Boolean(blockedMessage)}
                disabledMessage={blockedMessage}
                testIdPrefix={`${testIdPrefix}-resolve`}
                telemetry={resolveTelemetry}
              />
            </div>
          </Section>
        );
      }}
    />
  );
}
