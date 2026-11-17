import "server-only";

import Link from "next/link";
import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { normalizeArray, normalizeObject, stringValue } from "./marketplace-page-utils";

type MarketplacePrivatePoolsPageProps = {
  appBasePath: string;
  testIdPrefix: string;
};

export async function MarketplacePrivatePoolsPage({
  appBasePath,
  testIdPrefix,
}: MarketplacePrivatePoolsPageProps) {
  const workspace = await createUiServerClient().marketplacePrivatePoolsWorkspace().catch(() => null);
  const workspaceRecord = normalizeObject(workspace);
  const summary = normalizeObject(workspaceRecord?.summary);
  const memberships = normalizeArray(workspaceRecord?.private_pools);

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        title="Private pools"
        description="Private-pool memberships are projected from canonical marketplace requests and stay visible to eligible tenant and platform users."
      />

      <Section title="Summary" collapsible={false}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Requests with private pools</div>
            <div className="mt-2 text-2xl font-semibold text-ui-ink">
              {stringValue(summary?.request_count) ?? String(summary?.request_count ?? 0)}
            </div>
          </div>
          <div className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Private-pool memberships</div>
            <div className="mt-2 text-2xl font-semibold text-ui-ink">
              {stringValue(summary?.membership_count) ?? String(summary?.membership_count ?? 0)}
            </div>
          </div>
        </div>
      </Section>

      <Section title="Memberships" collapsible={false}>
        {memberships.length === 0 ? (
          <div className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
            No private-pool memberships are visible for the current scope.
          </div>
        ) : (
          <div className="grid gap-4">
            {memberships.map((entry) => {
              const requestId = stringValue(entry.request_id) ?? "";
              const supplierOrganizationId = stringValue(entry.supplier_organization_id) ?? "";
              const requestHref = requestId
                ? `${appBasePath}/marketplace/requests/${requestId}`
                : `${appBasePath}/marketplace/requests`;

              return (
                <div
                  key={`${requestId}-${supplierOrganizationId || "membership"}`}
                  className="grid gap-4 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 lg:grid-cols-[1.1fr,0.9fr]"
                >
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                      {stringValue(entry.status) ? <Badge>{stringValue(entry.status)}</Badge> : null}
                      {stringValue(entry.release_state) ? <Badge>{stringValue(entry.release_state)}</Badge> : null}
                      {stringValue(entry.request_kind_key) ? <Badge>{stringValue(entry.request_kind_key)}</Badge> : null}
                    </div>
                    <div className="text-sm font-medium text-ui-ink">
                      {stringValue(entry.request_title) ?? (requestId || "Marketplace request")}
                    </div>
                    <div className="text-sm text-ui-muted">
                      Requester: {stringValue(entry.requester_organization_name) ?? stringValue(entry.requester_organization_id) ?? "Unknown requester"}
                    </div>
                    <div className="text-sm text-ui-muted">
                      Supplier: {stringValue(entry.supplier_organization_name) ?? (supplierOrganizationId || "Unknown supplier")}
                    </div>
                  </div>
                  <div className="flex items-start justify-start lg:justify-end">
                    <Link
                      className="text-sm font-medium text-ui-ink underline-offset-4 hover:underline"
                      href={requestHref}
                    >
                      Open request workspace
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
