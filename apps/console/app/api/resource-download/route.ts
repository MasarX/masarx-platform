import { NextRequest } from "next/server";
import { getVerifiedAccessToken, validateTrustedBrowserRequest } from "@masarx/auth";
import { requestUiResourceDownload } from "@masarx/api";
import {
  getRequestIdFromHeaders,
  jsonResponseWithRequestId,
  redirectWithRequestId,
} from "../../../../shared/request-meta";
import {
  downloadResourceBatch,
  MAX_RESOURCE_DOWNLOAD_BATCH,
} from "../../../../shared/resource-download";

export async function GET(request: NextRequest) {
  const requestId = getRequestIdFromHeaders(request);
  const resource = request.nextUrl.searchParams.get("resource");
  const shipmentId = request.nextUrl.searchParams.get("shipment_id");
  const idParam = request.nextUrl.searchParams.get("id");
  const idsParam = request.nextUrl.searchParams.get("ids");
  const ids = idsParam
    ? idsParam
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const id = idParam ?? (ids.length === 1 ? ids[0] : null);
  if (!resource || (!id && ids.length === 0)) {
    return jsonResponseWithRequestId(
      { error: "Missing resource or id." },
      400,
      requestId
    );
  }

  if (ids.length > MAX_RESOURCE_DOWNLOAD_BATCH) {
    return jsonResponseWithRequestId(
      { error: `Select at most ${MAX_RESOURCE_DOWNLOAD_BATCH} resources per download.` },
      400,
      requestId
    );
  }

  const trustedRequest = validateTrustedBrowserRequest(request);
  if (!trustedRequest.ok) {
    return jsonResponseWithRequestId(
      { error: trustedRequest.message, code: trustedRequest.code },
      trustedRequest.status,
      requestId
    );
  }

  const { client: supabase, accessToken: token, error } =
    await getVerifiedAccessToken({ allowCookieSet: false });
  if (error || !token) {
    return jsonResponseWithRequestId(
      { error: "Unauthorized." },
      401,
      requestId
    );
  }

  const resolvedIds = ids.length > 0 ? ids : id ? [id] : [];
  if (idsParam !== null || resolvedIds.length > 1) {
    const payload = await downloadResourceBatch({
      supabase,
      requestId,
      app: "console",
      resource,
      ids: resolvedIds,
      shipmentId,
      accessToken: token,
      ...(shipmentId ? { extraParams: { shipment_id: shipmentId } } : {}),
      requestResourceDownload: requestUiResourceDownload,
    });

    return jsonResponseWithRequestId(payload, payload.status, requestId);
  }

  const [firstId] = resolvedIds;
  if (!firstId) {
    return jsonResponseWithRequestId(
      { error: "Missing id." },
      400,
      requestId
    );
  }
  let result;
  try {
    result = await requestUiResourceDownload({
      accessToken: token,
      resource,
      id: firstId,
      app: "console",
      ...(shipmentId ? { extraParams: { shipment_id: shipmentId } } : {}),
    });
  } catch (error) {
    return jsonResponseWithRequestId(
      {
        error:
          error instanceof Error ? error.message : "Download request failed.",
      },
      500,
      requestId
    );
  }
  if (!result.ok) {
    return jsonResponseWithRequestId(
      { error: result.error },
      result.status,
      requestId
    );
  }
  if (!result.url) {
    return jsonResponseWithRequestId(
      {
        error: "Download request returned no url.",
      },
      500,
      requestId
    );
  }

  return redirectWithRequestId(result.url, requestId, 302);
}
