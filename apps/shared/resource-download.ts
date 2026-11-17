const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RESOURCE_DOWNLOAD_DECISION_CATEGORY = "resource_download_failed";
export const RESOURCE_DOWNLOAD_DECISION_POINT = "api_resource_download";

type DecisionLogRpcResult = {
  data?: unknown;
  error?: unknown | null;
};

export type DecisionLogTarget = {
  rpc: (
    functionName: string,
    args?: Record<string, unknown>
  ) => PromiseLike<DecisionLogRpcResult>;
};

export type ResourceDownloadFailure = {
  id: string;
  error: string;
};

type ResourceDownloadSuccessResult = {
  id: string;
  url: string;
};

type ResourceDownloadErrorResult = {
  id: string;
  error: string;
};

type ResourceDownloadResponse = {
  ok: boolean;
  status?: number;
  url?: string;
  error?: string;
};

type ResourceDownloadRequest = {
  accessToken: string;
  resource: string;
  id: string;
  app: "console" | "portal";
};

const toUuid = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return UUID_V4_PATTERN.test(trimmed) ? trimmed : null;
};

const toDecisionCorrelation = (requestId: string | null | undefined): string | null =>
  toUuid(requestId);

export async function resolveOrganizationIdFromSession(
  supabase: DecisionLogTarget
): Promise<string | null> {
  const { data, error } = await supabase.rpc("current_user_org_id");

  if (error) {
    return null;
  }
  const organizationId =
    typeof data === "string"
      ? toUuid(data)
      : data && typeof data === "object" && "id" in data
        ? toUuid((data as { id?: string | null }).id)
        : null;

  return organizationId;
}

export async function logResourceDownloadPartialFailures(params: {
  supabase: DecisionLogTarget;
  requestId: string;
  app: "console" | "portal";
  resource: string;
  organizationId: string | null;
  failures: ResourceDownloadFailure[];
}): Promise<void> {
  const {
    supabase,
    requestId,
    app,
    resource,
    organizationId,
    failures,
  } = params;

  if (!organizationId || !failures.length) {
    return;
  }

  const correlationId = toDecisionCorrelation(requestId);

  await Promise.allSettled(
    failures.map(async (failure) => {
      const resourceId = toUuid(failure.id);
      if (!resourceId) return;

      const decisionInputs = {
        app,
        resource,
        requestId,
        error: failure.error,
      };

      try {
        await supabase.rpc("log_decision", {
          p_organization_id: organizationId,
          p_decision_category: RESOURCE_DOWNLOAD_DECISION_CATEGORY,
          p_resource_type: resource,
          p_resource_id: resourceId,
          p_decision_point: RESOURCE_DOWNLOAD_DECISION_POINT,
          p_decision_outcome: "failed",
          p_performed_by_system: `${app}:resource-download`,
          ...(correlationId ? { p_correlation_id: correlationId } : {}),
          p_decision_inputs: decisionInputs,
          p_decision_reason: "partial_failure",
        });
      } catch (_error) {
        // best-effort telemetry only
      }
    })
  );
}

export async function downloadResourceBatch(params: {
  supabase: DecisionLogTarget;
  requestId: string;
  app: "console" | "portal";
  resource: string;
  ids: string[];
  accessToken: string;
  requestResourceDownload: (
    request: ResourceDownloadRequest
  ) => Promise<ResourceDownloadResponse>;
}): Promise<{
  resource: string;
  urls: string[];
  errors: ResourceDownloadFailure[];
  total: number;
  status: number;
}> {
  const {
    supabase,
    requestId,
    app,
    resource,
    ids,
    accessToken,
    requestResourceDownload,
  } = params;

  const attempts = await Promise.all(
    ids.map(async (itemId) => {
      try {
        const result = await requestResourceDownload({
          accessToken,
          resource,
          id: itemId,
          app,
        });

        if (!result.ok) {
          return {
            id: itemId,
            error: result.error ?? "Download request failed.",
          } as ResourceDownloadErrorResult;
        }

        if (!result.url) {
          return {
            id: itemId,
            error: "Download request returned no url.",
          } as ResourceDownloadErrorResult;
        }

        return { id: itemId, url: result.url } as ResourceDownloadSuccessResult;
      } catch (error) {
        return {
          id: itemId,
          error:
            error instanceof Error ? error.message : "Download request failed.",
        } as ResourceDownloadErrorResult;
      }
    })
  );

  const urls = attempts.flatMap((item) =>
    "url" in item && item.url ? [item.url] : []
  );
  const errors = attempts
    .filter((item): item is ResourceDownloadErrorResult => "error" in item)
    .map((item) => ({ id: item.id, error: item.error }));

  const organizationId = errors.length
    ? await resolveOrganizationIdFromSession(supabase)
    : null;
  if (errors.length > 0) {
    await logResourceDownloadPartialFailures({
      supabase,
      requestId,
      app,
      resource,
      organizationId,
      failures: errors,
    });
  }

  return {
    resource,
    urls,
    errors,
    total: ids.length,
    status: errors.length > 0 ? 207 : 200,
  };
}
