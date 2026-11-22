import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { resolveLookupOptionLabel } from "./lookup-friendly-label";
import { ContextNotice } from "./context-notice";
import { EmptyState } from "./empty-state";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import {
  formatDateTime,
  normalizeObject,
  stringValue,
} from "./pickup-operations-utils";
import {
  PickupPageNavigation,
  formatStatusBadge,
  loadPickupFailureRows,
  pickupErrorMessage,
  recordValue,
  resolvePickupScopeFilters,
  renderFieldPairs,
} from "./pickup-page-shared";
import { buildTestId } from "./test-ids";

type SearchParams = Record<string, string | string[] | undefined>;
type PickupFailureRow = Record<string, unknown>;
type PickupUserContext = {
  org?: { id?: string | null } | null;
  access_scope?: {
    scope_type?: string | null;
    scope_id?: string | null;
  } | null;
  locale?: string | null;
  timezone?: string | null;
};

export async function PickupFailuresPage({
  appBasePath,
  searchParams,
  testIdPrefix,
}: {
  appBasePath: string;
  searchParams: SearchParams;
  testIdPrefix: string;
}) {
  const ui = createUiServerClient();
  const meResult = await ui.me().catch(() => null);
  const me = normalizeObject(meResult) as PickupUserContext | null;
  const scopeFilters = resolvePickupScopeFilters(me);
  const failuresResult = await loadPickupFailureRows<PickupFailureRow>({
    clientId:
      scopeFilters.find(([key]) => key === "client_id")?.[1] ?? null,
    senderId:
      scopeFilters.find(([key]) => key === "sender_id")?.[1] ?? null,
    status: searchParams.status,
  });
  const activePath = `${appBasePath}/operations/pickups/failures`;

  if (failuresResult.error) {
    return (
      <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
        <PageHeader
          eyebrow="Operations / Pickup"
          title="Pickup failures"
          description="Review pickup failures and follow-up tasks for reschedule or escalation."
          actions={
            <div className="flex flex-wrap gap-2">
              <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
            </div>
          }
        />
        <ContextNotice
          title="Pickup failures unavailable"
          action="Check the pickup failure view and database read permissions."
          detail={pickupErrorMessage(failuresResult.error, "Unable to load pickup failures.")}
          testId={buildTestId(testIdPrefix, "error")}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        eyebrow="Operations / Pickup"
        title="Pickup failures"
        description="Monitor the pickup failure ledger, the latest failure reason, and any generated reschedule or escalation follow-up tasks."
        actions={
          <div className="flex flex-wrap gap-2">
            <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
          </div>
        }
      />

      <Section
        title="Pickup failure ledger"
        description={`Loaded from pickup_failures. ${failuresResult.rows.length} row(s) on this page.`}
        collapsible={false}
      >
        {failuresResult.rows.length === 0 ? (
          <EmptyState
            variant="card"
            title="No pickup failures yet"
            description="Failures will appear here once a pickup stops with pickup_failed status or follow-up tasks are generated."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {failuresResult.rows.map((row) => {
              const shipmentId = stringValue(row.shipment_id) ?? "shipment";
              const tasks = Array.isArray(row.followup_tasks) ? row.followup_tasks : [];
              const failureActionData = recordValue(row.failure_action_data);
              const pickupRequest = recordValue(row.pickup_request);
              return (
                <article
                  key={shipmentId}
                  className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {formatStatusBadge(stringValue(row.status))}
                    {stringValue(row.failure_reason) || stringValue(row.failure_reason_label) ? (
                      <Badge tone="danger">{resolveLookupOptionLabel(row.failure_reason, row.failure_reason_label)}</Badge>
                    ) : null}
                    {tasks.length > 0 ? (
                      <Badge tone="warning">{`${tasks.length} follow-up task${tasks.length === 1 ? "" : "s"}`}</Badge>
                    ) : null}
                  </div>
                  <div className="mt-3 text-sm font-medium text-ui-ink">
                    {stringValue(row.tracking_number) ?? shipmentId}
                  </div>
                  <div className="mt-2 text-sm text-ui-muted">
                    {formatDateTime(row.failed_at, me?.locale, me?.timezone) ?? "No failure timestamp."}
                  </div>
                  <div className="mt-3 space-y-3">
                    {renderFieldPairs([
                      ["Organization", stringValue(row.organization_label) ?? stringValue(row.organization_id)],
                      ["Client", stringValue(row.client_label) ?? stringValue(row.client_id)],
                      ["Sender", stringValue(row.sender_label) ?? stringValue(row.sender_id)],
                    ])}
                    {tasks.length > 0 ? (
                      <div className="grid gap-2 md:grid-cols-2">
                        {tasks.map((task) => {
                          const taskRecord = recordValue(task);
                          const taskId = stringValue(taskRecord?.task_id) ?? "task";
                          return (
                            <div
                              key={taskId}
                              className="rounded-xl border border-ui-border bg-ui-surface/50 p-3 text-sm text-ui-muted"
                            >
                              <div className="font-medium text-ui-ink">
                                {stringValue(taskRecord?.task_type_key) ?? "task"}
                              </div>
                              <div>{stringValue(taskRecord?.status) ?? "unknown"}</div>
                              <div className="text-xs">{stringValue(taskRecord?.queue_key) ?? ""}</div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {failureActionData ? (
                      <pre className="overflow-x-auto rounded-xl border border-ui-border bg-ui-surface/70 p-3 text-xs text-ui-muted">
                        {JSON.stringify(failureActionData, null, 2)}
                      </pre>
                    ) : null}
                    {pickupRequest ? (
                      <pre className="overflow-x-auto rounded-xl border border-ui-border bg-ui-surface/70 p-3 text-xs text-ui-muted">
                        {JSON.stringify(pickupRequest, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>
    </PageContainer>
  );
}
