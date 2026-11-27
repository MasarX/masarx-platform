import "server-only";

import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import {
  MarketplaceRequestCreateForm,
  MarketplaceRequestCreateState,
  type MarketplaceRequestKindOption,
  type MarketplacePrivatePoolOption,
} from "./marketplace-request-create-form";
import { marketplaceOrganizationLabel, parseJsonValue, stringValue } from "./marketplace-page-utils";
import { formatUiError } from "./utils";

type MarketplaceRequestCreatePageProps = {
  appBasePath: string;
  requestsHref: string;
  testIdPrefix: string;
  actionSource?: string;
  privatePoolLookup?: boolean;
};

function normalizeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRequestKinds(catalog: Record<string, unknown> | null): MarketplaceRequestKindOption[] {
  const items = normalizeArray(catalog?.request_kinds);
  const out: MarketplaceRequestKindOption[] = [];
  items.forEach((item) => {
    const record = normalizeObject(item);
    if (!record) return;
    const kindKey =
      typeof record.kind_key === "string" ? record.kind_key.trim() : "";
    if (!kindKey) return;
    out.push({
      kindKey,
      label:
        (typeof record.label === "string" && record.label.trim()) || kindKey,
      description:
        typeof record.description === "string" ? record.description.trim() : null,
      schema: record.payload_schema ?? null,
      uiConfig: normalizeObject(record.ui_config),
    });
  });
  return out;
}

async function loadPrivatePoolOptions(ui: ReturnType<typeof createUiServerClient>) {
  const list = await ui.listResource("marketplace_participants", {}, 200, 0, null).catch(() => null);
  const options = new Map<string, MarketplacePrivatePoolOption>();
  for (const item of list?.items ?? []) {
    const organizationId = stringValue(item.organization_id);
    const label = marketplaceOrganizationLabel(
      item.display_name, item.organization_name ?? item.name, item.organization_slug,
    );
    if (organizationId && label) options.set(organizationId, { organizationId, label });
  }
  return Array.from(options.values()).sort((left, right) => left.label.localeCompare(right.label));
}

export async function MarketplaceRequestCreatePage({
  appBasePath,
  requestsHref,
  testIdPrefix,
  actionSource = "portal.marketplace.request_create",
  privatePoolLookup = false,
}: MarketplaceRequestCreatePageProps) {
  const ui = createUiServerClient();
  const me = await ui.me().catch(() => null);
  const contextOrgId = me?.org?.id ?? null;
  const [catalog, privatePoolOptions] = await Promise.all([
    ui.marketplaceRequestKindCatalog({
      context: {
        organization_id: contextOrgId,
      },
      includeInactive: false,
    }).catch(() => null),
    privatePoolLookup ? loadPrivatePoolOptions(ui) : undefined,
  ]);

  const requestKinds = normalizeRequestKinds(catalog);
  const defaultKindKey = requestKinds[0]?.kindKey ?? null;

  async function submitRequest(
    _prevState: MarketplaceRequestCreateState,
    formData: FormData,
  ): Promise<MarketplaceRequestCreateState> {
    "use server";
    const uiAction = createUiServerClient();

    const requestKindKey = String(formData.get("request_kind_key") ?? "").trim();
    const title = String(formData.get("title") ?? "").trim();
    const summary = String(formData.get("summary") ?? "").trim();
    const privatePoolCsv = String(formData.get("private_pool_csv") ?? "").trim();
    const publishAfterCreate = String(formData.get("publish_after_create") ?? "").trim() === "1";

    if (!requestKindKey) {
      return { status: "error", message: "Request kind is required." };
    }

    if (!title) {
      return { status: "error", message: "Title is required." };
    }

    const payloadResult = parseJsonValue(
      String(formData.get("payload_json") ?? "{}"),
      {},
    );
    if (!payloadResult.ok) {
      return { status: "error", message: payloadResult.message };
    }

    const payloadObject = normalizeObject(payloadResult.value);
    if (!payloadObject) {
      return { status: "error", message: "Payload must be a JSON object." };
    }

    let privatePool: string[];
    if (privatePoolLookup) {
      if (privatePoolCsv) {
        return { status: "error", message: "Private pool selection must come from the canonical lookup." };
      }
      const selection = parseJsonValue(String(formData.get("private_pool_json") ?? ""), []);
      if (!selection.ok || !Array.isArray(selection.value)
          || selection.value.some((value) => typeof value !== "string" || !value.trim())) {
        return { status: "error", message: "Private pool selection is invalid." };
      }
      privatePool = [...new Set(selection.value.map((value: string) => value.trim()))];
      if (privatePool.length) {
        const visibleIds = new Set((await loadPrivatePoolOptions(uiAction)).map(({ organizationId }) => organizationId));
        if (privatePool.some((id) => !visibleIds.has(id))) {
          return { status: "error", message: "Private pool selection must come from the canonical lookup." };
        }
      }
    } else {
      privatePool = privatePoolCsv.split(",").map((entry) => entry.trim()).filter(Boolean);
    }

    let createResult: Record<string, unknown>;
    try {
      createResult = await uiAction.marketplaceCreateRequest({
        requestKindKey,
        title,
        summary: summary || null,
        requestDetails: payloadObject,
        items: [],
        privatePool,
        metadata: {
          source: actionSource,
          app_base_path: appBasePath,
        },
      });
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, "Request creation failed before reaching the API."),
      };
    }

    const createError = normalizeObject(createResult.error);
    if (createResult.ok === false || createError) {
      return {
        status: "error",
        message:
          (typeof createError?.message === "string" && createError.message.trim()) ||
          (typeof createError?.code === "string" && createError.code.trim()) ||
          "Request creation failed.",
      };
    }

    const requestId =
      typeof createResult.id === "string" ? createResult.id.trim() : "";
    let requestStatus =
      typeof createResult.status === "string" ? createResult.status.trim() : "draft";

    if (publishAfterCreate && requestId && requestStatus === "draft") {
      try {
        const publishResult = await uiAction.marketplacePublishRequest({
          requestId,
          releaseState: null,
        });
        if (typeof publishResult.status === "string" && publishResult.status.trim()) {
          requestStatus = publishResult.status.trim();
        }
      } catch {
        // Request is already created; surface success while keeping it in draft state.
      }
    }

    revalidatePath(requestsHref);
    revalidatePath(`${appBasePath}/marketplace/requests/new`);

    return {
      status: "success",
      message:
        requestStatus === "published"
          ? "Request created and published."
          : "Request created.",
      requestId,
      requestStatus,
    };
  }

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        title="Marketplace request"
        description="Create demand through the request-kind registry and schema-driven payloads."
      />
      <Section
        title="Create request"
        description="Fields, labels, and payload shape come from marketplace request-kind rows."
        collapsible={false}
      >
        <MarketplaceRequestCreateForm
          action={submitRequest}
          requestKinds={requestKinds}
          privatePoolOptions={privatePoolOptions}
          defaultKindKey={defaultKindKey}
          testIdPrefix={testIdPrefix}
        />
      </Section>
    </div>
  );
}
